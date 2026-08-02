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
  ReviewReturnController,
  ReviewReturnError,
  sha256Hex,
  type ReviewCallbackInput,
} from "./review-return.js";
import { createMcpServer } from "./server.js";
import { WebConnectorProofController } from "./web-connector-proof.js";
import type {
  WebLaunchAcknowledgement,
  WebLaunchBrowserController,
} from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

const REVIEW_ID = "a".repeat(64);
const CHALLENGE = "f".repeat(64);
const CANDIDATE_MANIFEST = "candidate: ship review return with packet content";
const EVIDENCE_MANIFEST = "evidence: fixture-1 proves structured return";
const CANDIDATE_DIGEST = sha256Hex(CANDIDATE_MANIFEST);
const EVIDENCE_DIGEST = sha256Hex(EVIDENCE_MANIFEST);
const CONVERSATION_HASH = "e".repeat(64);
const START_TIME = "2026-08-02T08:00:00.000Z";
const CALLBACK_TIME = "2026-08-02T08:00:05.000Z";

function launchAcknowledgement(): WebLaunchAcknowledgement {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: CONVERSATION_HASH,
    timestamp: "2026-08-02T08:00:01.000Z",
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

function validCallback(overrides: Partial<ReviewCallbackInput> = {}): ReviewCallbackInput {
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

function testConfig(parent: string, minimalTools = false): ServerConfig {
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
    minimalTools,
    toolNaming: "short",
    widgets: "off",
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
  browser: Pick<WebLaunchBrowserController, "launchWebConversation">,
  now: () => Date = () => new Date(START_TIME),
): ReviewReturnController {
  return new ReviewReturnController(browser, {
    reviewIdFactory: () => REVIEW_ID,
    challengeFactory: () => CHALLENGE,
    now,
    timeoutMs: 1_000,
    retentionMs: 1_000,
  });
}

test("exact manifest bytes and PRODUCT policy appear in the fixed prompt", () => {
  const prompt = buildReviewReturnPrompt({
    challenge: CHALLENGE,
    candidateManifest: CANDIDATE_MANIFEST,
    candidateManifestDigest: CANDIDATE_DIGEST,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceManifestDigest: EVIDENCE_DIGEST,
    rolePolicy: PRODUCT_ROLE_POLICY,
    rolePolicyDigest: PRODUCT_ROLE_POLICY_DIGEST,
  });
  assert.match(prompt, new RegExp(CANDIDATE_MANIFEST));
  assert.match(prompt, new RegExp(EVIDENCE_MANIFEST));
  assert.match(prompt, new RegExp(PRODUCT_ROLE_POLICY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, new RegExp(CHALLENGE));
  assert.doesNotMatch(prompt, new RegExp(REVIEW_ID));
  assert.match(prompt, /challenge:/);
  assert.doesNotMatch(prompt, /reviewId:/);
  assert.match(prompt, /Do not supply reviewId, role, rolePolicyDigest, or reviewedAt/);
});

test("supplied digests must match exact manifest content", () => {
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

test("source-visible reviewId cannot authorize submission", () => {
  const review = controller({
    launchWebConversation: async () => launchAcknowledgement(),
  });
  try {
    const started = review.startReview(startInput());
    assert.equal(started.reviewId, REVIEW_ID);
    assert.throws(
      () =>
        review.submitReview({
          ...validCallback(),
          challenge: REVIEW_ID,
        }),
      /unknown, expired, or already consumed/,
    );
    assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
  } finally {
    review.close();
  }
});

test("unknown and reused challenges fail closed", async () => {
  const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
  const review = controller(
    { launchWebConversation: async () => launchAcknowledgement() },
    () => times.shift() ?? new Date(CALLBACK_TIME),
  );
  try {
    review.startReview(startInput());
    assert.throws(
      () => review.submitReview(validCallback({ challenge: "9".repeat(64) })),
      /unknown, expired, or already consumed/,
    );
    review.submitReview(validCallback());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
    assert.throws(
      () => review.submitReview(validCallback()),
      /unknown, expired, or already consumed/,
    );
  } finally {
    review.close();
  }
});

test("role, timestamps, and policy digest are server-owned", async () => {
  const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
  const review = controller(
    { launchWebConversation: async () => launchAcknowledgement() },
    () => times.shift() ?? new Date(CALLBACK_TIME),
  );
  try {
    const started = review.startReview(startInput());
    assert.equal(started.role, "PRODUCT");
    assert.equal(started.rolePolicyDigest, PRODUCT_ROLE_POLICY_DIGEST);
    assert.equal("challenge" in started, false);

    const accepted = review.submitReview(validCallback());
    assert.equal(accepted.reviewId, REVIEW_ID);
    assert.equal(accepted.timestamp, CALLBACK_TIME);

    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
    const status = review.getReviewStatus(REVIEW_ID) as {
      role: string;
      reviewedAt: string;
      callbackTimestamp: string;
      rolePolicyDigest: string;
      conversationIdentitySha256: string;
      result: string;
      summary: string;
    };
    assert.equal(status.role, "PRODUCT");
    assert.equal(status.reviewedAt, CALLBACK_TIME);
    assert.equal(status.callbackTimestamp, CALLBACK_TIME);
    assert.equal(status.rolePolicyDigest, PRODUCT_ROLE_POLICY_DIGEST);
    assert.equal(status.conversationIdentitySha256, CONVERSATION_HASH);
    assert.equal(status.result, "pass");
    assert.match(status.summary, /packet content/);
  } finally {
    review.close();
  }
});

test("callback and launch acknowledgement may arrive in either order", async (t) => {
  await t.test("callback first", async () => {
    const launch = deferred<WebLaunchAcknowledgement>();
    const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
    const review = controller(
      { launchWebConversation: async () => launch.promise },
      () => times.shift() ?? new Date(CALLBACK_TIME),
    );

    try {
      review.startReview(startInput());
      review.submitReview(validCallback());
      assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
      launch.resolve(launchAcknowledgement());
      await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
      assert.equal(
        (review.getReviewStatus(REVIEW_ID) as { conversationIdentitySha256: string })
          .conversationIdentitySha256,
        CONVERSATION_HASH,
      );
    } finally {
      review.close();
    }
  });

  await t.test("launch first", async () => {
    const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
    let launchReturned = false;
    const review = controller(
      {
        launchWebConversation: async () => {
          launchReturned = true;
          return launchAcknowledgement();
        },
      },
      () => times.shift() ?? new Date(CALLBACK_TIME),
    );

    try {
      review.startReview(startInput());
      await waitFor(() => launchReturned);
      assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
      review.submitReview(validCallback());
      await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
    } finally {
      review.close();
    }
  });
});

test("start returns before launch and prompt contains challenge not reviewId", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  const prompts: string[] = [];
  const review = controller({
    launchWebConversation: async (prompt: string) => {
      prompts.push(prompt);
      return launch.promise;
    },
  });

  try {
    const started = review.startReview(startInput());
    assert.deepEqual(started, {
      slice: "REVIEW-RETURN-2",
      reviewId: REVIEW_ID,
      role: "PRODUCT",
      status: "pending",
      startedAt: START_TIME,
      expiresAt: "2026-08-02T08:00:01.000Z",
      candidateManifestDigest: CANDIDATE_DIGEST,
      evidenceManifestDigest: EVIDENCE_DIGEST,
      rolePolicyDigest: PRODUCT_ROLE_POLICY_DIGEST,
      assistantOutputCaptured: false,
    });
    assert.equal(prompts.length, 0);
    await Promise.resolve();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, new RegExp(CHALLENGE));
    assert.match(prompts[0]!, new RegExp(CANDIDATE_MANIFEST));
    assert.match(prompts[0]!, new RegExp(EVIDENCE_MANIFEST));
    assert.doesNotMatch(prompts[0]!, new RegExp(REVIEW_ID));
    assert.throws(() => review.startReview(startInput()), /in progress|duplicate/);
    launch.resolve(launchAcknowledgement());
  } finally {
    review.close();
  }
});

test("independent sessions survive source disconnect and retrieve the structured result", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-review-return-tool-"));
  const config = testConfig(parent, true);
  let releasePrompt: ((prompt: string) => void) | undefined;
  const promptReady = new Promise<string>((resolve) => {
    releasePrompt = resolve;
  });
  const browser = {
    launchWebConversation: async (prompt: string) => {
      releasePrompt?.(prompt);
      return launchAcknowledgement();
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
  const review = new ReviewReturnController(browser, {
    reviewIdFactory: () => REVIEW_ID,
    challengeFactory: () => CHALLENGE,
    now: () => times.shift() ?? new Date(CALLBACK_TIME),
    timeoutMs: 1_000,
    retentionMs: 1_000,
  });
  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const connector = new WebConnectorProofController(browser);
  const sourceServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
  );
  const spawnedServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
  );
  const statusServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
  );
  const sourceClient = new Client({ name: "review-return-source", version: "1.0.0" });
  const spawnedClient = new Client({ name: "review-return-spawned", version: "1.0.0" });
  const statusClient = new Client({ name: "review-return-status", version: "1.0.0" });
  const [sourceClientTransport, sourceServerTransport] = InMemoryTransport.createLinkedPair();
  const [spawnedClientTransport, spawnedServerTransport] = InMemoryTransport.createLinkedPair();
  const [statusClientTransport, statusServerTransport] = InMemoryTransport.createLinkedPair();

  try {
    await sourceServer.connect(sourceServerTransport);
    await spawnedServer.connect(spawnedServerTransport);
    await statusServer.connect(statusServerTransport);
    await sourceClient.connect(sourceClientTransport);
    await spawnedClient.connect(spawnedClientTransport);
    await statusClient.connect(statusClientTransport);

    const listed = await spawnedClient.listTools();
    const submit = listed.tools.find((tool) => tool.name === "review_submit");
    const start = listed.tools.find((tool) => tool.name === "review_start");
    assert.ok(submit);
    assert.ok(start);
    assert.deepEqual(Object.keys(submit.inputSchema.properties ?? {}).sort(), [
      "challenge",
      "findings",
      "result",
      "summary",
    ]);
    assert.deepEqual(Object.keys(start.inputSchema.properties ?? {}).sort(), [
      "candidateManifest",
      "candidateManifestDigest",
      "evidenceManifest",
      "evidenceManifestDigest",
    ]);

    const startResult = await sourceClient.callTool({
      name: "review_start",
      arguments: startInput(),
    });
    assert.equal(
      (startResult.structuredContent as { reviewId?: string }).reviewId,
      REVIEW_ID,
    );
    assert.equal(
      (startResult.structuredContent as { rolePolicyDigest?: string }).rolePolicyDigest,
      PRODUCT_ROLE_POLICY_DIGEST,
    );

    const prompt = await promptReady;
    assert.match(prompt, new RegExp(CHALLENGE));
    assert.match(prompt, new RegExp(CANDIDATE_MANIFEST));
    assert.doesNotMatch(prompt, new RegExp(REVIEW_ID));

    await sourceClient.close();
    await sourceServer.close();

    const submitResult = await spawnedClient.callTool({
      name: "review_submit",
      arguments: validCallback(),
    });
    assert.deepEqual(submitResult.structuredContent, {
      slice: "REVIEW-RETURN-2",
      reviewAccepted: true,
      reviewId: REVIEW_ID,
      timestamp: CALLBACK_TIME,
    });

    const statusResult = await statusClient.callTool({
      name: "review_status",
      arguments: { reviewId: REVIEW_ID },
    });
    assert.equal((statusResult.structuredContent as { status?: string }).status, "succeeded");
    assert.equal(
      (statusResult.structuredContent as { role?: string }).role,
      "PRODUCT",
    );
    assert.equal(
      (statusResult.structuredContent as { reviewedAt?: string }).reviewedAt,
      CALLBACK_TIME,
    );
    assert.equal(
      (statusResult.structuredContent as { conversationIdentitySha256?: string })
        .conversationIdentitySha256,
      CONVERSATION_HASH,
    );
  } finally {
    review.close();
    connector.close();
    await sourceClient.close().catch(() => undefined);
    await spawnedClient.close().catch(() => undefined);
    await statusClient.close().catch(() => undefined);
    await sourceServer.close().catch(() => undefined);
    await spawnedServer.close().catch(() => undefined);
    await statusServer.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("ReviewReturnError is distinct and typed", () => {
  const error = new ReviewReturnError("boom");
  assert.equal(error.name, "ReviewReturnError");
  assert.ok(error instanceof Error);
});
