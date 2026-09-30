import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { SourceResolveController, resolvedSourceSchema } from "./source-resolve.js";
import { WorkspaceRegistry } from "./workspaces.js";

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "source-resolve-test-owner-token",
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
    minimalTools: false,
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

test("resolvedSourceSchema rejects Google/Vertex/search redirects and accepts canonical URLs", () => {
  const forbiddenRedirects = [
    "https://vertexaisearch.cloud.google.com/grounding?query=Vicor+Corporation",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1...",
    "https://www.google.com/search?q=Vicor+news",
    "https://google.com/search?q=SPCX+news",
    "https://bing.com/search?q=DELL+earnings",
    "https://duckduckgo.com/?q=NVDA+stock",
    "https://search.yahoo.com/search?p=VICR",
  ];

  for (const forbiddenUrl of forbiddenRedirects) {
    assert.throws(
      () =>
        resolvedSourceSchema.parse({
          url: forbiddenUrl,
          title: "Redirect title",
          rationale: "Rationale",
        }),
      /URL must be a direct canonical article\/filing URL/,
    );
  }

  const validCanonicalSources = [
    {
      url: "https://ir.vicorpower.com/news-releases/news-release-details/2026/vicor-q2-earnings",
      title: "Vicor Corporation Reports Second Quarter Financial Results",
      rationale: "Official Investor Relations disclosure detailing revenue acceleration and high-density power modules.",
    },
    {
      url: "https://www.sec.gov/Archives/edgar/data/751978/000075197826000012/vicr-20260630.htm",
      title: "SEC Form 10-Q Vicor Corp",
      rationale: "Official SEC quarterly disclosure verifying balance sheet and automotive segment growth.",
    },
    {
      url: "https://www.reuters.com/technology/vicor-datacenter-power-demand-surges-2026",
      title: "Vicor sees surge in datacenter 48V power module adoption",
      rationale: "Independent wire report confirming new hyperscaler design wins.",
    },
  ];

  for (const validSource of validCanonicalSources) {
    const parsed = resolvedSourceSchema.parse(validSource);
    assert.equal(parsed.url, validSource.url);
  }
});

test("SourceResolveController lifecycle, challenge replay prevention, and provenance retention", async () => {
  let launchedPrompt = "";
  let attachDevSpace: boolean | undefined;
  const stoppedRecovery: string[] = [];
  const mockBrowser = {
    launchWebConversation: async (prompt: string, options?: { attachDevSpace?: boolean }) => {
      launchedPrompt = prompt;
      attachDevSpace = options?.attachDevSpace;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "dummy-resolve-conv-hash",
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
    stopWebConversationRecovery: (conversationIdentitySha256: string) => {
      stoppedRecovery.push(conversationIdentitySha256);
      return true;
    },
  };

  const controller = new SourceResolveController(mockBrowser);

  // 1. Start resolve
  const startResult = await controller.startResolve({
    ticker: "VICR",
    companyName: "Vicor Corporation",
    asOfDate: "2026-09-28",
  });

  assert.equal(startResult.status, "pending");
  assert.match(startResult.challenge, /^[0-9a-f]{64}$/i);
  assert.ok(launchedPrompt.includes("VICR"));
  assert.ok(launchedPrompt.includes("STRICT URL RULES:"));
  assert.ok(launchedPrompt.includes("Do NOT provide Google search redirect URLs"));
  assert.ok(launchedPrompt.includes("COMPLETION CONTRACT:"));
  assert.ok(launchedPrompt.includes("Do not finish with a prose-only answer"));
  assert.ok(launchedPrompt.includes("stop browsing and invoke DevSpace MCP tool `source_resolve_submit` immediately"));
  assert.ok(launchedPrompt.includes("The run is not complete until that tool call succeeds"));
  assert.ok(launchedPrompt.includes("Do not ask the user for confirmation"));
  assert.ok(launchedPrompt.includes(startResult.challenge));
  assert.equal(attachDevSpace, true);

  // 2. Query status before submit -> pending
  const pendingStatus = controller.getResolveStatus(startResult.resolveId);
  assert.equal(pendingStatus.status, "pending");
  assert.equal(pendingStatus.retained, undefined);

  // 3. Submit with invalid challenge -> throws
  assert.throws(
    () =>
      controller.submitResolve({
        challenge: "f".repeat(64),
        ticker: "VICR",
        sources: [
          {
            url: "https://ir.vicorpower.com/press",
            title: "Press",
            rationale: "Official press",
          },
        ],
      }),
    /challenge invalid, expired, or already used/,
  );

  // 4. Submit with ticker mismatch -> throws
  assert.throws(
    () =>
      controller.submitResolve({
        challenge: startResult.challenge,
        ticker: "SPCX", // mismatch!
        sources: [
          {
            url: "https://ir.vicorpower.com/press",
            title: "Press",
            rationale: "Official press",
          },
        ],
      }),
    /ticker mismatch/,
  );

  // 5. Submit with valid challenge and canonical sources -> succeeds
  const submitResult = controller.submitResolve({
    challenge: startResult.challenge,
    ticker: "VICR",
    sources: [
      {
        url: "https://ir.vicorpower.com/news-releases/2026-datacenter",
        title: "Vicor Reports AI Datacenter Power Deliveries",
        rationale: "Official IR release documenting Q2 power delivery growth",
      },
    ],
  });

  assert.equal(submitResult.status, "succeeded");
  assert.equal(submitResult.resolveId, startResult.resolveId);
  assert.deepEqual(stoppedRecovery, ["dummy-resolve-conv-hash"]);

  // 6. Replay attempt with same challenge -> REJECTED
  assert.throws(
    () =>
      controller.submitResolve({
        challenge: startResult.challenge,
        ticker: "VICR",
        sources: [
          {
            url: "https://ir.vicorpower.com/news-releases/2026-datacenter",
            title: "Vicor Reports AI Datacenter Power Deliveries",
            rationale: "Official IR release documenting Q2 power delivery growth",
          },
        ],
      }),
    /challenge invalid, expired, or already used/,
  );

  // 7. Query status after submit -> succeeded with server-owned provenance
  const succeededStatus = controller.getResolveStatus(startResult.resolveId);
  assert.equal(succeededStatus.status, "succeeded");
  assert.ok(succeededStatus.retained);
  assert.equal(succeededStatus.retained.resolve_id, startResult.resolveId);
  assert.equal(succeededStatus.retained.ticker, "VICR");
  assert.equal(succeededStatus.retained.execution_surface, "chatgpt_web");
  assert.equal(succeededStatus.retained.declared_model, "gpt-5.6-sol");
  assert.equal(succeededStatus.retained.api_mode, false);
  assert.equal(succeededStatus.retained.sources.length, 1);
  assert.equal(
    succeededStatus.retained.sources[0].url,
    "https://ir.vicorpower.com/news-releases/2026-datacenter",
  );
});

test("SourceResolveController retains ChatShare provenance when configured", async () => {
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "chatshare-resolve-conv-hash",
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
  };
  const controller = new SourceResolveController(mockBrowser, {
    executionSurface: "chatshare",
  });
  const started = await controller.startResolve({ ticker: "AKAM" });
  controller.submitResolve({
    challenge: started.challenge,
    ticker: "AKAM",
    sources: [
      {
        url: "https://www.akamai.com/newsroom/press-release/example",
        title: "Akamai example source",
        rationale: "Canonical company source used only to validate retained provenance.",
      },
    ],
  });
  assert.equal(
    controller.getResolveStatus(started.resolveId).retained?.execution_surface,
    "chatshare",
  );
});

test("SourceResolveController deletes ChatShare history only after successful submit", async () => {
  const deleteCalls: string[] = [];
  let deleteAttempt = 0;
  const conversationHash = "c".repeat(64);
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: conversationHash,
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
    deleteWebConversation: async (conversationIdentitySha256: string) => {
      deleteCalls.push(conversationIdentitySha256);
      deleteAttempt += 1;
      return deleteAttempt === 1 ? ("busy" as const) : ("deleted" as const);
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    executionSurface: "chatshare",
    cleanupSucceededConversations: true,
    cleanupDelayMs: 1,
    cleanupRetryMs: 5,
    cleanupWatchMs: 100,
  });
  const started = await controller.startResolve({ ticker: "VICR" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(deleteCalls.length, 0);

  controller.submitResolve({
    challenge: started.challenge,
    ticker: "VICR",
    sources: [
      {
        url: "https://ir.vicorpower.com/news-releases/fixture",
        title: "Fixture source",
        rationale: "Fixture canonical source for cleanup lifecycle validation.",
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(deleteCalls, [conversationHash, conversationHash]);
  assert.equal(controller.getResolveStatus(started.resolveId).status, "succeeded");
});

test("SourceResolveController deletes only the succeeded conversation and never while pending", async () => {
  const deleteCalls: string[] = [];
  const conversationIdentity = "c".repeat(64);
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: conversationIdentity,
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
    deleteWebConversation: async (conversationIdentitySha256: string) => {
      deleteCalls.push(conversationIdentitySha256);
      return "deleted" as const;
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    cleanupSucceededConversations: true,
    cleanupDelayMs: 5,
    cleanupRetryMs: 5,
    cleanupWatchMs: 100,
  });

  const started = await controller.startResolve({ ticker: "VICR" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.getResolveStatus(started.resolveId).status, "pending");
  assert.deepEqual(deleteCalls, []);

  controller.submitResolve({
    challenge: started.challenge,
    ticker: "VICR",
    sources: [
      {
        url: "https://ir.vicorpower.com/news-releases/2026-datacenter",
        title: "Vicor Reports AI Datacenter Power Deliveries",
        rationale: "Official IR release documenting Q2 power delivery growth",
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(controller.getResolveStatus(started.resolveId).status, "succeeded");
  assert.deepEqual(deleteCalls, [conversationIdentity]);
});

test("SourceResolveController resumes an idle pending child conversation without starting a new resolve", async () => {
  const resumeCalls: Array<{ conversationIdentitySha256: string; prompt: string }> = [];
  let launchCalls = 0;
  const mockBrowser = {
    launchWebConversation: async () => {
      launchCalls += 1;
      return {
        slice: "WEB-LAUNCH-0" as const,
        launchSuccess: true as const,
        conversationIdentitySha256: "d".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false as const,
      };
    },
    resumeWebConversation: async (conversationIdentitySha256: string, prompt: string) => {
      resumeCalls.push({ conversationIdentitySha256, prompt });
      return "sent" as const;
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    resumeGraceMs: 0,
    resumePollMs: 5,
    resumeCooldownMs: 50,
    resumeWatchMs: 200,
    resumeMaxAttempts: 1,
  });

  const started = await controller.startResolve({ ticker: "AKAM" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(controller.getResolveStatus(started.resolveId).status, "pending");
  assert.equal(launchCalls, 1);
  assert.deepEqual(resumeCalls, [
    {
      conversationIdentitySha256: "d".repeat(64),
      prompt: "resume",
    },
  ]);
});

test("SourceResolveController treats resumeWatchMs zero as pending-lifecycle watch", async () => {
  const resumeCalls: string[] = [];
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "f".repeat(64),
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
    resumeWebConversation: async (_conversationIdentitySha256: string, prompt: string) => {
      resumeCalls.push(prompt);
      return "sent" as const;
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    resumeGraceMs: 0,
    resumePollMs: 5,
    resumeCooldownMs: 50,
    resumeWatchMs: 0,
    resumeMaxAttempts: 1,
  });

  await controller.startResolve({ ticker: "AKAM" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(resumeCalls, ["resume"]);
});

test("SourceResolveController stops automatic resume when the conversation is terminal", async () => {
  let resumeCalls = 0;
  const stoppedRecovery: string[] = [];
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "a".repeat(64),
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
    resumeWebConversation: async () => {
      resumeCalls += 1;
      return "terminal" as const;
    },
    stopWebConversationRecovery: (conversationIdentitySha256: string) => {
      stoppedRecovery.push(conversationIdentitySha256);
      return true;
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    resumeGraceMs: 0,
    resumePollMs: 5,
    resumeCooldownMs: 10,
    resumeWatchMs: 0,
    resumeMaxAttempts: 3,
  });

  const started = await controller.startResolve({ ticker: "AKAM" });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(resumeCalls, 1);
  const status = controller.getResolveStatus(started.resolveId);
  assert.equal(status.status, "failed");
  assert.equal(status.failureReason, "terminal_chat_state");
  assert.ok(status.failedAt);
  assert.deepEqual(stoppedRecovery, ["a".repeat(64)]);
});

test("SourceResolveController probes interruption resume before the normal idle grace", async () => {
  const resumeCalls: Array<{
    conversationIdentitySha256: string;
    prompt: string;
    onlyIfInterrupted?: boolean;
  }> = [];
  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "e".repeat(64),
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
    resumeWebConversation: async (
      conversationIdentitySha256: string,
      prompt: string,
      options?: { onlyIfInterrupted?: boolean },
    ) => {
      resumeCalls.push({
        conversationIdentitySha256,
        prompt,
        onlyIfInterrupted: options?.onlyIfInterrupted,
      });
      return options?.onlyIfInterrupted ? ("sent" as const) : ("busy" as const);
    },
  };

  const controller = new SourceResolveController(mockBrowser, {
    resumeGraceMs: 200,
    resumePollMs: 5,
    resumeCooldownMs: 50,
    resumeWatchMs: 500,
    resumeMaxAttempts: 1,
  });

  await controller.startResolve({ ticker: "AKAM" });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(resumeCalls, [
    {
      conversationIdentitySha256: "e".repeat(64),
      prompt: "resume",
      onlyIfInterrupted: true,
    },
  ]);
});

test("source resolve state survives across MCP sessions when controller is origin-scoped", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-resolve-mcp-test-"));
  const config = testConfig(parent);

  const mockBrowser = {
    launchWebConversation: async () => ({
      slice: "WEB-LAUNCH-0" as const,
      launchSuccess: true as const,
      conversationIdentitySha256: "dummy-resolve-conv-hash",
      timestamp: new Date().toISOString(),
      assistantOutputCaptured: false as const,
    }),
  };

  const workspaces = new WorkspaceRegistry(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  const sourceResolveController = new SourceResolveController(mockBrowser);

  const serverA = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    mockBrowser,
    undefined,
    undefined,
    undefined,
    { sourceResolveController },
  );
  const serverB = createMcpServer(
    config,
    workspaces,
    reviewCheckpoints,
    mockBrowser,
    undefined,
    undefined,
    undefined,
    { sourceResolveController },
  );

  const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  const clientA = new Client({ name: "resolve-start-client", version: "1.0.0" });
  const clientB = new Client({ name: "resolve-callback-client", version: "1.0.0" });
  let toolListChangedA = 0;
  let toolListChangedB = 0;
  clientA.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolListChangedA += 1;
  });
  clientB.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolListChangedB += 1;
  });

  try {
    await Promise.all([
      serverA.connect(serverTransportA),
      clientA.connect(clientTransportA),
      serverB.connect(serverTransportB),
      clientB.connect(clientTransportB),
    ]);

    assert.ok(toolListChangedA >= 1);
    assert.ok(toolListChangedB >= 1);

    const listed = await clientA.listTools();
    const toolNames = listed.tools.map((t) => t.name);
    assert.ok(toolNames.includes("source_resolve_start"));
    assert.ok(toolNames.includes("source_resolve_submit"));
    assert.ok(toolNames.includes("source_resolve_status"));

    const startResRaw = await clientA.callTool({
      name: "source_resolve_start",
      arguments: {
        ticker: "SPCX",
        companyName: "SpaceX",
        asOfDate: "2026-09-28",
      },
    });
    const startRes = startResRaw as unknown as {
      structuredContent: { resolveId: string; challenge: string; status: string };
    };
    const { resolveId, challenge } = startRes.structuredContent;
    assert.ok(resolveId.startsWith("resolve-"));
    assert.match(challenge, /^[0-9a-f]{64}$/i);

    const statusResRaw1 = await clientB.callTool({
      name: "source_resolve_status",
      arguments: { resolveId },
    });
    const statusRes1 = statusResRaw1 as unknown as { structuredContent: { status: string } };
    assert.equal(statusRes1.structuredContent.status, "pending");

    const submitResRaw = await clientB.callTool({
      name: "source_resolve_submit",
      arguments: {
        challenge,
        ticker: "SPCX",
        sources: [
          {
            url: "https://www.spacex.com/launches/starlink-mission-2026",
            title: "SpaceX Starlink Mission Update",
            rationale: "Official mission manifest and cadence update",
          },
        ],
      },
    });
    const submitRes = submitResRaw as unknown as {
      structuredContent: { resolveId: string; status: string };
    };
    assert.equal(submitRes.structuredContent.status, "succeeded");

    const statusResRaw2 = await clientA.callTool({
      name: "source_resolve_status",
      arguments: { resolveId },
    });
    const statusRes2 = statusResRaw2 as unknown as {
      structuredContent: {
        status: string;
        retained: {
          ticker: string;
          execution_surface: string;
          sources: Array<{ url: string; title: string }>;
        };
      };
    };
    assert.equal(statusRes2.structuredContent.status, "succeeded");
    assert.equal(statusRes2.structuredContent.retained.ticker, "SPCX");
    assert.equal(statusRes2.structuredContent.retained.execution_surface, "chatgpt_web");
    assert.equal(
      statusRes2.structuredContent.retained.sources[0].url,
      "https://www.spacex.com/launches/starlink-mission-2026",
    );
  } finally {
    await Promise.all([clientA.close(), clientB.close()]);
    await Promise.all([serverA.close(), serverB.close()]);
    await rm(parent, { recursive: true, force: true });
  }
});
