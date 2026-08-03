import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import {
  buildWebChatPrompt,
  WebChatController,
  WebChatError,
} from "./web-chat.js";
import type {
  RetainedWebConversationHandle,
  WebLaunchAcknowledgement,
  WebLaunchBrowserController,
} from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

const CHAT_ID = "a".repeat(64);
const CHALLENGE_1 = "b".repeat(64);
const CHALLENGE_2 = "c".repeat(64);
const CONVERSATION_HASH = "d".repeat(64);

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

function challengeFromPrompt(prompt: string): string {
  const match = prompt.match(/^challenge: ([0-9a-f]{64})$/m);
  assert.ok(match);
  return match[1]!;
}

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "web-chat-test-owner-token",
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

test("prompt binds one challenge and turn around the exact source message", () => {
  const prompt = buildWebChatPrompt({
    challenge: CHALLENGE_1,
    turn: 1,
    message: "Remember nonce TEST-42.",
  });
  assert.match(prompt, /WEB-CHAT-3 turn 1/);
  assert.match(prompt, new RegExp(CHALLENGE_1));
  assert.match(prompt, /----- BEGIN SOURCE MESSAGE -----\nRemember nonce TEST-42\.\n----- END SOURCE MESSAGE -----/);
  assert.match(prompt, /web_chat_reply/);
  assert.doesNotMatch(prompt, new RegExp(CHAT_ID));
});

test("two turns share one retained handle and callbacks may precede delivery completion", async () => {
  const launch = deferred<RetainedWebConversationHandle>();
  const secondDelivery = deferred<void>();
  const launchPrompts: string[] = [];
  const sentPrompts: string[] = [];
  let closeCount = 0;
  const handle: RetainedWebConversationHandle = {
    conversationIdentitySha256: CONVERSATION_HASH,
    send: async (prompt) => {
      sentPrompts.push(prompt);
      await secondDelivery.promise;
    },
    close: async () => {
      closeCount += 1;
    },
  };
  const challenges = [CHALLENGE_1, CHALLENGE_2];
  const chat = new WebChatController(
    {
      launchRetainedWebConversation: async (prompt: string) => {
        launchPrompts.push(prompt);
        return launch.promise;
      },
    },
    {
      chatIdFactory: () => CHAT_ID,
      challengeFactory: () => challenges.shift() ?? "e".repeat(64),
      turnTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
  );

  try {
    const started = chat.startChat("Remember nonce TEST-42 and explain why it matters.");
    assert.equal(started.chatId, CHAT_ID);
    assert.throws(() => chat.startChat("second active chat"), /active chat/);
    await waitFor(() => launchPrompts.length === 1);
    assert.equal(challengeFromPrompt(launchPrompts[0]!), CHALLENGE_1);

    chat.acceptReply({
      challenge: CHALLENGE_1,
      turn: 1,
      message: "TEST-42 matters because it proves explicit memory binding.",
    });
    assert.equal(chat.getChatStatus(CHAT_ID).status, "pending");
    launch.resolve(handle);
    await waitFor(() => chat.getChatStatus(CHAT_ID).status === "ready");

    const first = chat.getChatStatus(CHAT_ID);
    assert.equal(first.completedTurn, 1);
    assert.equal(first.latestReply, "TEST-42 matters because it proves explicit memory binding.");
    assert.equal(first.conversationIdentitySha256, CONVERSATION_HASH);
    assert.throws(
      () =>
        chat.acceptReply({
          challenge: CHALLENGE_1,
          turn: 1,
          message: "replay",
        }),
      /unknown_challenge/,
    );

    const sent = chat.sendChat(
      CHAT_ID,
      "What nonce did I give you, and what was your reasoning?",
    );
    assert.equal(sent.turn, 2);
    await waitFor(() => sentPrompts.length === 1);
    assert.equal(challengeFromPrompt(sentPrompts[0]!), CHALLENGE_2);
    assert.throws(
      () => chat.sendChat(CHAT_ID, "overlapping turn"),
      /not ready/,
    );
    assert.throws(
      () =>
        chat.acceptReply({
          challenge: CHALLENGE_1,
          turn: 1,
          message: "stale turn",
        }),
      /unknown_challenge/,
    );
    assert.throws(
      () =>
        chat.acceptReply({
          challenge: CHALLENGE_2,
          turn: 3,
          message: "wrong turn",
        }),
      /wrong_turn/,
    );

    chat.acceptReply({
      challenge: CHALLENGE_2,
      turn: 2,
      message: "You gave TEST-42; I tied it to explicit memory binding in turn one.",
    });
    assert.equal(chat.getChatStatus(CHAT_ID).status, "pending");
    secondDelivery.resolve();
    await waitFor(() => chat.getChatStatus(CHAT_ID).status === "ready");

    const second = chat.getChatStatus(CHAT_ID);
    assert.equal(second.completedTurn, 2);
    assert.equal(second.currentTurn, 2);
    assert.match(second.latestReply ?? "", /TEST-42/);
    assert.equal(second.conversationIdentitySha256, CONVERSATION_HASH);

    const closed = await chat.closeChat(CHAT_ID);
    assert.equal(closed.closed, true);
    assert.equal(closed.completedTurn, 2);
    assert.equal(closed.conversationIdentitySha256, CONVERSATION_HASH);
    assert.equal(closeCount, 1);
    assert.equal(chat.getChatStatus(CHAT_ID).status, "closed");
  } finally {
    secondDelivery.resolve();
    launch.resolve(handle);
    await chat.close();
  }
});

test("expired turn consumes its challenge", async () => {
  const chat = new WebChatController(
    {
      launchRetainedWebConversation: async () => ({
        conversationIdentitySha256: CONVERSATION_HASH,
        send: async () => undefined,
        close: async () => undefined,
      }),
    },
    {
      chatIdFactory: () => CHAT_ID,
      challengeFactory: () => CHALLENGE_1,
      turnTimeoutMs: 20,
      idleTimeoutMs: 20,
    },
  );

  try {
    chat.startChat("Do not answer before expiry.");
    await waitFor(() => chat.getChatStatus(CHAT_ID).status === "expired", 500);
    assert.equal(chat.getChatStatus(CHAT_ID).failureCode, "expired");
    assert.throws(
      () =>
        chat.acceptReply({
          challenge: CHALLENGE_1,
          turn: 1,
          message: "late",
        }),
      /expired/,
    );
  } finally {
    await chat.close();
  }
});

test("independent MCP sessions complete two turns and permissive reply fields are ignored", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-web-chat-tool-"));
  const config = testConfig(parent);
  const launchedPrompts: string[] = [];
  const sentPrompts: string[] = [];
  let closeCount = 0;
  const retainedHandle: RetainedWebConversationHandle = {
    conversationIdentitySha256: CONVERSATION_HASH,
    send: async (prompt) => {
      sentPrompts.push(prompt);
    },
    close: async () => {
      closeCount += 1;
    },
  };
  const browser = {
    launchWebConversation: async (): Promise<WebLaunchAcknowledgement> => ({
      slice: "WEB-LAUNCH-0",
      launchSuccess: true,
      conversationIdentitySha256: CONVERSATION_HASH,
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false,
    }),
    launchRetainedWebConversation: async (prompt: string) => {
      launchedPrompts.push(prompt);
      return retainedHandle;
    },
  } as Pick<
    WebLaunchBrowserController,
    "launchWebConversation" | "launchRetainedWebConversation"
  >;
  const challenges = [CHALLENGE_1, CHALLENGE_2];
  const chat = new WebChatController(browser, {
    chatIdFactory: () => CHAT_ID,
    challengeFactory: () => challenges.shift() ?? "e".repeat(64),
    turnTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  });
  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const connector = {
    startConnectorAccess: () => {
      throw new Error("unexpected web_connector_start");
    },
    acceptProbe: () => {
      throw new Error("unexpected web_connector_probe");
    },
    getProofStatus: () => {
      throw new Error("unexpected web_connector_status");
    },
  };
  const review = {
    startReview: () => {
      throw new Error("unexpected review_start");
    },
    submitReview: () => {
      throw new Error("unexpected review_submit");
    },
    getReviewStatus: () => {
      throw new Error("unexpected review_status");
    },
  };
  const sourceServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
    chat,
  );
  const spawnedServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
    chat,
  );
  const statusServer = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    browser,
    connector,
    review,
    chat,
  );
  const sourceClient = new Client({ name: "web-chat-source", version: "1.0.0" });
  const spawnedClient = new Client({ name: "web-chat-spawned", version: "1.0.0" });
  const statusClient = new Client({ name: "web-chat-status", version: "1.0.0" });
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
    assert.equal(listed.tools.length, 21);
    for (const name of [
      "web_chat_start",
      "web_chat_send",
      "web_chat_status",
      "web_chat_close",
      "web_chat_reply",
    ]) {
      assert.ok(listed.tools.some((tool) => tool.name === name));
    }
    const replyTool = listed.tools.find((tool) => tool.name === "web_chat_reply");
    assert.ok(replyTool);
    assert.deepEqual(Object.keys(replyTool.inputSchema.properties ?? {}).sort(), [
      "challenge",
      "message",
      "turn",
    ]);
    assert.notEqual(replyTool.inputSchema.additionalProperties, false);

    const startResult = await sourceClient.callTool({
      name: "web_chat_start",
      arguments: { message: "Remember nonce TEST-42 and explain why it matters." },
    });
    assert.equal((startResult.structuredContent as { chatId?: string }).chatId, CHAT_ID);
    await waitFor(() => launchedPrompts.length === 1);

    await sourceClient.close();
    await sourceServer.close();

    const firstReply = await spawnedClient.callTool({
      name: "web_chat_reply",
      arguments: {
        challenge: challengeFromPrompt(launchedPrompts[0]!),
        turn: 1,
        message: "TEST-42 matters because it binds this conversation to a remembered fact.",
        chatId: "model-supplied-value-must-be-ignored",
        reasoning: "harmless extra field",
      },
    });
    assert.equal((firstReply.structuredContent as { replyAccepted?: boolean }).replyAccepted, true);
    await waitFor(() => chat.getChatStatus(CHAT_ID).status === "ready");

    const sendResult = await statusClient.callTool({
      name: "web_chat_send",
      arguments: {
        chatId: CHAT_ID,
        message: "What nonce did I give you, and what was your reasoning?",
      },
    });
    assert.equal((sendResult.structuredContent as { turn?: number }).turn, 2);
    await waitFor(() => sentPrompts.length === 1);

    await spawnedClient.callTool({
      name: "web_chat_reply",
      arguments: {
        challenge: challengeFromPrompt(sentPrompts[0]!),
        turn: 2,
        message: "You gave TEST-42; I said it binds the conversation to a remembered fact.",
        extra: { ignored: true },
      },
    });
    await waitFor(() => chat.getChatStatus(CHAT_ID).status === "ready");

    const statusResult = await statusClient.callTool({
      name: "web_chat_status",
      arguments: { chatId: CHAT_ID },
    });
    const status = statusResult.structuredContent as Record<string, unknown>;
    assert.equal(status.status, "ready");
    assert.equal(status.completedTurn, 2);
    assert.equal(status.currentTurn, 2);
    assert.equal(status.conversationIdentitySha256, CONVERSATION_HASH);
    assert.match(String(status.latestReply), /TEST-42/);
    assert.equal("reasoning" in status, false);
    assert.equal("extra" in status, false);

    const closeResult = await statusClient.callTool({
      name: "web_chat_close",
      arguments: { chatId: CHAT_ID },
    });
    assert.equal((closeResult.structuredContent as { closed?: boolean }).closed, true);
    assert.equal(closeCount, 1);
  } finally {
    await chat.close();
    await sourceClient.close().catch(() => undefined);
    await spawnedClient.close().catch(() => undefined);
    await statusClient.close().catch(() => undefined);
    await sourceServer.close().catch(() => undefined);
    await spawnedServer.close().catch(() => undefined);
    await statusServer.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("WebChatError remains a distinct typed error", () => {
  const error = new WebChatError("boom");
  assert.equal(error.name, "WebChatError");
  assert.ok(error instanceof Error);
});
