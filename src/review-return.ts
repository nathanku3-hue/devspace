import { createHash, randomBytes } from "node:crypto";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_RETENTION_MS = 10 * 60_000;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const SLICE = "REVIEW-RETURN-2" as const;
const DEFAULT_ROLE = "PRODUCT" as const;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_FINDINGS = 20;
const MAX_FINDING_CLAIM_CHARS = 2_000;
const MAX_FINDING_EVIDENCE_REF_CHARS = 512;
const MAX_MANIFEST_CHARS = 50_000;

export type ReviewRole = "PRODUCT" | "SAW_A" | "SAW_B" | "SAW_C";
export type SawReviewRole = Exclude<ReviewRole, "PRODUCT">;
export type ReviewExecutionSurface = "chatgpt_web" | "chatshare";
export type ReviewResultVerdict = "pass" | "fail" | "abstain";
export type ReviewFindingSeverity = "blocking" | "material" | "advisory";
export type ReviewRunStatus = "pending" | "succeeded" | "failed" | "expired";
export type SawReviewSetStatus = ReviewRunStatus;

export const SAW_REVIEW_ROLES = [
  "SAW_A",
  "SAW_B",
  "SAW_C",
] as const satisfies readonly SawReviewRole[];

export const PRODUCT_ROLE_POLICY = [
  "REVIEW-RETURN-2 PRODUCT role policy v1.",
  "Review only the candidate manifest and evidence manifest supplied in this packet.",
  "Judge product correctness, scope fit, and acceptance clarity.",
  "result must be pass, fail, or abstain.",
  "findings must cite evidenceRef values present in the evidence manifest when possible.",
  "Do not invent repository state, prior reviewer output, or assistant transcript content.",
  "Do not invoke any connector tool other than review_submit.",
].join("\n");

function buildSawRolePolicy(role: SawReviewRole): string {
  return [
    `REVIEW-RETURN-2 ${role} role policy v1.`,
    "Act as one independent reviewer in the SAW A/B/C post-phase gate.",
    "Review only the candidate manifest and evidence manifest supplied in this packet.",
    "Judge correctness, regression and safety risk, scope fit, and whether the supplied evidence supports closure.",
    "result must be pass, fail, or abstain.",
    "findings must cite evidenceRef values present in the evidence manifest when possible.",
    "Do not infer or request another SAW reviewer's result, reasoning, transcript, or verdict.",
    "Do not invent repository state, prior reviewer output, or assistant transcript content.",
    "Do not invoke any connector tool other than review_submit.",
  ].join("\n");
}

export const SAW_A_ROLE_POLICY = buildSawRolePolicy("SAW_A");
export const SAW_B_ROLE_POLICY = buildSawRolePolicy("SAW_B");
export const SAW_C_ROLE_POLICY = buildSawRolePolicy("SAW_C");

export const REVIEW_ROLE_POLICIES: Readonly<Record<ReviewRole, string>> =
  Object.freeze({
    PRODUCT: PRODUCT_ROLE_POLICY,
    SAW_A: SAW_A_ROLE_POLICY,
    SAW_B: SAW_B_ROLE_POLICY,
    SAW_C: SAW_C_ROLE_POLICY,
  });

export const REVIEW_ROLE_POLICY_DIGESTS: Readonly<Record<ReviewRole, string>> =
  Object.freeze({
    PRODUCT: sha256Hex(PRODUCT_ROLE_POLICY),
    SAW_A: sha256Hex(SAW_A_ROLE_POLICY),
    SAW_B: sha256Hex(SAW_B_ROLE_POLICY),
    SAW_C: sha256Hex(SAW_C_ROLE_POLICY),
  });

export const PRODUCT_ROLE_POLICY_DIGEST = REVIEW_ROLE_POLICY_DIGESTS.PRODUCT;

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  claim: string;
  evidenceRef: string;
}

export interface ReviewStartInput {
  role?: ReviewRole;
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
  role: ReviewRole;
  result: ReviewResultVerdict;
  summary: string;
  findings: ReviewFinding[];
  reviewedAt: string;
}

export interface ReviewStartAcknowledgement extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  reviewId: string;
  role: ReviewRole;
  executionSurface: ReviewExecutionSurface;
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
  executionSurface: ReviewExecutionSurface;
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
  role: ReviewRole;
  executionSurface: ReviewExecutionSurface;
  status: ReviewRunStatus;
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

export interface ReviewSucceededStatus
  extends ReviewStatusBase,
    ReviewReturnResult {
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

export interface SawReviewSetStartAcknowledgement
  extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  batchId: string;
  executionSurface: ReviewExecutionSurface;
  status: "pending";
  startedAt: string;
  reviews: ReviewStartAcknowledgement[];
}

export interface SawReviewSetStatusAcknowledgement
  extends Record<string, unknown> {
  slice: "REVIEW-RETURN-2";
  batchId: string;
  executionSurface: ReviewExecutionSurface;
  status: SawReviewSetStatus;
  result?: ReviewResultVerdict;
  reviews: ReviewStatusAcknowledgement[];
}

export interface ReviewReturnOptions {
  reviewIdFactory?: () => string;
  challengeFactory?: () => string;
  batchIdFactory?: () => string;
  executionSurface?: ReviewExecutionSurface;
  now?: () => Date;
  timeoutMs?: number;
  retentionMs?: number;
  cleanupSucceededConversations?: boolean;
  cleanupDelayMs?: number;
  cleanupRetryMs?: number;
  cleanupWatchMs?: number;
}

interface FrozenReviewBindings {
  role: ReviewRole;
  candidateManifestDigest: string;
  evidenceManifestDigest: string;
  rolePolicyDigest: string;
}

interface PendingSubmission {
  structured: ReviewStructuredResult;
}

interface ReviewRun {
  id: string;
  status: ReviewRunStatus;
  startedAt: string;
  expiresAt: string;
  launchIdentity?: string;
  callbackReceivedAt?: string;
  result?: ReviewReturnResult;
  failureCode?: string;
  timeoutTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
}

interface SawReviewSet {
  id: string;
  reviewIds: string[];
  cleanupTimer?: NodeJS.Timeout;
}

export class ReviewReturnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewReturnError";
  }
}

export class ReviewReturnController {
  readonly #browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
    Partial<
      Pick<
        WebLaunchBrowserController,
        "deleteWebConversation" | "stopWebConversationRecovery"
      >
    >;
  readonly #reviewIdFactory: () => string;
  readonly #challengeFactory: () => string;
  readonly #batchIdFactory: () => string;
  readonly #executionSurface: ReviewExecutionSurface;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #retentionMs: number;
  readonly #cleanupSucceededConversations: boolean;
  readonly #cleanupDelayMs: number;
  readonly #cleanupRetryMs: number;
  readonly #cleanupWatchMs: number;
  readonly #runs = new Map<string, ReviewRun>();
  readonly #bindingsByReviewId = new Map<string, FrozenReviewBindings>();
  readonly #submissionByReviewId = new Map<string, PendingSubmission>();
  readonly #reviewIdByChallenge = new Map<string, string>();
  readonly #challengeByReviewId = new Map<string, string>();
  readonly #sawReviewSets = new Map<string, SawReviewSet>();
  #launchQueue: Promise<void> = Promise.resolve();

  constructor(
    browser: Pick<WebLaunchBrowserController, "launchWebConversation"> &
      Partial<
        Pick<
          WebLaunchBrowserController,
          "deleteWebConversation" | "stopWebConversationRecovery"
        >
      >,
    options: ReviewReturnOptions = {},
  ) {
    this.#browser = browser;
    this.#reviewIdFactory =
      options.reviewIdFactory ?? (() => randomBytes(32).toString("hex"));
    this.#challengeFactory =
      options.challengeFactory ?? (() => randomBytes(32).toString("hex"));
    this.#batchIdFactory =
      options.batchIdFactory ?? (() => `saw-${randomBytes(16).toString("hex")}`);
    this.#executionSurface = options.executionSurface ?? "chatgpt_web";
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = assertPositiveInteger(
      options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      "run timeout",
    );
    this.#retentionMs = assertPositiveInteger(
      options.retentionMs ?? DEFAULT_RUN_RETENTION_MS,
      "run retention",
    );
    this.#cleanupSucceededConversations =
      options.cleanupSucceededConversations ?? false;
    this.#cleanupDelayMs = options.cleanupDelayMs ?? 3_000;
    this.#cleanupRetryMs = options.cleanupRetryMs ?? 2_000;
    this.#cleanupWatchMs = options.cleanupWatchMs ?? 2 * 60_000;
  }

  startReview(input: ReviewStartInput): ReviewStartAcknowledgement {
    const role = normalizeReviewRole(input.role ?? DEFAULT_ROLE);
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
    const rolePolicy = REVIEW_ROLE_POLICIES[role];
    const rolePolicyDigest = REVIEW_ROLE_POLICY_DIGESTS[role];

    const reviewId = this.#reviewIdFactory();
    const challenge = this.#challengeFactory();
    assertHex64(reviewId, "reviewId");
    assertHex64(challenge, "challenge");

    if (this.#runs.has(reviewId)) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 generated a duplicate review ID",
      );
    }
    if (this.#reviewIdByChallenge.has(challenge)) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 generated a duplicate challenge",
      );
    }

    const startedAtDate = this.#now();
    const startedAt = startedAtDate.toISOString();
    const expiresAt = new Date(
      startedAtDate.getTime() + this.#timeoutMs,
    ).toISOString();
    const run: ReviewRun = {
      id: reviewId,
      status: "pending",
      startedAt,
      expiresAt,
    };

    run.timeoutTimer = setTimeout(() => this.#expire(reviewId), this.#timeoutMs);
    run.timeoutTimer.unref?.();

    this.#runs.set(reviewId, run);
    this.#bindingsByReviewId.set(reviewId, {
      role,
      candidateManifestDigest,
      evidenceManifestDigest,
      rolePolicyDigest,
    });
    this.#reviewIdByChallenge.set(challenge, reviewId);
    this.#challengeByReviewId.set(reviewId, challenge);

    this.#enqueueLaunch(reviewId, {
      role,
      challenge,
      candidateManifest,
      candidateManifestDigest,
      evidenceManifest,
      evidenceManifestDigest,
      rolePolicy,
      rolePolicyDigest,
    });

    return {
      slice: SLICE,
      reviewId,
      role,
      executionSurface: this.#executionSurface,
      status: "pending",
      startedAt,
      expiresAt,
      candidateManifestDigest,
      evidenceManifestDigest,
      rolePolicyDigest,
      assistantOutputCaptured: false,
    };
  }

  startSawReviewSet(
    input: Omit<ReviewStartInput, "role">,
  ): SawReviewSetStartAcknowledgement {
    const batchId = this.#batchIdFactory().trim();
    if (!batchId) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 generated an empty SAW batch ID",
      );
    }
    if (this.#sawReviewSets.has(batchId)) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 generated a duplicate SAW batch ID",
      );
    }

    const startedAt = this.#now().toISOString();
    const reviews = SAW_REVIEW_ROLES.map((role) =>
      this.startReview({
        ...input,
        role,
      }),
    );

    const batch: SawReviewSet = {
      id: batchId,
      reviewIds: reviews.map((review) => review.reviewId),
    };
    batch.cleanupTimer = setTimeout(
      () => this.#forgetSawReviewSet(batchId),
      this.#timeoutMs + this.#retentionMs,
    );
    batch.cleanupTimer.unref?.();
    this.#sawReviewSets.set(batchId, batch);

    return {
      slice: SLICE,
      batchId,
      executionSurface: this.#executionSurface,
      status: "pending",
      startedAt,
      reviews,
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
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 review callback already consumed",
      );
    }

    this.#reviewIdByChallenge.delete(callback.challenge);
    this.#challengeByReviewId.delete(reviewId);

    const reviewedAt = this.#now().toISOString();
    const structured: ReviewStructuredResult = {
      reviewId,
      role: bindings.role,
      result: callback.result,
      summary: callback.summary,
      findings: callback.findings,
      reviewedAt,
    };
    this.#submissionByReviewId.set(reviewId, { structured });
    run.callbackReceivedAt = reviewedAt;
    this.#maybeComplete(reviewId);

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
      role: bindings.role,
      executionSurface: this.#executionSurface,
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

  getSawReviewSetStatus(batchId: string): SawReviewSetStatusAcknowledgement {
    const batch = this.#sawReviewSets.get(batchId);
    if (!batch) {
      throw new ReviewReturnError(
        "REVIEW-RETURN-2 SAW batch is unknown or no longer retained",
      );
    }

    const reviews = batch.reviewIds.map((reviewId) =>
      this.getReviewStatus(reviewId),
    );
    const status: SawReviewSetStatus =
      reviews.some((review) => review.status === "failed")
        ? "failed"
        : reviews.some((review) => review.status === "expired")
          ? "expired"
          : reviews.some((review) => review.status === "pending")
            ? "pending"
            : "succeeded";

    const result =
      status === "succeeded"
        ? aggregateSawVerdict(
            reviews.map(
              (review) => (review as ReviewSucceededStatus).result,
            ),
          )
        : undefined;

    return {
      slice: SLICE,
      batchId: batch.id,
      executionSurface: this.#executionSurface,
      status,
      ...(result === undefined ? {} : { result }),
      reviews,
    };
  }

  close(): void {
    for (const run of this.#runs.values()) {
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
      if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    }
    this.#runs.clear();
    this.#bindingsByReviewId.clear();
    this.#submissionByReviewId.clear();
    this.#reviewIdByChallenge.clear();
    this.#challengeByReviewId.clear();
    for (const batch of this.#sawReviewSets.values()) {
      if (batch.cleanupTimer) clearTimeout(batch.cleanupTimer);
    }
    this.#sawReviewSets.clear();
    this.#launchQueue = Promise.resolve();
  }

  #enqueueLaunch(
    reviewId: string,
    packet: Parameters<typeof buildReviewReturnPrompt>[0],
  ): void {
    const launch = async (): Promise<void> => {
      const current = this.#runs.get(reviewId);
      if (!current || current.status !== "pending") return;

      try {
        const acknowledgement = await this.#browser.launchWebConversation(
          buildReviewReturnPrompt(packet),
          { attachDevSpace: true },
        );
        const latest = this.#runs.get(reviewId);
        if (!latest || latest.status !== "pending") {
          this.#stopRecovery(acknowledgement.conversationIdentitySha256);
          return;
        }
        latest.launchIdentity = acknowledgement.conversationIdentitySha256;
        this.#maybeComplete(reviewId);
      } catch {
        this.#fail(reviewId, "launch_failed");
      }
    };

    const queued = this.#launchQueue.then(launch, launch);
    this.#launchQueue = queued.then(
      () => undefined,
      () => undefined,
    );
  }

  #maybeComplete(reviewId: string): void {
    const run = this.#runs.get(reviewId);
    const bindings = this.#bindingsByReviewId.get(reviewId);
    const submission = this.#submissionByReviewId.get(reviewId);
    if (
      !run ||
      run.status !== "pending" ||
      !bindings ||
      !submission ||
      !run.launchIdentity ||
      !run.callbackReceivedAt
    ) {
      return;
    }

    run.result = {
      ...submission.structured,
      executionSurface: this.#executionSurface,
      candidateManifestDigest: bindings.candidateManifestDigest,
      evidenceManifestDigest: bindings.evidenceManifestDigest,
      rolePolicyDigest: bindings.rolePolicyDigest,
      conversationIdentitySha256: run.launchIdentity,
      callbackTimestamp: run.callbackReceivedAt,
      assistantOutputCaptured: false,
    };
    run.status = "succeeded";
    this.#finishTerminal(run);
    this.#startSucceededConversationCleanup(run);
  }

  #startSucceededConversationCleanup(run: ReviewRun): void {
    if (!this.#cleanupSucceededConversations || run.status !== "succeeded") return;
    const deleteWebConversation = this.#browser.deleteWebConversation?.bind(this.#browser);
    const conversationIdentitySha256 = run.launchIdentity;
    if (!deleteWebConversation || !conversationIdentitySha256 || this.#cleanupWatchMs <= 0) {
      return;
    }

    const startedAtMs = Date.now();
    const reviewId = run.id;
    const schedule = (delayMs: number): void => {
      const timer = setTimeout(() => {
        void tick();
      }, Math.max(1, delayMs));
      timer.unref?.();
    };
    const tick = async (): Promise<void> => {
      const current = this.#runs.get(reviewId);
      if (
        !current ||
        current.status !== "succeeded" ||
        current.launchIdentity !== conversationIdentitySha256
      ) {
        return;
      }
      if (Date.now() - startedAtMs >= this.#cleanupWatchMs) return;
      try {
        const result = await deleteWebConversation(conversationIdentitySha256);
        if (result === "deleted") return;
      } catch {
        // Sidebar/menu transitions are retried only for this succeeded review.
      }
      schedule(this.#cleanupRetryMs);
    };
    schedule(this.#cleanupDelayMs);
  }

  #fail(reviewId: string, failureCode: string): void {
    const run = this.#runs.get(reviewId);
    if (!run || run.status !== "pending") return;
    run.status = "failed";
    run.failureCode = failureCode;
    this.#submissionByReviewId.delete(reviewId);
    this.#finishTerminal(run);
  }

  #expire(reviewId: string): void {
    const run = this.#runs.get(reviewId);
    if (!run || run.status !== "pending") return;
    run.status = "expired";
    this.#submissionByReviewId.delete(reviewId);
    this.#finishTerminal(run);
  }

  #finishTerminal(run: ReviewRun): void {
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = undefined;
    }
    this.#removeChallengeForReview(run.id);
    if (run.launchIdentity) this.#stopRecovery(run.launchIdentity);
    const belongsToSawBatch = [...this.#sawReviewSets.values()].some((batch) =>
      batch.reviewIds.includes(run.id),
    );
    if (!belongsToSawBatch) {
      run.cleanupTimer = setTimeout(() => this.#forget(run.id), this.#retentionMs);
      run.cleanupTimer.unref?.();
    }
  }

  #forget(reviewId: string): void {
    const run = this.#runs.get(reviewId);
    if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run?.cleanupTimer) clearTimeout(run.cleanupTimer);
    this.#removeChallengeForReview(reviewId);
    this.#runs.delete(reviewId);
    this.#bindingsByReviewId.delete(reviewId);
    this.#submissionByReviewId.delete(reviewId);
  }

  #forgetSawReviewSet(batchId: string): void {
    const batch = this.#sawReviewSets.get(batchId);
    if (!batch) return;
    if (batch.cleanupTimer) clearTimeout(batch.cleanupTimer);

    for (const reviewId of batch.reviewIds) {
      const run = this.#runs.get(reviewId);
      if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
      if (run?.cleanupTimer) clearTimeout(run.cleanupTimer);
      this.#removeChallengeForReview(reviewId);
      this.#runs.delete(reviewId);
      this.#bindingsByReviewId.delete(reviewId);
      this.#submissionByReviewId.delete(reviewId);
    }
    this.#sawReviewSets.delete(batchId);
  }

  #removeChallengeForReview(reviewId: string): void {
    const challenge = this.#challengeByReviewId.get(reviewId);
    if (!challenge) return;
    this.#challengeByReviewId.delete(reviewId);
    this.#reviewIdByChallenge.delete(challenge);
  }

  #stopRecovery(conversationIdentitySha256: string): void {
    try {
      this.#browser.stopWebConversationRecovery?.(conversationIdentitySha256);
    } catch {
      // Review retention must not depend on watcher cleanup.
    }
  }
}

export function buildReviewReturnPrompt(input: {
  role?: ReviewRole;
  challenge: string;
  candidateManifest: string;
  candidateManifestDigest: string;
  evidenceManifest: string;
  evidenceManifestDigest: string;
  rolePolicy: string;
  rolePolicyDigest: string;
}): string {
  const role = normalizeReviewRole(input.role ?? DEFAULT_ROLE);
  assertHex64(input.challenge, "challenge");
  assertHex64(input.candidateManifestDigest, "candidateManifestDigest");
  assertHex64(input.evidenceManifestDigest, "evidenceManifestDigest");
  assertHex64(input.rolePolicyDigest, "rolePolicyDigest");

  return [
    `REVIEW-RETURN-2 ${role} review packet.`,
    "Use the connected DevSpace connector through the normal ChatGPT tool interface.",
    `You are the ${role} reviewer for this candidate.`,
    `Review only the candidate and evidence content in this packet under the ${role} policy.`,
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
    `----- BEGIN ${role} ROLE POLICY -----`,
    input.rolePolicy,
    `----- END ${role} ROLE POLICY -----`,
    "Invoke the bounded `review_submit` tool exactly once with:",
    "- challenge matching the value above",
    "- result one of pass | fail | abstain",
    "- summary bounded text",
    "- findings array of {severity: blocking|material|advisory, claim, evidenceRef}",
    "Do not supply reviewId, role, rolePolicyDigest, or reviewedAt; the server owns those.",
    "Do not supply executionSurface; the server owns it.",
    "Do not invoke any other connector tool.",
    "Do not include previous reviewer output.",
    "Do not capture or return assistant transcript text.",
    "After submit succeeds, stop. Do not ask the user a question.",
  ].join("\n");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aggregateSawVerdict(
  results: ReviewResultVerdict[],
): ReviewResultVerdict {
  if (results.some((result) => result === "fail")) return "fail";
  if (results.some((result) => result === "abstain")) return "abstain";
  return "pass";
}

function normalizeReviewRole(value: ReviewRole): ReviewRole {
  if (
    value !== "PRODUCT" &&
    value !== "SAW_A" &&
    value !== "SAW_B" &&
    value !== "SAW_C"
  ) {
    throw new ReviewReturnError(
      "REVIEW-RETURN-2 role must be PRODUCT|SAW_A|SAW_B|SAW_C",
    );
  }
  return value;
}

function normalizeCallbackInput(
  payload: ReviewCallbackInput,
): ReviewCallbackInput {
  if (!payload || typeof payload !== "object") {
    throw new ReviewReturnError(
      "REVIEW-RETURN-2 callback payload must be an object",
    );
  }
  const challenge = assertHex64(payload.challenge, "challenge");
  if (
    payload.result !== "pass" &&
    payload.result !== "fail" &&
    payload.result !== "abstain"
  ) {
    throw new ReviewReturnError(
      'REVIEW-RETURN-2 result must be "pass", "fail", or "abstain"',
    );
  }
  if (typeof payload.summary !== "string") {
    throw new ReviewReturnError(
      "REVIEW-RETURN-2 summary must be a string",
    );
  }
  if (
    payload.summary.length === 0 ||
    payload.summary.length > MAX_SUMMARY_CHARS
  ) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 summary must be 1..${MAX_SUMMARY_CHARS} characters`,
    );
  }
  if (payload.summary.includes("\r")) {
    throw new ReviewReturnError(
      "REVIEW-RETURN-2 summary rejects carriage returns",
    );
  }
  if (!Array.isArray(payload.findings)) {
    throw new ReviewReturnError(
      "REVIEW-RETURN-2 findings must be an array",
    );
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
    findings: payload.findings.map((finding, index) =>
      normalizeFinding(finding, index),
    ),
  };
}

function normalizeFinding(
  finding: ReviewFinding,
  index: number,
): ReviewFinding {
  if (!finding || typeof finding !== "object") {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}] must be an object`,
    );
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
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].claim must be non-empty`,
    );
  }
  if (finding.claim.length > MAX_FINDING_CLAIM_CHARS) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 findings[${index}].claim exceeds ${MAX_FINDING_CLAIM_CHARS} characters`,
    );
  }
  if (
    typeof finding.evidenceRef !== "string" ||
    finding.evidenceRef.length === 0
  ) {
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
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} must be a string`,
    );
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

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewReturnError(
      `REVIEW-RETURN-2 ${label} must be a positive integer`,
    );
  }
  return value;
}
