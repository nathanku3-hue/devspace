import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import {
  buildReviewReturnPrompt,
  PRODUCT_ROLE_POLICY,
  PRODUCT_ROLE_POLICY_DIGEST,
  REVIEW_ROLE_POLICY_DIGESTS,
  ReviewReturnController,
  sha256Hex,
  type ReviewCallbackInput,
} from "./review-return.js";
import { createMcpServer } from "./server.js";
import type { WebLaunchAcknowledgement } from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

const REVIEW_ID = "a".repeat(64);
const CHALLENGE = "f".repeat(64);
const CANDIDATE_MANIFEST = "candidate: ship review return with packet content";
const EVIDENCE_MANIFEST = "evidence: fixture-1 proves structured return";
const CANDIDATE_DIGEST = sha256Hex(CANDIDATE_MANIFEST);
const EVIDENCE_DIGEST = sha256Hex(EVIDENCE_MANIFEST);
const CONVERSATION_HASH = "e".repeat(64);
const START_TIME = "2026-09-30T13:00:00.000Z";
const CALLBACK_TIME = "2026-09-30T13:00:05.000Z";

function launchAcknowledgement(): WebLaunchAcknowledgement {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: CONVERSATION_HASH,
    timestamp: "2026-09-30T13:00:01.000Z",
    assistantOutputCaptured: false,
  };
}

function startInput() {
  return {
    candidateManifest: CANDIDATE_MANIFEST,
    candidateManifestDigest: CANDIDATE_DIGEST,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceManifestDigest: EVIDENCE_DIGEST,
  };
}

function validCallback(
  overrides: Partial<ReviewCallbackInput> = {},
): ReviewCallbackInput {
  return {
    challenge: CHALLENGE,
    result: "pass",
    summary: "Minimum structured PRODUCT review over packet content.",
    findings: [
      {
        severity: "advisory",
        claim: "Candidate matches evidence fixture-1.",
        evidenceRef: "fixture-1",
      },
    ],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function controller(
  browser: ConstructorParameters<typeof ReviewReturnController>[0],
  now: () => Date = () => new Date(START_TIME),
  timeoutMs = 1_000,
): ReviewReturnController {
  return new ReviewReturnController(browser, {
    reviewIdFactory: () => REVIEW_ID,
    challengeFactory: () => CHALLENGE,
    now,
    timeoutMs,
    retentionMs: 1_000,
  });
}

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "review-return-test-owner-token",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost"],
      deviceAuthorization: {
        enabled: false,
        required: false,
        loopbackPort: 7677,
        extensionId: "aaoelopmdnhifffjefciagfmhjanbaoc",
        allowedRedirectPrefixes: [],
        challengeTtlSeconds: 60,
      },
    },
    allowedRoots: [parent],
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "http://127.0.0.1:7676",
    minimalTools: true,
    toolNaming: "short",
    widgets: "off",
    chatSessionProvider: "chatgpt",
    stateDir: join(parent, "state"),
    skillsEnabled: false,
    skillPaths: [],
    agentDir: join(parent, "agents"),
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

test("fixed packet contains challenge but never the source-visible reviewId", () => {
  const prompt = buildReviewReturnPrompt({
    challenge: CHALLENGE,
    candidateManifest: CANDIDATE_MANIFEST,
    candidateManifestDigest: CANDIDATE_DIGEST,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceManifestDigest: EVIDENCE_DIGEST,
    rolePolicy: PRODUCT_ROLE_POLICY,
    rolePolicyDigest: PRODUCT_ROLE_POLICY_DIGEST,
  });
  assert.match(prompt, new RegExp(CHALLENGE));
  assert.doesNotMatch(prompt, new RegExp(REVIEW_ID));
  assert.match(prompt, /Do not supply reviewId, role, rolePolicyDigest, or reviewedAt/);
});

test("supplied digests must match exact manifest bytes", () => {
  const review = controller({
    launchWebConversation: async () => launchAcknowledgement(),
  });
  try {
    assert.throws(
      () =>
        review.startReview({
          ...startInput(),
          candidateManifestDigest: "0".repeat(64),
        }),
      /candidateManifestDigest does not match/,
    );
    assert.throws(
      () =>
        review.startReview({
          ...startInput(),
          evidenceManifestDigest: "1".repeat(64),
        }),
      /evidenceManifestDigest does not match/,
    );
  } finally {
    review.close();
  }
});

test("review launch is asynchronous, attaches DevSpace, and reviewId cannot authorize submission", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  let launchedPrompt = "";
  let attached: boolean | undefined;
  const review = controller({
    launchWebConversation: async (prompt, options) => {
      launchedPrompt = prompt;
      attached = options?.attachDevSpace;
      return launch.promise;
    },
  });
  try {
    const started = review.startReview(startInput());
    assert.equal(started.reviewId, REVIEW_ID);
    assert.equal(started.role, "PRODUCT");
    assert.equal("challenge" in started, false);
    await waitFor(() => launchedPrompt.length > 0);
    assert.equal(attached, true);
    assert.match(launchedPrompt, new RegExp(CHALLENGE));
    assert.doesNotMatch(launchedPrompt, new RegExp(REVIEW_ID));
    assert.throws(
      () => review.submitReview(validCallback({ challenge: REVIEW_ID })),
      /unknown, expired, or already consumed/,
    );
    launch.resolve(launchAcknowledgement());
  } finally {
    review.close();
  }
});

test("callback may arrive before launch acknowledgement and all identity fields remain server-owned", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  const stopped: string[] = [];
  const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
  const review = controller(
    {
      launchWebConversation: async () => launch.promise,
      stopWebConversationRecovery: (identity) => {
        stopped.push(identity);
        return true;
      },
    },
    () => times.shift() ?? new Date(CALLBACK_TIME),
  );
  try {
    review.startReview(startInput());
    const accepted = review.submitReview(validCallback());
    assert.equal(accepted.reviewId, REVIEW_ID);
    assert.equal(accepted.timestamp, CALLBACK_TIME);
    assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");

    launch.resolve(launchAcknowledgement());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");

    const status = review.getReviewStatus(REVIEW_ID);
    assert.equal(status.status, "succeeded");
    if (status.status !== "succeeded") throw new Error("unexpected status");
    assert.equal(status.role, "PRODUCT");
    assert.equal(status.reviewedAt, CALLBACK_TIME);
    assert.equal(status.callbackTimestamp, CALLBACK_TIME);
    assert.equal(status.rolePolicyDigest, PRODUCT_ROLE_POLICY_DIGEST);
    assert.equal(status.conversationIdentitySha256, CONVERSATION_HASH);
    assert.equal(status.result, "pass");
    assert.deepEqual(stopped, [CONVERSATION_HASH]);
    assert.throws(() => review.submitReview(validCallback()), /unknown, expired, or already consumed/);
  } finally {
    review.close();
  }
});

test("successful PRODUCT review deletes ChatShare history and retries transient busy state", async () => {
  const deleteCalls: string[] = [];
  let deleteAttempt = 0;
  const review = new ReviewReturnController(
    {
      launchWebConversation: async () => launchAcknowledgement(),
      deleteWebConversation: async (identity) => {
        deleteCalls.push(identity);
        deleteAttempt += 1;
        return deleteAttempt === 1 ? "busy" : "deleted";
      },
    },
    {
      reviewIdFactory: () => REVIEW_ID,
      challengeFactory: () => CHALLENGE,
      executionSurface: "chatshare",
      now: () => new Date(START_TIME),
      timeoutMs: 1_000,
      retentionMs: 1_000,
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 100,
    },
  );
  try {
    review.startReview(startInput());
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(deleteCalls, []);

    review.submitReview(validCallback());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
    await waitFor(() => deleteCalls.length === 2, 500);
    assert.deepEqual(deleteCalls, [CONVERSATION_HASH, CONVERSATION_HASH]);
  } finally {
    review.close();
  }
});

test("failed and expired reviews preserve their ChatShare history for diagnosis", async () => {
  const failedDeletes: string[] = [];
  const failed = new ReviewReturnController(
    {
      launchWebConversation: async () => {
        throw new Error("browser unavailable");
      },
      deleteWebConversation: async (identity) => {
        failedDeletes.push(identity);
        return "deleted";
      },
    },
    {
      reviewIdFactory: () => REVIEW_ID,
      challengeFactory: () => CHALLENGE,
      executionSurface: "chatshare",
      now: () => new Date(START_TIME),
      timeoutMs: 1_000,
      retentionMs: 1_000,
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 50,
    },
  );
  try {
    failed.startReview(startInput());
    await waitFor(() => failed.getReviewStatus(REVIEW_ID).status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(failedDeletes, []);
  } finally {
    failed.close();
  }

  const expiredDeletes: string[] = [];
  const expired = new ReviewReturnController(
    {
      launchWebConversation: async () => launchAcknowledgement(),
      deleteWebConversation: async (identity) => {
        expiredDeletes.push(identity);
        return "deleted";
      },
    },
    {
      reviewIdFactory: () => REVIEW_ID,
      challengeFactory: () => CHALLENGE,
      executionSurface: "chatshare",
      now: () => new Date(START_TIME),
      timeoutMs: 25,
      retentionMs: 1_000,
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 50,
    },
  );
  try {
    expired.startReview(startInput());
    await waitFor(() => expired.getReviewStatus(REVIEW_ID).status === "expired", 500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(expiredDeletes, []);
  } finally {
    expired.close();
  }
});

test("launch may arrive before callback", async () => {
  let launched = false;
  const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
  const review = controller(
    {
      launchWebConversation: async () => {
        launched = true;
        return launchAcknowledgement();
      },
    },
    () => times.shift() ?? new Date(CALLBACK_TIME),
  );
  try {
    review.startReview(startInput());
    await waitFor(() => launched);
    assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
    review.submitReview(validCallback());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
  } finally {
    review.close();
  }
});

test("launch failure is retained as fail-closed state", async () => {
  const review = controller({
    launchWebConversation: async () => {
      throw new Error("browser unavailable");
    },
  });
  try {
    review.startReview(startInput());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "failed");
    const status = review.getReviewStatus(REVIEW_ID);
    assert.equal(status.status, "failed");
    if (status.status !== "failed") throw new Error("unexpected status");
    assert.equal(status.failureCode, "launch_failed");
    assert.throws(() => review.submitReview(validCallback()), /unknown, expired, or already consumed/);
  } finally {
    review.close();
  }
});

test("pending reviews expire and consume their challenge", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  const review = controller(
    {
      launchWebConversation: async () => launch.promise,
    },
    () => new Date(START_TIME),
    25,
  );
  try {
    review.startReview(startInput());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "expired", 500);
    assert.throws(() => review.submitReview(validCallback()), /unknown, expired, or already consumed/);
  } finally {
    review.close();
  }
});

test("MCP exposes review tools with challenge-only callback schema and completes a review", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-review-return-test-"));
  const config = testConfig(parent);
  let launchedPrompt = "";

  const browser = {
    launchWebConversation: async (prompt: string) => {
      launchedPrompt = prompt;
      return launchAcknowledgement();
    },
  };

  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const server = createMcpServer(config, workspaces, reviewCheckpoints, browser);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "review-return-client", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "review_start",
      "review_status",
      "review_submit",
      "saw_review_start",
      "saw_review_status",
    ]) {
      assert.ok(byName.has(name), `missing ${name}`);
    }

    const reviewStartProperties = Object.keys(
      (byName.get("review_start")?.inputSchema.properties ?? {}) as Record<string, unknown>,
    ).sort();
    assert.deepEqual(reviewStartProperties, [
      "candidateManifest",
      "candidateManifestDigest",
      "evidenceManifest",
      "evidenceManifestDigest",
      "role",
    ]);

    const submitProperties = Object.keys(
      (byName.get("review_submit")?.inputSchema.properties ?? {}) as Record<string, unknown>,
    ).sort();
    assert.deepEqual(submitProperties, ["challenge", "findings", "result", "summary"]);

    const start = await client.callTool({
      name: "review_start",
      arguments: startInput(),
    });
    const started = start.structuredContent as { reviewId: string };
    await waitFor(() => launchedPrompt.length > 0);
    const challenge = /challenge: ([0-9a-f]{64})/.exec(launchedPrompt)?.[1];
    assert.ok(challenge);

    await client.callTool({
      name: "review_submit",
      arguments: {
        challenge,
        result: "pass",
        summary: "Independent PRODUCT review passed.",
        findings: [],
      },
    });

    let finalStatus = "";
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const status = await client.callTool({
        name: "review_status",
        arguments: { reviewId: started.reviewId },
      });
      finalStatus = String(
        (status.structuredContent as { status?: string } | undefined)?.status ?? "",
      );
      if (finalStatus === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(finalStatus, "succeeded");
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});


test("review state survives across independent MCP sessions when controller is origin-scoped", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-review-return-cross-session-"));
  const config = testConfig(parent);
  let launchedPrompt = "";

  const browser = {
    launchWebConversation: async (prompt: string) => {
      launchedPrompt = prompt;
      return launchAcknowledgement();
    },
  };
  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const reviewReturnController = new ReviewReturnController(browser, {
    retentionMs: 1_000,
  });

  const serverA = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    undefined,
    undefined,
    undefined,
    { reviewReturnController },
  );
  const serverB = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    undefined,
    undefined,
    undefined,
    { reviewReturnController },
  );
  const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  const clientA = new Client({ name: "review-source", version: "1.0.0" });
  const clientB = new Client({ name: "review-callback", version: "1.0.0" });

  try {
    await Promise.all([
      serverA.connect(serverTransportA),
      clientA.connect(clientTransportA),
      serverB.connect(serverTransportB),
      clientB.connect(clientTransportB),
    ]);

    const start = await clientA.callTool({
      name: "review_start",
      arguments: startInput(),
    });
    const reviewId = String(
      (start.structuredContent as { reviewId?: string } | undefined)?.reviewId ?? "",
    );
    assert.match(reviewId, /^[0-9a-f]{64}$/);

    await waitFor(() => launchedPrompt.length > 0);
    const challenge = /challenge: ([0-9a-f]{64})/.exec(launchedPrompt)?.[1];
    assert.ok(challenge);

    await clientB.callTool({
      name: "review_submit",
      arguments: {
        challenge,
        result: "pass",
        summary: "Independent callback session accepted.",
        findings: [],
      },
    });

    let statusValue = "";
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const status = await clientA.callTool({
        name: "review_status",
        arguments: { reviewId },
      });
      statusValue = String(
        (status.structuredContent as { status?: string } | undefined)?.status ?? "",
      );
      if (statusValue === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(statusValue, "succeeded");
  } finally {
    reviewReturnController.close();
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await serverA.close().catch(() => undefined);
    await serverB.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("SAW A/B/C review set keeps independent roles, challenges, conversations, and ChatShare provenance", async () => {
  const reviewIds = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
  const challenges = ["4".repeat(64), "5".repeat(64), "6".repeat(64)];
  const conversationHashes = ["7".repeat(64), "8".repeat(64), "9".repeat(64)];
  const prompts: string[] = [];
  const stopped: string[] = [];
  const deleted: string[] = [];
  let launchIndex = 0;

  const review = new ReviewReturnController(
    {
      launchWebConversation: async (prompt, options) => {
        assert.equal(options?.attachDevSpace, true);
        prompts.push(prompt);
        const conversationIdentitySha256 = conversationHashes[launchIndex++];
        assert.ok(conversationIdentitySha256);
        return {
          ...launchAcknowledgement(),
          conversationIdentitySha256,
        };
      },
      stopWebConversationRecovery: (identity) => {
        stopped.push(identity);
        return true;
      },
      deleteWebConversation: async (identity) => {
        deleted.push(identity);
        return "deleted";
      },
    },
    {
      reviewIdFactory: () => {
        const reviewId = reviewIds.shift();
        assert.ok(reviewId);
        return reviewId;
      },
      challengeFactory: () => {
        const challenge = challenges.shift();
        assert.ok(challenge);
        return challenge;
      },
      batchIdFactory: () => "saw-batch-test",
      executionSurface: "chatshare",
      now: () => new Date(START_TIME),
      timeoutMs: 1_000,
      retentionMs: 1_000,
      cleanupSucceededConversations: true,
      cleanupDelayMs: 1,
      cleanupRetryMs: 5,
      cleanupWatchMs: 100,
    },
  );

  try {
    const started = review.startSawReviewSet(startInput());
    assert.equal(started.batchId, "saw-batch-test");
    assert.equal(started.executionSurface, "chatshare");
    assert.deepEqual(
      started.reviews.map((item) => item.role),
      ["SAW_A", "SAW_B", "SAW_C"],
    );
    assert.deepEqual(
      started.reviews.map((item) => item.rolePolicyDigest),
      [
        REVIEW_ROLE_POLICY_DIGESTS.SAW_A,
        REVIEW_ROLE_POLICY_DIGESTS.SAW_B,
        REVIEW_ROLE_POLICY_DIGESTS.SAW_C,
      ],
    );
    assert.equal(review.getSawReviewSetStatus(started.batchId).status, "pending");

    await waitFor(() => prompts.length === 3);
    assert.match(prompts[0] ?? "", /REVIEW-RETURN-2 SAW_A review packet/);
    assert.match(prompts[1] ?? "", /REVIEW-RETURN-2 SAW_B review packet/);
    assert.match(prompts[2] ?? "", /REVIEW-RETURN-2 SAW_C review packet/);
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /previous reviewer output:\s*pass/i);
    }

    const callbackChallenges = prompts.map(
      (prompt) => /challenge: ([0-9a-f]{64})/.exec(prompt)?.[1],
    );
    assert.equal(new Set(callbackChallenges).size, 3);

    const verdicts = ["pass", "abstain", "fail"] as const;
    callbackChallenges.forEach((challenge, index) => {
      assert.ok(challenge);
      review.submitReview({
        challenge,
        result: verdicts[index]!,
        summary: `Independent SAW reviewer ${index + 1} completed.`,
        findings: [],
      });
    });

    await waitFor(
      () => review.getSawReviewSetStatus(started.batchId).status === "succeeded",
    );
    const finalStatus = review.getSawReviewSetStatus(started.batchId);
    assert.equal(finalStatus.status, "succeeded");
    assert.equal(finalStatus.result, "fail");
    assert.deepEqual(
      finalStatus.reviews.map((item) => item.role),
      ["SAW_A", "SAW_B", "SAW_C"],
    );
    assert.deepEqual(
      finalStatus.reviews.map((item) => item.executionSurface),
      ["chatshare", "chatshare", "chatshare"],
    );
    assert.deepEqual(
      finalStatus.reviews.map((item) =>
        item.status === "succeeded" ? item.conversationIdentitySha256 : null,
      ),
      conversationHashes,
    );
    assert.deepEqual(stopped, conversationHashes);
    await waitFor(() => deleted.length === 3, 500);
    assert.deepEqual(deleted, conversationHashes);
  } finally {
    review.close();
  }
});

test("one SAW launch failure fails the gate without contaminating sibling reviewers", async () => {
  const reviewIds = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const challenges = ["d".repeat(64), "e".repeat(64), "f".repeat(64)];
  const successfulConversationHashes = ["1".repeat(64), "2".repeat(64)];
  const prompts: string[] = [];
  let launchAttempt = 0;

  const review = new ReviewReturnController(
    {
      launchWebConversation: async (prompt) => {
        prompts.push(prompt);
        launchAttempt += 1;
        if (launchAttempt === 1) {
          throw new Error("synthetic first reviewer launch failure");
        }
        const conversationIdentitySha256 =
          successfulConversationHashes[launchAttempt - 2];
        assert.ok(conversationIdentitySha256);
        return {
          ...launchAcknowledgement(),
          conversationIdentitySha256,
        };
      },
    },
    {
      reviewIdFactory: () => {
        const reviewId = reviewIds.shift();
        assert.ok(reviewId);
        return reviewId;
      },
      challengeFactory: () => {
        const challenge = challenges.shift();
        assert.ok(challenge);
        return challenge;
      },
      batchIdFactory: () => "saw-failure-isolation",
      executionSurface: "chatshare",
      timeoutMs: 1_000,
      retentionMs: 1_000,
    },
  );

  try {
    const started = review.startSawReviewSet(startInput());
    await waitFor(() => prompts.length === 3);

    const afterLaunches = review.getSawReviewSetStatus(started.batchId);
    assert.equal(afterLaunches.status, "failed");
    assert.equal(afterLaunches.reviews[0]?.status, "failed");
    assert.equal(afterLaunches.reviews[1]?.status, "pending");
    assert.equal(afterLaunches.reviews[2]?.status, "pending");

    for (const prompt of prompts.slice(1)) {
      const challenge = /challenge: ([0-9a-f]{64})/.exec(prompt)?.[1];
      assert.ok(challenge);
      review.submitReview({
        challenge,
        result: "pass",
        summary: "Sibling SAW reviewer completed independently.",
        findings: [],
      });
    }

    await waitFor(() => {
      const status = review.getSawReviewSetStatus(started.batchId);
      return status.reviews.slice(1).every((item) => item.status === "succeeded");
    });

    const finalStatus = review.getSawReviewSetStatus(started.batchId);
    assert.equal(finalStatus.status, "failed");
    assert.equal(finalStatus.result, undefined);
    assert.deepEqual(
      finalStatus.reviews.map((item) => item.status),
      ["failed", "succeeded", "succeeded"],
    );
  } finally {
    review.close();
  }
});
