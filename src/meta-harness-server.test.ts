import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerConfig } from "./config.js";
import type { MetaHarnessHost } from "./meta-harness.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import type { WebLaunchBrowserController } from "./web-launch-browser.js";
import { WorkspaceRegistry } from "./workspaces.js";

function testConfig(parent: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    oauth: {
      ownerToken: "meta-entry-test-owner-token",
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

test("open_workspace exposes only semantic Meta entry and continuation binds the exact workspace root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-entry-server-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "PRODUCT.md"), "# Product\n", "utf8");

  const inspected: string[] = [];
  const continued: string[] = [];
  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async (root) => {
      inspected.push(root);
      return {
        schemaVersion: "meta-entry/v2",
        action: "CONTINUE",
        result: "Ship the accepted result.",
        startupContext: {
          schemaVersion: "project-startup-context/v1",
          status: "READY",
          lines: ["Loop: RUN7", "Next: WAIT_FOR_ANALYSIS"],
          sources: [{
            id: "loop",
            path: "docs/context/research_loop_state_current.json",
            status: "fresh",
            observedAt: "2026-09-07T14:01:05.000Z",
          }],
          blockers: [],
        },
      };
    },
    continue: async (root) => {
      continued.push(root);
      return { exitCode: 0, result: "Done — accepted result continued." };
    },
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => {
      throw new Error("web launch is outside this test");
    },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-entry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const openTool = listed.tools.find((candidate) => candidate.name === "open_workspace");
    assert.ok(openTool);
    assert.deepEqual(Object.keys(openTool.inputSchema.properties ?? {}), ["path"]);
    assert.equal(openTool.annotations?.readOnlyHint, false);
    assert.equal(openTool.annotations?.destructiveHint, false);

    const worktreeTool = listed.tools.find((candidate) => candidate.name === "create_worktree_workspace");
    assert.ok(worktreeTool);
    assert.deepEqual(Object.keys(worktreeTool.inputSchema.properties ?? {}), ["path", "baseRef", "branch", "createBranch"]);
    assert.equal(worktreeTool.annotations?.readOnlyHint, false);
    assert.equal(worktreeTool.annotations?.destructiveHint, false);

    const continuationTool = listed.tools.find((candidate) => candidate.name === "continue_meta_harness");
    assert.ok(continuationTool);
    assert.deepEqual(Object.keys(continuationTool.inputSchema.properties ?? {}), ["workspaceId"]);

    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const structured = opened.structuredContent as {
      workspaceId: string;
      root: string;
      metaEntry?: unknown;
      metaStartup?: unknown;
      instruction: string;
    };
    assert.equal(structured.root, repository);
    assert.deepEqual(structured.metaEntry, {
      schemaVersion: "meta-entry/v2",
      action: "CONTINUE",
      result: "Ship the accepted result.",
      startupContext: {
        schemaVersion: "project-startup-context/v1",
        status: "READY",
        lines: ["Loop: RUN7", "Next: WAIT_FOR_ANALYSIS"],
        sources: [{
          id: "loop",
          path: "docs/context/research_loop_state_current.json",
          status: "fresh",
          observedAt: "2026-09-07T14:01:05.000Z",
        }],
        blockers: [],
      },
    });
    assert.deepEqual(structured.metaStartup, {
      status: "READY",
      lines: ["Loop: RUN7", "Next: WAIT_FOR_ANALYSIS"],
      blockers: [],
    });
    assert.match(structured.instruction, /startup context is READY/i);
    assert.match(structured.instruction, /canonical startup projection/i);
    assert.match(structured.instruction, /velocity-first rule/i);
    assert.match(structured.instruction, /opening the workspace alone is not resume intent/i);
    assert.match(structured.instruction, /only when the user explicitly asks to resume\/continue/i);
    assert.match(JSON.stringify(opened.content), /Loop: RUN7/);
    assert.match(JSON.stringify(opened.content), /Next: WAIT_FOR_ANALYSIS/);
    assert.doesNotMatch(structured.instruction, /taskId|claimDigest|sessionDigest|generation/i);
    assert.deepEqual(inspected, [repository]);

    const continuedResult = await client.callTool({
      name: "continue_meta_harness",
      arguments: { workspaceId: structured.workspaceId },
    });
    assert.deepEqual(continued, [repository]);
    assert.deepEqual(continuedResult.structuredContent, {
      result: "Done — accepted result continued.",
      status: "COMPLETED",
      exitCode: 0,
    });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("nonzero Meta continuation is returned as STOPPED so hosts do not treat it as a successful retry signal", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-continuation-stopped-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "PRODUCT.md"), "# Product\n", "utf8");

  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async () => ({
      schemaVersion: "meta-entry/v1",
      action: "CONTINUE",
      result: "Resume retained work.",
    }),
    continue: async () => ({
      exitCode: 23,
      result: "Antigravity structured_output was not produced.",
    }),
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => { throw new Error("web launch is outside this test"); },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-continuation-stopped-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
    const continuedResult = await client.callTool({
      name: "continue_meta_harness",
      arguments: { workspaceId },
    });
    assert.deepEqual(continuedResult.structuredContent, {
      result: "Antigravity structured_output was not produced.",
      status: "STOPPED",
      exitCode: 23,
    });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("legacy meta-entry/v1 is fail-visible as UNDECLARED without suppressing mechanical continuation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-entry-v1-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "PRODUCT.md"), "# Product\n", "utf8");
  const continued: string[] = [];
  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async () => ({
      schemaVersion: "meta-entry/v1",
      action: "CONTINUE",
      result: "Continue the retained product result.",
    }),
    continue: async (root) => {
      continued.push(root);
      return { exitCode: 0, result: "Retained result continued." };
    },
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => { throw new Error("web launch is outside this test"); },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-entry-v1-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const structured = opened.structuredContent as {
      workspaceId: string;
      metaEntry?: unknown;
      metaStartup?: unknown;
      instruction: string;
    };
    assert.deepEqual(structured.metaEntry, {
      schemaVersion: "meta-entry/v1",
      action: "CONTINUE",
      result: "Continue the retained product result.",
    });
    assert.deepEqual(structured.metaStartup, {
      status: "UNDECLARED",
      lines: [],
      blockers: ["Meta-Harness inspect returned meta-entry/v1 without repo-declared startup context."],
    });
    assert.match(structured.instruction, /startup context is UNDECLARED/i);
    assert.match(structured.instruction, /do not claim startup context is loaded/i);
    assert.match(structured.instruction, /velocity-first rule/i);
    assert.match(structured.instruction, /opening the workspace alone is not resume intent/i);
    assert.match(structured.instruction, /only when the user explicitly asks to resume\/continue/i);
    assert.match(JSON.stringify(opened.content), /Meta-Harness startup state: UNDECLARED/);

    const continuedResult = await client.callTool({
      name: "continue_meta_harness",
      arguments: { workspaceId: structured.workspaceId },
    });
    assert.deepEqual(continued, [repository]);
    assert.deepEqual(continuedResult.structuredContent, {
      result: "Retained result continued.",
      status: "COMPLETED",
      exitCode: 0,
    });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("blocked continuation readiness suppresses automatic Meta-Harness continuation guidance", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-continuation-blocked-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "PRODUCT.md"), "# Product\n", "utf8");
  const continued: string[] = [];
  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async () => ({
      schemaVersion: "meta-entry/v1",
      action: "CONTINUE",
      result: "Continue the retained product result.",
    }),
    continuationReadiness: () => ({
      status: "BLOCKED",
      blockers: [
        "Meta-Harness repo planning is enabled, but .git/meta-harness/decision-plane-v2/current-world.json is missing; automatic continuation would fail before a current WorldHead is available.",
      ],
    }),
    continue: async (root) => {
      continued.push(root);
      return { exitCode: 0, result: "must not run" };
    },
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => { throw new Error("web launch is outside this test"); },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-continuation-blocked-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const structured = opened.structuredContent as {
      metaStartup?: unknown;
      metaContinuation?: unknown;
      instruction: string;
    };
    assert.deepEqual(structured.metaStartup, {
      status: "UNDECLARED",
      lines: [],
      blockers: ["Meta-Harness inspect returned meta-entry/v1 without repo-declared startup context."],
    });
    assert.deepEqual(structured.metaContinuation, {
      status: "BLOCKED",
      blockers: [
        "Meta-Harness repo planning is enabled, but .git/meta-harness/decision-plane-v2/current-world.json is missing; automatic continuation would fail before a current WorldHead is available.",
      ],
    });
    assert.match(structured.instruction, /automatic continuation is BLOCKED/i);
    assert.match(structured.instruction, /do not invoke continue_meta_harness/i);
    assert.match(structured.instruction, /do not synthesize or repair Meta-Harness decision-plane files/i);
    assert.doesNotMatch(structured.instruction, /reports mechanically continuable product work/i);
    assert.match(JSON.stringify(opened.content), /current-world\.json is missing/i);

    const continuation = await client.callTool({
      name: "continue_meta_harness",
      arguments: { workspaceId: (opened.structuredContent as { workspaceId: string }).workspaceId },
    });
    assert.deepEqual(continued, []);
    assert.match(
      (continuation.structuredContent as { result: string }).result,
      /Meta-Harness continuation blocked:.*current-world\.json is missing/i,
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("blocked repo-declared startup context suppresses automatic continuation and fallback guidance", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-startup-blocked-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, ".meta-harness-project.json"), "{}\n", "utf8");
  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async () => ({
      schemaVersion: "meta-entry/v2",
      action: "CONTINUE",
      result: "A retained result exists.",
      startupContext: {
        schemaVersion: "project-startup-context/v1",
        status: "BLOCKED",
        lines: ["Loop: OLD"],
        sources: [{ id: "loop", path: "docs/context/state.json", status: "stale", observedAt: "2026-08-01T00:00:00.000Z" }],
        blockers: ["required startup source stale: docs/context/state.json"],
      },
    }),
    continue: async () => ({ exitCode: 0, result: "must not be selected by open guidance" }),
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => { throw new Error("web launch is outside this test"); },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-startup-blocked-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const structured = opened.structuredContent as { metaEntry?: unknown; metaStartup?: unknown; instruction: string };
    assert.deepEqual(structured.metaStartup, {
      status: "BLOCKED",
      lines: ["Loop: OLD"],
      blockers: ["required startup source stale: docs/context/state.json"],
    });
    assert.match(structured.instruction, /startup context is BLOCKED/i);
    assert.match(structured.instruction, /recoverable repository-context gaps/i);
    assert.doesNotMatch(structured.instruction, /invoke continue_meta_harness now/i);
    assert.doesNotMatch(structured.instruction, /chat history.*fallback|undeclared legacy.*use/i);
    assert.match(JSON.stringify(opened.content), /required startup source stale/);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Meta inspection failure degrades to IDLE diagnostic without fail-closed product instruction", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-entry-recovery-"));
  const repository = join(parent, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "PRODUCT.md"), "# Product\n", "utf8");
  const metaHarness: MetaHarnessHost = {
    looksLikeRepository: (root) => root === repository,
    inspectEntry: async () => { throw new Error("legacy INVALID from installed CLI"); },
    continue: async () => ({ exitCode: 0, result: "unused" }),
  };
  const config = testConfig(parent);
  const browser = {
    launchWebConversation: async () => { throw new Error("web launch is outside this test"); },
  } as Pick<WebLaunchBrowserController, "launchWebConversation">;
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config),
    createReviewCheckpointManager(),
    browser,
    metaHarness,
  );
  const client = new Client({ name: "meta-entry-recovery-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: repository } });
    const structured = opened.structuredContent as {
      metaEntry?: unknown;
      metaStartup?: unknown;
      instruction: string;
    };
    assert.deepEqual(structured.metaEntry, {
      schemaVersion: "meta-entry/v1",
      action: "IDLE",
      result: null,
    });
    assert.deepEqual(structured.metaStartup, {
      status: "INSPECTION_FAILED",
      lines: [],
      blockers: ["Meta-Harness inspect failed; startup context was not loaded."],
    });
    assert.match(structured.instruction, /recoverable host diagnostic/i);
    assert.doesNotMatch(structured.instruction, /fail closed|continuation authority is invalid/i);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
