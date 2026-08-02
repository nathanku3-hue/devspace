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
  ReviewReturnController,
  ReviewReturnError,
  type ReviewStructuredResult,
} from "./review-return.js";
import { createMcpServer } from "./server.js";
import { WebConnectorProofController } from "./web-connector-proof.js";
import type {
  WebLaunchAcknowledgement,
  WebLaunchBrowserController,
} from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

const REVIEW_ID = "a".repeat(64);
const CANDIDATE_DIGEST = "b".repeat(64);
const EVIDENCE_DIGEST = "c".repeat(64);
const POLICY_DIGEST = "d".repeat(64);
const CONVERSATION_HASH = "e".repeat(64);
const START_TIME = "2026-08-02T08:00:00.000Z";
const CALLBACK_TIME = "2026-08-02T08:00:05.000Z";
const REVIEWED_AT = "2026-08-02T08:00:04.000Z";

function launchAcknowledgement(): WebLaunchAcknowledgement {
  return {
    slice: "WEB-LAUNCH-0",
    launchSuccess: true,
    conversationIdentitySha256: CONVERSATION_HASH,
    timestamp: "2026-08-02T08:00:01.000Z",
    assistantOutputCaptured: false,
  };
}

function digests() {
  return {
    candidateManifestDigest: CANDIDATE_DIGEST,
    evidenceManifestDigest: EVIDENCE_DIGEST,
    rolePolicyDigest: POLICY_DIGEST,
  };
}

function validSubmission(overrides: Partial<ReviewStructuredResult> = {}): ReviewStructuredResult {
  return {
    reviewId: REVIEW_ID,
    role: "PRODUCT",
    result: "pass",
    summary: "Minimum structured PRODUCT review.",
    findings: [
      {
        severity: "advisory",
        claim: "Transport returns structured result.",
        evidenceRef: "sha256:fixture-evidence",
      },
    ],
    reviewedAt: REVIEWED_AT,
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

test("REVIEW-RETURN-2 prompt is fixed, names PRODUCT, and binds digests", () => {
  const prompt = buildReviewReturnPrompt({
    reviewId: REVIEW_ID,
    ...digests(),
  });
  assert.match(prompt, /REVIEW-RETURN-2 PRODUCT review packet/);
  assert.match(prompt, /review_submit/);
  assert.match(prompt, new RegExp(REVIEW_ID));
  assert.match(prompt, new RegExp(CANDIDATE_DIGEST));
  assert.match(prompt, new RegExp(EVIDENCE_DIGEST));
  assert.match(prompt, new RegExp(POLICY_DIGEST));
  assert.match(prompt, /Do not include previous reviewer output/);
  assert.doesNotMatch(prompt, /web_connector_probe/);
});

test("start retains the review and returns before browser launch resolves", async () => {
  const launch = deferred<WebLaunchAcknowledgement>();
  const prompts: string[] = [];
  const browser = {
    launchWebConversation: async (prompt: string) => {
      prompts.push(prompt);
      return launch.promise;
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const review = new ReviewReturnController(browser, {
    reviewIdFactory: () => REVIEW_ID,
    now: () => new Date(START_TIME),
    timeoutMs: 1_000,
    retentionMs: 1_000,
  });

  try {
    const started = review.startReview(digests());
    assert.deepEqual(started, {
      slice: "REVIEW-RETURN-2",
      reviewId: REVIEW_ID,
      role: "PRODUCT",
      status: "pending",
      startedAt: START_TIME,
      expiresAt: "2026-08-02T08:00:01.000Z",
      ...digests(),
      assistantOutputCaptured: false,
    });
    assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
    assert.equal(prompts.length, 0);
    await Promise.resolve();
    assert.equal(prompts.length, 1);
    assert.throws(() => review.startReview(digests()), /in progress|duplicate/);
    launch.resolve(launchAcknowledgement());
  } finally {
    review.close();
  }
});

test("callback and launch acknowledgement may arrive in either order", async (t) => {
  await t.test("callback first", async () => {
    const launch = deferred<WebLaunchAcknowledgement>();
    const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
    const review = new ReviewReturnController(
      { launchWebConversation: async () => launch.promise },
      {
        reviewIdFactory: () => REVIEW_ID,
        now: () => times.shift() ?? new Date(CALLBACK_TIME),
        timeoutMs: 1_000,
        retentionMs: 1_000,
      },
    );

    try {
      review.startReview(digests());
      review.submitReview(validSubmission());
      assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
      launch.resolve(launchAcknowledgement());
      await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
      const status = review.getReviewStatus(REVIEW_ID);
      assert.equal(status.status, "succeeded");
      assert.equal(status.assistantOutputCaptured, false);
      assert.deepEqual(
        {
          reviewId: (status as { reviewId: string }).reviewId,
          role: (status as { role: string }).role,
          result: (status as { result: string }).result,
          summary: (status as { summary: string }).summary,
          findings: (status as { findings: unknown }).findings,
          reviewedAt: (status as { reviewedAt: string }).reviewedAt,
          candidateManifestDigest: (status as { candidateManifestDigest: string })
            .candidateManifestDigest,
          evidenceManifestDigest: (status as { evidenceManifestDigest: string })
            .evidenceManifestDigest,
          rolePolicyDigest: (status as { rolePolicyDigest: string }).rolePolicyDigest,
          conversationIdentitySha256: (status as { conversationIdentitySha256: string })
            .conversationIdentitySha256,
          callbackTimestamp: (status as { callbackTimestamp: string }).callbackTimestamp,
        },
        {
          ...validSubmission(),
          ...digests(),
          conversationIdentitySha256: CONVERSATION_HASH,
          callbackTimestamp: CALLBACK_TIME,
        },
      );
    } finally {
      review.close();
    }
  });

  await t.test("launch first", async () => {
    const times = [new Date(START_TIME), new Date(CALLBACK_TIME)];
    let launchReturned = false;
    const review = new ReviewReturnController(
      {
        launchWebConversation: async () => {
          launchReturned = true;
          return launchAcknowledgement();
        },
      },
      {
        reviewIdFactory: () => REVIEW_ID,
        now: () => times.shift() ?? new Date(CALLBACK_TIME),
        timeoutMs: 1_000,
        retentionMs: 1_000,
      },
    );

    try {
      review.startReview(digests());
      await waitFor(() => launchReturned);
      assert.equal(review.getReviewStatus(REVIEW_ID).status, "pending");
      review.submitReview(validSubmission());
      await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "succeeded");
      assert.throws(() => review.submitReview(validSubmission()), /already consumed|unknown/);
    } finally {
      review.close();
    }
  });
});

test("schema and binding validation fail closed", () => {
  const review = new ReviewReturnController(
    { launchWebConversation: async () => launchAcknowledgement() },
    {
      reviewIdFactory: () => REVIEW_ID,
      now: () => new Date(START_TIME),
      timeoutMs: 1_000,
      retentionMs: 1_000,
    },
  );

  try {
    review.startReview(digests());
    assert.throws(
      () => review.submitReview(validSubmission({ role: "STRATEGY" as "PRODUCT" })),
      /PRODUCT/,
    );
    assert.throws(
      () => review.submitReview(validSubmission({ result: "maybe" as "pass" })),
      /pass.*fail.*abstain/,
    );
    assert.throws(
      () => review.submitReview(validSubmission({ summary: "" })),
      /summary/,
    );
    assert.throws(
      () => review.submitReview(validSubmission({ reviewId: "0".repeat(64) })),
      /unknown|expired|completed/,
    );
    assert.throws(
      () =>
        review.startReview({
          ...digests(),
          candidateManifestDigest: "not-a-digest",
        }),
      /candidateManifestDigest/,
    );
  } finally {
    review.close();
  }
});

test("launch failure remains retrievable", async () => {
  const review = new ReviewReturnController(
    { launchWebConversation: async () => Promise.reject(new Error("browser failed")) },
    {
      reviewIdFactory: () => REVIEW_ID,
      now: () => new Date(START_TIME),
      timeoutMs: 1_000,
      retentionMs: 1_000,
    },
  );

  try {
    review.startReview(digests());
    await waitFor(() => review.getReviewStatus(REVIEW_ID).status === "failed");
    assert.equal(
      (review.getReviewStatus(REVIEW_ID) as { failureCode?: string }).failureCode,
      "launch_failed",
    );
    assert.throws(() => review.submitReview(validSubmission()), /unknown|expired|completed/);
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
    assert.ok(listed.tools.some((tool) => tool.name === "review_start"));
    assert.ok(listed.tools.some((tool) => tool.name === "review_submit"));
    assert.ok(listed.tools.some((tool) => tool.name === "review_status"));
    const submit = listed.tools.find((tool) => tool.name === "review_submit");
    assert.ok(submit);
    assert.equal(submit.annotations?.readOnlyHint, false);
    assert.equal(submit.annotations?.idempotentHint, false);

    const startResult = await sourceClient.callTool({
      name: "review_start",
      arguments: digests(),
    });
    assert.deepEqual(startResult.structuredContent, {
      slice: "REVIEW-RETURN-2",
      reviewId: REVIEW_ID,
      role: "PRODUCT",
      status: "pending",
      startedAt: START_TIME,
      expiresAt: "2026-08-02T08:00:01.000Z",
      ...digests(),
      assistantOutputCaptured: false,
    });
    const prompt = await promptReady;
    assert.match(prompt, new RegExp(REVIEW_ID));

    await sourceClient.close();
    await sourceServer.close();

    const submitResult = await spawnedClient.callTool({
      name: "review_submit",
      arguments: validSubmission(),
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
    assert.equal(
      (statusResult.structuredContent as { status?: string }).status,
      "succeeded",
    );
    assert.equal(
      (statusResult.structuredContent as { assistantOutputCaptured?: boolean })
        .assistantOutputCaptured,
      false,
    );
    assert.equal(
      (statusResult.structuredContent as { conversationIdentitySha256?: string })
        .conversationIdentitySha256,
      CONVERSATION_HASH,
    );
    assert.equal(
      (statusResult.structuredContent as { result?: string }).result,
      "pass",
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
