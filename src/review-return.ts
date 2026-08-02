import { createHash, randomBytes } from "node:crypto";
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
const MAX_MANIFEST_CHARS = 50_000;

/**
 * Server-owned PRODUCT review policy. Digest is computed over these exact bytes.
 * Callers cannot supply or override role policy content.
 */
export const PRODUCT_ROLE_POLICY = [
  "REVIEW-RETURN-2 PRODUCT role policy v1.",
  "Review only the candidate manifest and evidence manifest supplied in this packet.",
  "Judge product correctness, scope fit, and acceptance clarity.",
  "result must be pass, fail, or abstain.",
  "findings must cite evidenceRef values present in the evidence manifest when possible.",
  "Do not invent repository state, prior reviewer output, or assistant transcript content.",
  "Do not invoke any connector tool other than review_submit.",
].join("\n");

export const PRODUCT_ROLE_POLICY_DIGEST = sha256Hex(PRODUCT_ROLE_POLICY);

export type ReviewResultVerdict = "pass" | "fail" | "abstain";
export type ReviewFindingSeverity = "blocking" | "material" | "advisory";

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  claim: string;
  evidenceRef: string;
}

export interface ReviewStartInput {
  candidateManifest: string;
  candidateManifestDigest: string;
  evidenceManifest: string;
  evidenceManifestDigest: string;
}

export interface ReviewCallbackInput {
  challenge: string;
  result: ReviewResultVerdict;
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewStructuredResult {
  reviewId: string;
  role: "PRODUCT";
  result: ReviewResultVerdict;
  summary: string;
  findings: ReviewFinding[];
  reviewedAt: string;
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
  challengeFactory?: () => string;
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
  readonly #challengeFactory: () => string;
  readonly #now: () => Date;
  readonly #runs: RetainedExternalConversationRuns<ReviewReturnResult>;
  readonly #bindingsByReviewId = new Map<string, FrozenReviewBindings>();
  readonly #submissionByReviewId = new Map<string, PendingSubmission>();
  readonly #reviewIdByChallenge = new Map<string, string>();
  readonly #challengeByReviewId = new Map<string, string>();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation">,
    options: ReviewReturnOptions = {},
  ) {
    this.#browser = browser;
    this.#reviewIdFactory =
      options.reviewIdFactory ?? (() => randomBytes(32).toString("hex"));
    this.#challengeFactory =
      options.challengeFactory ?? (() => randomBytes(32).toString("hex"));
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
        this.#removeChallengeForReview(run.id);
        if (run.status !== "succeeded") {
          this.#submissionByReviewId.delete(run.id);
        }
      },
    });
  }

  startReview(input: ReviewStartInput): ReviewStartAcknowledgement {
    const candidateManifest = assertBoundedManifest(
      input.candidateManifest,
      "candidateManifest",
    );
    const evidenceManifest = assertBoundedManifest(
      input.evidenceManifest,
      "evidenceManifest",
    );
    const candidateManifestDigest = assertMatchingDigest(
      candidateManifest,
      input.candidateManifestDigest,
      "candidateManifestDigest",
    );
    const evidenceManifestDigest = assertMatchingDigest(
      evidenceManifest,
      input.evidenceManifestDigest,
      "evidenceManifestDigest",
    );
    const rolePolicyDigest = PRODUCT_ROLE_POLICY_DIGEST;

    const reviewId = this.#reviewIdFactory();
    const challenge = this.#challengeFactory();
    assertHex64(reviewId, "reviewId");
    assertHex64(challenge, "challenge");

    if (this.#runs.get(reviewId)) {
      throw new ReviewReturnError("REVIEW-RETURN-2 generated a duplicate review ID");
    }
    if (this.#reviewIdByChallenge.has(challenge)) {
      throw new ReviewReturnError("REVIEW-RETURN-2 generated a duplicate challenge");
    }

    const run = this.#runs.start(reviewId, this.#now());
    this.#bindingsByReviewId.set(reviewId, {
      candidateManifestDigest,
      evidenceManifestDigest,
      rolePolicyDigest,
    });
    this.#reviewIdByChallenge.set(challenge, reviewId);
    this.#challengeByReviewId.set(reviewId, challenge);

    void Promise.resolve()
      .then(() =>
        this.#browser.launchWebConversation(
          buildReviewReturnPrompt({
            challenge,
            candidateManifest,
            candidateManifestDigest,
            evidenceManifest,
            evidenceManifestDigest,
            rolePolicy: PRODUCT_ROLE_POLICY,
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

  submitReview(payload: ReviewCallbackInput): ReviewSubmitAcknowledgement {
    const callback = normalizeCallbackInput(payload);
    const reviewId = this.#reviewIdByChallenge.get(callback.challenge);
    if (!reviewId) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 challenge is unknown, expired, or already consumed",
      );
    }

    const bindings = this.#bindingsByReviewId.get(reviewId);
    const run = this.#runs.get(reviewId);
    if (!bindings || !run || run.status !== "pending") {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 review is unknown, expired, or already completed",
      );
    }
    if (this.#submissionByReviewId.has(reviewId)) {
      throw new ReviewReturnError("REVIEW-RETURN-2 review callback already consumed");
    }

    // Consume the prompt-only challenge before accepting the callback body.
    this.#reviewIdByChallenge.delete(callback.challenge);
    this.#challengeByReviewId.delete(reviewId);

    const reviewedAt = this.#now().toISOString();
    const structured: ReviewStructuredResult = {
      reviewId,
      role: ROLE,
      result: callback.result,
      summary: callback.summary,
      findings: callback.findings,
      reviewedAt,
    };
    this.#submissionByReviewId.set(reviewId, { structured });
    this.#runs.recordCallback(reviewId, reviewedAt);

    return {
      slice: SLICE,
      reviewAccepted: true,
      reviewId,
      timestamp: reviewedAt,
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
    this.#reviewIdByChallenge.clear();
    this.#challengeByReviewId.clear();
    this.#runs.close();
  }

  #removeChallengeForReview(reviewId: string): void {
    const challenge = this.#challengeByReviewId.get(reviewId);
    if (!challenge) return;
    this.#challengeByReviewId.delete(reviewId);
    this.#reviewIdByChallenge.delete(challenge);
  }
}

export function buildReviewReturnPrompt(input: {
  challenge: string;
  candidateManifest: string;
  candidateManifestDigest: string;
  evidenceManifest: string;
  evidenceManifestDigest: string;
  rolePolicy: string;
  rolePolicyDigest: string;
}): string {
  assertHex64(input.challenge, "challenge");
  assertHex64(input.candidateManifestDigest, "candidateManifestDigest");
  assertHex64(input.evidenceManifestDigest, "evidenceManifestDigest");
  assertHex64(input.rolePolicyDigest, "rolePolicyDigest");
  return [
    "REVIEW-RETURN-2 PRODUCT review packet.",
    "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
    "You are the PRODUCT reviewer for this candidate.",
    "Review only the candidate and evidence content in this packet under the PRODUCT policy.",
    `challenge: ${input.challenge}`,
    `candidateManifestDigest: ${input.candidateManifestDigest}`,
    `evidenceManifestDigest: ${input.evidenceManifestDigest}`,
    `rolePolicyDigest: ${input.rolePolicyDigest}`,
    "----- BEGIN CANDIDATE MANIFEST -----",
    input.candidateManifest,
    "----- END CANDIDATE MANIFEST -----",
    "----- BEGIN EVIDENCE MANIFEST -----",
    input.evidenceManifest,
    "----- END EVIDENCE MANIFEST -----",
    "----- BEGIN PRODUCT ROLE POLICY -----",
    input.rolePolicy,
    "----- END PRODUCT ROLE POLICY -----",
    "Invoke the bounded `review_submit` tool exactly once with:",
    "- challenge matching the value above",
    "- result one of pass | fail | abstain",
    "- summary bounded text",
    "- findings array of {severity: blocking|material|advisory, claim, evidenceRef}",
    "Do not supply reviewId, role, rolePolicyDigest, or reviewedAt; the server owns those.",
    "Do not invoke any other connector tool.",
    "Do not include previous reviewer output.",
    "Do not capture or return assistant transcript text.",
    "After submit succeeds, stop. Do not ask the user a question.",
  ].join("\n");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeCallbackInput(payload: ReviewCallbackInput): ReviewCallbackInput {
  if (!payload || typeof payload !== "object") {
    throw new ReviewReturnError("REVIEW-RETURN-2 callback payload must be an object");
  }
  const challenge = assertHex64(payload.challenge, "challenge");
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
  return {
    challenge,
    result: payload.result,
    summary: payload.summary,
    findings: payload.findings.map((finding, index) => normalizeFinding(finding, index)),
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

function assertBoundedManifest(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ReviewReturnError(`REVIEW-RETURN-2 ${label} must be a string`);
  }
  if (value.length === 0 || value.length > MAX_MANIFEST_CHARS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} must be 1..${MAX_MANIFEST_CHARS} characters`,
    );
  }
  if (value.includes("\r")) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} rejects carriage returns so digest bytes stay exact`,
    );
  }
  return value;
}

function assertMatchingDigest(
  content: string,
  suppliedDigest: string,
  label: string,
): string {
  const expected = assertHex64(suppliedDigest, label);
  const actual = sha256Hex(content);
  if (actual !== expected) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} does not match the exact manifest content`,
    );
  }
  return expected;
}

function assertHex64(value: string, label: string): string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
  return value;
}
