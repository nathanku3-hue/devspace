import { randomBytes } from "node:crypto";
import {
  RetainedExternalConversationRuns,
  type ExternalConversationRunStatus,
} from "./web-connector-proof.js";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_RETENTION_MS = 10 * 60_000;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const SLICE = "REVIEW-RETURN-2" as const;
const ROLE = "PRODUCT" as const;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_FINDINGS = 20;
const MAX_FINDING_CLAIM_CHARS = 2_000;
const MAX_FINDING_EVIDENCE_REF_CHARS = 512;

export type ReviewResultVerdict = "pass" | "fail" | "abstain";
export type ReviewFindingSeverity = "blocking" | "material" | "advisory";

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  claim: string;
  evidenceRef: string;
}

export interface ReviewStructuredResult {
  reviewId: string;
  role: "PRODUCT";
  result: ReviewResultVerdict;
  summary: string;
  findings: ReviewFinding[];
  reviewedAt: string;
}

export interface ReviewStartInput {
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
}

export interface ReviewStartAcknowledgement extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  reviewId: string;
  role: "PRODUCT";
  status: "pending";
  startedAt: string;
  expiresAt: string;
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
  assistantOutputCaptured: false;
}

export interface ReviewSubmitAcknowledgement extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  reviewAccepted: true;
  reviewId: string;
  timestamp: string;
}

export interface ReviewReturnResult extends ReviewStructuredResult {
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
  conversationIdentitySha256: string;
  callbackTimestamp: string;
  assistantOutputCaptured: false;
}

interface ReviewStatusBase extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  reviewId: string;
  role: "PRODUCT";
  status: ExternalConversationRunStatus;
  startedAt: string;
  expiresAt: string;
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
  assistantOutputCaptured: false;
}

export interface ReviewPendingStatus extends ReviewStatusBase {
  status: "pending";
}

export interface ReviewSucceededStatus extends ReviewStatusBase, ReviewReturnResult {
  status: "succeeded";
}

export interface ReviewFailedStatus extends ReviewStatusBase {
  status: "failed";
  failureCode: string;
}

export interface ReviewExpiredStatus extends ReviewStatusBase {
  status: "expired";
}

export type ReviewStatusAcknowledgement =
  | ReviewPendingStatus
  | ReviewSucceededStatus
  | ReviewFailedStatus
  | ReviewExpiredStatus;

export interface ReviewReturnOptions {
  reviewIdFactory?: () => string;
  now?: () => Date;
  timeoutMs?: number;
  retentionMs?: number;
}

interface FrozenReviewBindings {
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
}

interface PendingSubmission {
  structured: ReviewStructuredResult;
}

export class ReviewReturnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewReturnError";
  }
}

export class ReviewReturnController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation">;
  readonly #reviewIdFactory: () => string;
  readonly #now: () => Date;
  readonly #runs: RetainedExternalConversationRuns<ReviewReturnResult>;
  readonly #bindingsByReviewId = new Map<string, FrozenReviewBindings>();
  readonly #submissionByReviewId = new Map<string, PendingSubmission>();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation">,
    options: ReviewReturnOptions = {},
  ) {
    this.#browser = browser;
    this.#reviewIdFactory =
      options.reviewIdFactory ?? (() => randomBytes(32).toString("hex"));
    this.#now = options.now ?? (() => new Date());

    this.#runs = new RetainedExternalConversationRuns<ReviewReturnResult>({
      label: SLICE,
      timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      retentionMs: options.retentionMs ?? DEFAULT_RUN_RETENTION_MS,
      errorFactory: (message) => new ReviewReturnError(message),
      buildResult: (run) => {
        const bindings = this.#bindingsByReviewId.get(run.id);
        const submission = this.#submissionByReviewId.get(run.id);
        if (!bindings || !submission) {
          throw new ReviewReturnError(
            "REVIEW-RETURN-2 internal state missing for completed review",
          );
        }
        return {
          ...submission.structured,
          candidateManifestDigest: bindings.candidateManifestDigest,
          evidenceManifestDigest: bindings.evidenceManifestDigest,
          rolePolicyDigest: bindings.rolePolicyDigest,
          conversationIdentitySha256: run.launchIdentity as string,
          callbackTimestamp: run.callbackReceivedAt as string,
          assistantOutputCaptured: false,
        };
      },
      onTerminal: (run) => {
        if (run.status !== "succeeded") {
          this.#submissionByReviewId.delete(run.id);
        }
      },
    });
  }

  startReview(input: ReviewStartInput): ReviewStartAcknowledgement {
    const candidateManifestDigest = assertHex64(
      input.candidateManifestDigest,
      "candidateManifestDigest",
    );
    const evidenceManifestDigest = assertHex64(
      input.evidenceManifestDigest,
      "evidenceManifestDigest",
    );
    const rolePolicyDigest = assertHex64(input.rolePolicyDigest, "rolePolicyDigest");
    const reviewId = this.#reviewIdFactory();
    assertHex64(reviewId, "reviewId");

    if (this.#runs.get(reviewId)) {
      throw new ReviewReturnError("REVIEW-RETURN-2 generated a duplicate review ID");
    }

    const run = this.#runs.start(reviewId, this.#now());
    this.#bindingsByReviewId.set(reviewId, {
      candidateManifestDigest,
      evidenceManifestDigest,
      rolePolicyDigest,
    });

    void Promise.resolve()
      .then(() =>
        this.#browser.launchWebConversation(
          buildReviewReturnPrompt({
            reviewId,
            candidateManifestDigest,
            evidenceManifestDigest,
            rolePolicyDigest,
          }),
        ),
      )
      .then(
        (launch) => {
          this.#runs.recordLaunchIdentity(reviewId, launch.conversationIdentitySha256);
        },
        () => {
          this.#runs.fail(reviewId, "launch_failed");
        },
      );

    return {
      slice: SLICE,
      reviewId,
      role: ROLE,
      status: "pending",
      startedAt: run.startedAt,
      expiresAt: run.expiresAt,
      candidateManifestDigest,
      evidenceManifestDigest,
      rolePolicyDigest,
      assistantOutputCaptured: false,
    };
  }

  submitReview(payload: ReviewStructuredResult): ReviewSubmitAcknowledgement {
    const structured = normalizeStructuredResult(payload);
    const bindings = this.#bindingsByReviewId.get(structured.reviewId);
    const run = this.#runs.get(structured.reviewId);
    if (!bindings || !run || run.status !== "pending") {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 review is unknown, expired, or already completed",
      );
    }
    if (this.#submissionByReviewId.has(structured.reviewId)) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 review callback already consumed",
      );
    }

    const timestamp = this.#now().toISOString();
    const retained: ReviewStructuredResult = {
      ...structured,
      reviewedAt: structured.reviewedAt,
    };
    this.#submissionByReviewId.set(structured.reviewId, { structured: retained });
    this.#runs.recordCallback(structured.reviewId, timestamp);

    return {
      slice: SLICE,
      reviewAccepted: true,
      reviewId: structured.reviewId,
      timestamp,
    };
  }

  getReviewStatus(reviewId: string): ReviewStatusAcknowledgement {
    assertHex64(reviewId, "reviewId");
    const run = this.#runs.get(reviewId);
    const bindings = this.#bindingsByReviewId.get(reviewId);
    if (!run || !bindings) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 review is unknown or no longer retained",
      );
    }

    const base = {
      slice: SLICE,
      reviewId,
      role: ROLE,
      status: run.status,
      startedAt: run.startedAt,
      expiresAt: run.expiresAt,
      candidateManifestDigest: bindings.candidateManifestDigest,
      evidenceManifestDigest: bindings.evidenceManifestDigest,
      rolePolicyDigest: bindings.rolePolicyDigest,
      assistantOutputCaptured: false as const,
    };

    switch (run.status) {
      case "pending":
        return { ...base, status: "pending" };
      case "succeeded":
        return {
          ...base,
          status: "succeeded",
          ...(run.result as ReviewReturnResult),
        };
      case "failed":
        return {
          ...base,
          status: "failed",
          failureCode: run.failureCode ?? "unknown_failure",
        };
      case "expired":
        return { ...base, status: "expired" };
    }
  }

  close(): void {
    this.#bindingsByReviewId.clear();
    this.#submissionByReviewId.clear();
    this.#runs.close();
  }
}

export function buildReviewReturnPrompt(input: {
  reviewId: string;
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
}): string {
  assertHex64(input.reviewId, "reviewId");
  assertHex64(input.candidateManifestDigest, "candidateManifestDigest");
  assertHex64(input.evidenceManifestDigest, "evidenceManifestDigest");
  assertHex64(input.rolePolicyDigest, "rolePolicyDigest");
  return [
    "REVIEW-RETURN-2 PRODUCT review packet.",
    "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
    "You are the PRODUCT reviewer for this candidate.",
    `reviewId: ${input.reviewId}`,
    `candidateManifestDigest: ${input.candidateManifestDigest}`,
    `evidenceManifestDigest: ${input.evidenceManifestDigest}`,
    `rolePolicyDigest: ${input.rolePolicyDigest}`,
    "Invoke the bounded `review_submit` tool exactly once with this exact structured payload:",
    '- reviewId matching the value above',
    '- role "PRODUCT"',
    "- result one of pass | fail | abstain",
    "- summary bounded text",
    "- findings array of {severity: blocking|material|advisory, claim, evidenceRef}",
    "- reviewedAt ISO-8601 timestamp",
    "Do not invoke any other connector tool.",
    "Do not include previous reviewer output.",
    "Do not capture or return assistant transcript text.",
    "After submit succeeds, stop. Do not ask the user a question.",
  ].join("\n");
}

function normalizeStructuredResult(payload: ReviewStructuredResult): ReviewStructuredResult {
  if (!payload || typeof payload !== "object") {
    throw new ReviewReturnError("REVIEW-RETURN-2 callback payload must be an object");
  }
  const reviewId = assertHex64(payload.reviewId, "reviewId");
  if (payload.role !== ROLE) {
    throw new ReviewReturnError('REVIEW-RETURN-2 role must be "PRODUCT"');
  }
  if (payload.result !== "pass" && payload.result !== "fail" && payload.result !== "abstain") {
    throw new ReviewReturnError(
      'REVIEW-RETURN-2 result must be "pass", "fail", or "abstain"',
    );
  }
  if (typeof payload.summary !== "string") {
    throw new ReviewReturnError("REVIEW-RETURN-2 summary must be a string");
  }
  if (payload.summary.length === 0 || payload.summary.length > MAX_SUMMARY_CHARS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 summary must be 1..${MAX_SUMMARY_CHARS} characters`,
    );
  }
  if (payload.summary.includes("\r")) {
    throw new ReviewReturnError("REVIEW-RETURN-2 summary rejects carriage returns");
  }
  if (!Array.isArray(payload.findings)) {
    throw new ReviewReturnError("REVIEW-RETURN-2 findings must be an array");
  }
  if (payload.findings.length > MAX_FINDINGS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings must contain at most ${MAX_FINDINGS} items`,
    );
  }
  const findings = payload.findings.map((finding, index) =>
    normalizeFinding(finding, index),
  );
  const reviewedAt = assertIso8601(payload.reviewedAt, "reviewedAt");
  return {
    reviewId,
    role: ROLE,
    result: payload.result,
    summary: payload.summary,
    findings,
    reviewedAt,
  };
}

function normalizeFinding(finding: ReviewFinding, index: number): ReviewFinding {
  if (!finding || typeof finding !== "object") {
    throw new ReviewReturnError(`REVIEW-RETURN-2 findings[${index}] must be an object`);
  }
  if (
    finding.severity !== "blocking" &&
    finding.severity !== "material" &&
    finding.severity !== "advisory"
  ) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].severity must be blocking|material|advisory`,
    );
  }
  if (typeof finding.claim !== "string" || finding.claim.length === 0) {
    throw new ReviewReturnError(`REVIEW-RETURN-2 findings[${index}].claim must be non-empty`);
  }
  if (finding.claim.length > MAX_FINDING_CLAIM_CHARS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].claim exceeds ${MAX_FINDING_CLAIM_CHARS} characters`,
    );
  }
  if (typeof finding.evidenceRef !== "string" || finding.evidenceRef.length === 0) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].evidenceRef must be non-empty`,
    );
  }
  if (finding.evidenceRef.length > MAX_FINDING_EVIDENCE_REF_CHARS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].evidenceRef exceeds ${MAX_FINDING_EVIDENCE_REF_CHARS} characters`,
    );
  }
  return {
    severity: finding.severity,
    claim: finding.claim,
    evidenceRef: finding.evidenceRef,
  };
}

function assertHex64(value: string, label: string): string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
  return value;
}

function assertIso8601(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new ReviewReturnError(`REVIEW-RETURN-2 ${label} must be a bounded ISO-8601 string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ReviewReturnError(`REVIEW-RETURN-2 ${label} must be a valid ISO-8601 timestamp`);
  }
  return value;
}
