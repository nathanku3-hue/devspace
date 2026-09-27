import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { LongTaskOperationManager } from "./long-task-operations.js";
import type { LongTaskToolResult } from "./server.js";

test("Control-plane / execution-plane long task tools and bash fast-path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-longtask-test-"));
  await writeFile(join(parent, "sample.txt"), "hello sample content", "utf8");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: parent,
    DEVSPACE_AUTHENTICATION: "none",
  });
  const workspaces = new WorkspaceRegistry(config);
  const manager = new LongTaskOperationManager<LongTaskToolResult>(50);

  // Primary server uses 5000ms fast-path timeout
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false,
      }),
    },
    undefined,
    manager,
    5000,
  );

  const client = new Client({ name: "longtask-test-client-1", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // 1. Verify exactly 15 tools are exposed, including the 3 control plane tools
    const listed = await client.listTools();
    const toolNames = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "bash",
      "cancel_long_task",
      "close_workspace",
      "continue_meta_harness",
      "create_worktree_workspace",
      "edit",
      "long_task_status",
      "open_workspace",
      "publish_git_changes",
      "read",
      "read_files",
      "safe_rename_file",
      "start_long_task",
      "web_launch",
      "write",
    ]);

    // 2. Verify start_long_task schema matches cached connector: required: ["workspaceId", "kind"]
    const startLongTaskTool = listed.tools.find((t) => t.name === "start_long_task");
    assert.ok(startLongTaskTool, "start_long_task must be registered");
    assert.deepEqual(startLongTaskTool.inputSchema.required?.sort(), ["kind", "workspaceId"]);
    assert.ok(startLongTaskTool.inputSchema.properties?.command, "command property must exist");

    // Open workspace
    const openRes = await client.callTool({
      name: "open_workspace",
      arguments: { path: parent },
    });
    const workspaceId = (openRes.structuredContent as any)?.workspaceId;
    assert.ok(workspaceId, "workspaceId must be returned");

    // 3. Fast-path bash for short commands (<5s): completes synchronously
    const bashRes = await client.callTool({
      name: "bash",
      arguments: {
        workspaceId,
        command: "node -e \"console.log('hello from fast-path')\"",
      },
    });
    assert.equal(Boolean(bashRes.isError), false);
    assert.ok(bashRes.structuredContent, "structuredContent must exist");
    assert.equal(typeof (bashRes.structuredContent as any).result, "string");
    assert.match((bashRes.structuredContent as any).result, /hello from fast-path/);
    assert.equal((bashRes.structuredContent as any).status, "succeeded");

    // 4. start_long_task with kind: "validation" without command (cached connector compatibility)
    const valRes = await client.callTool({
      name: "start_long_task",
      arguments: {
        workspaceId,
        kind: "validation",
      },
    });
    assert.equal(Boolean(valRes.isError), false);
    const valData = valRes.structuredContent as any;
    assert.ok(valData.operationId);
    assert.equal(valData.kind, "validation");

    let valStatusData: any;
    for (let i = 0; i < 50; i++) {
      const statusRes = await client.callTool({
        name: "long_task_status",
        arguments: { operationId: valData.operationId },
      });
      valStatusData = statusRes.structuredContent as any;
      if (valStatusData.status === "succeeded" || valStatusData.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(valStatusData.status, "succeeded");
    assert.ok(valStatusData.result, "result object must exist");
    assert.equal(valStatusData.result.taskValidation.outcome, "UNVERIFIED");

    // 5. start_long_task with kind: "shell"
    const startRes = await client.callTool({
      name: "start_long_task",
      arguments: {
        workspaceId,
        kind: "shell",
        command: "node -e \"setTimeout(() => console.log('async task done'), 100)\"",
      },
    });
    assert.equal(Boolean(startRes.isError), false);
    const startData = startRes.structuredContent as any;
    assert.ok(startData.operationId);
    assert.equal(startData.workspaceId, workspaceId);
    const opId = startData.operationId;

    // Poll long_task_status until completed
    let statusData: any;
    for (let i = 0; i < 50; i++) {
      const statusRes = await client.callTool({
        name: "long_task_status",
        arguments: { operationId: opId },
      });
      statusData = statusRes.structuredContent as any;
      if (statusData.status === "succeeded" || statusData.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(statusData.status, "succeeded");
    assert.ok(statusData.result, "structured result object must exist");
    assert.equal(typeof statusData.result.output, "string");
    assert.match(statusData.result.output, /async task done/);

    // 6. cancel_long_task cancels a running task
    const longRunning = await client.callTool({
      name: "start_long_task",
      arguments: {
        workspaceId,
        kind: "shell",
        command: "node -e \"setInterval(() => {}, 1000)\"",
      },
    });
    const cancelOpId = (longRunning.structuredContent as any).operationId;

    const cancelRes = await client.callTool({
      name: "cancel_long_task",
      arguments: { operationId: cancelOpId },
    });
    const cancelData = cancelRes.structuredContent as any;
    assert.ok(cancelData.status === "cancelling" || cancelData.status === "cancelled");

    // Poll until cancel settles
    for (let i = 0; i < 50; i++) {
      const checkRes = await client.callTool({
        name: "long_task_status",
        arguments: { operationId: cancelOpId },
      });
      const checkData = checkRes.structuredContent as any;
      if (checkData.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const finalCheck = await client.callTool({
      name: "long_task_status",
      arguments: { operationId: cancelOpId },
    });
    assert.equal((finalCheck.structuredContent as any).status, "cancelled");

    // 7. Client abort BEFORE fast-path timeout cancels the background operation
    const existingOpIds = new Set(manager.list().map((o) => o.operationId));
    const preHandoffAbortController = new AbortController();
    const abortingBash = client.callTool(
      {
        name: "bash",
        arguments: {
          workspaceId,
          command: "node -e \"setInterval(() => {}, 1000)\"",
        },
      },
      undefined,
      { signal: preHandoffAbortController.signal },
    );
    // Abort at 50ms (well before 5000ms fast-path threshold)
    await new Promise((r) => setTimeout(r, 50));
    preHandoffAbortController.abort();
    await abortingBash.catch(() => undefined);

    let abortedOp: any;
    for (let i = 0; i < 50; i++) {
      abortedOp = manager.list(workspaceId).find((o) => !existingOpIds.has(o.operationId));
      if (abortedOp && (abortedOp.status === "cancelled" || abortedOp.status === "failed")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(abortedOp, "pre-handoff aborted operation should be recorded in manager");
    assert.equal(abortedOp.status, "cancelled");

  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined);
  }
});

test("Compatibility and failure semantics stay schema-safe", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-compat-test-"));
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: parent,
    DEVSPACE_AUTHENTICATION: "none",
  });
  const workspaces = new WorkspaceRegistry(config);
  const manager = new LongTaskOperationManager<LongTaskToolResult>(50);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false,
      }),
    },
    undefined,
    manager,
    5000,
  );
  const client = new Client({ name: "compat-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const publicSchemas = {
      start_long_task: {
        inputKeys: ["command", "kind", "timeout", "workingDirectory", "workspaceId"],
        inputRequired: ["kind", "workspaceId"],
      },
      long_task_status: {
        inputKeys: ["operationId"],
        inputRequired: ["operationId"],
      },
      cancel_long_task: {
        inputKeys: ["operationId"],
        inputRequired: ["operationId"],
      },
    } as const;
    const outputKeys = [
      "completedAt",
      "createdAt",
      "error",
      "kind",
      "operationId",
      "progress",
      "result",
      "startedAt",
      "status",
      "workspaceId",
    ];
    const outputRequired = [
      "createdAt",
      "kind",
      "operationId",
      "progress",
      "status",
      "workspaceId",
    ];

    for (const [toolName, expected] of Object.entries(publicSchemas)) {
      const tool = listed.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool, `${toolName} must be registered`);
      assert.deepEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
        expected.inputKeys.slice().sort(),
      );
      assert.deepEqual(
        tool.inputSchema.required?.slice().sort(),
        expected.inputRequired.slice().sort(),
      );

      const output = tool.outputSchema as any;
      assert.deepEqual(Object.keys(output?.properties ?? {}).sort(), outputKeys);
      assert.deepEqual(output?.required?.slice().sort(), outputRequired);
      assert.ok(output?.properties?.result, `${toolName} result schema must exist`);
      assert.deepEqual(
        Object.keys(output.properties.result.properties ?? {}).sort(),
        ["output", "taskValidation"],
      );
      assert.deepEqual(output.properties.result.required, ["output"]);
    }

    const openRes = await client.callTool({
      name: "open_workspace",
      arguments: { path: parent },
    });
    const workspaceId = (openRes.structuredContent as any)?.workspaceId;
    assert.ok(workspaceId);

    const missingId = "operation_missing_from_runtime";
    const missingStatus = await client.callTool({
      name: "long_task_status",
      arguments: { operationId: missingId },
    });
    assert.equal(Boolean(missingStatus.isError), false);
    const missingStatusData = missingStatus.structuredContent as any;
    assert.equal(missingStatusData.operationId, missingId);
    assert.equal(missingStatusData.status, "failed");
    assert.equal(missingStatusData.error, "operation_not_found");
    assert.equal(missingStatusData.workspaceId, "unknown");
    assert.match(((missingStatus as any).content[0] as any).text, /operation_not_found/);

    const missingCancel = await client.callTool({
      name: "cancel_long_task",
      arguments: { operationId: missingId },
    });
    assert.equal(Boolean(missingCancel.isError), false);
    assert.equal((missingCancel.structuredContent as any).status, "failed");
    assert.equal(
      (missingCancel.structuredContent as any).error,
      "operation_not_found",
    );

    const invalidValidationOptions = await client.callTool({
      name: "start_long_task",
      arguments: { workspaceId, kind: "validation", timeout: 1 },
    });
    assert.equal(Boolean(invalidValidationOptions.isError), true);
    assert.match(
      JSON.stringify((invalidValidationOptions as any).content),
      /only valid for kind=shell/,
    );

    const blankShellCommand = await client.callTool({
      name: "start_long_task",
      arguments: { workspaceId, kind: "shell", command: "   " },
    });
    assert.equal(Boolean(blankShellCommand.isError), true);
    assert.match(
      JSON.stringify((blankShellCommand as any).content),
      /command is required for kind=shell/,
    );

    const validationStart = await client.callTool({
      name: "start_long_task",
      arguments: {
        workspaceId,
        kind: "validation",
        command: "node -e \"process.exit(7)\"",
      },
    });
    const validationOpId = (validationStart.structuredContent as any).operationId;
    let validationStatus: any;
    for (let i = 0; i < 50; i++) {
      const response = await client.callTool({
        name: "long_task_status",
        arguments: { operationId: validationOpId },
      });
      validationStatus = response.structuredContent as any;
      if (
        validationStatus.status === "succeeded" ||
        validationStatus.status === "failed"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(validationStatus.status, "succeeded");
    assert.equal(validationStatus.result.taskValidation.outcome, "BLOCKED");
    assert.equal(validationStatus.result.taskValidation.validation[0].passed, false);

    const restartedManager = new LongTaskOperationManager<LongTaskToolResult>(50);
    const restartedServer = createMcpServer(
      config,
      workspaces,
      createReviewCheckpointManager(),
      {
        launchWebConversation: async () => ({
          slice: "WEB-LAUNCH-0",
          launchSuccess: true,
          conversationIdentitySha256: "b".repeat(64),
          timestamp: new Date().toISOString(),
          assistantOutputCaptured: false,
        }),
      },
      undefined,
      restartedManager,
      5000,
    );
    const restartedClient = new Client({
      name: "compat-restarted-client",
      version: "1.0.0",
    });
    const [restartedClientTransport, restartedServerTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await restartedServer.connect(restartedServerTransport);
      await restartedClient.connect(restartedClientTransport);
      const afterRestart = await restartedClient.callTool({
        name: "long_task_status",
        arguments: { operationId: validationOpId },
      });
      assert.equal((afterRestart.structuredContent as any).status, "failed");
      assert.equal(
        (afterRestart.structuredContent as any).error,
        "operation_not_found",
      );
    } finally {
      await restartedClient.close().catch(() => undefined);
      await restartedServer.close().catch(() => undefined);
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 200,
    }).catch(() => undefined);
  }
});

test("Regression Gate 1: Actual automatic bash fast-path handoff with injectable timeout", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-gate1-test-"));
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: parent,
    DEVSPACE_AUTHENTICATION: "none",
  });
  const workspaces = new WorkspaceRegistry(config);
  const manager = new LongTaskOperationManager<LongTaskToolResult>(50);

  // Injectable fast-path duration set to 60ms
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false,
      }),
    },
    undefined,
    manager,
    60, // 60ms fast-path timeout
  );

  const client = new Client({ name: "gate1-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const openRes = await client.callTool({
      name: "open_workspace",
      arguments: { path: parent },
    });
    const workspaceId = (openRes.structuredContent as any)?.workspaceId;
    assert.ok(workspaceId);

    // Command takes 400ms, exceeding the 60ms fast-path threshold
    const gate1Started = performance.now();
    const gate1BashRes = await client.callTool({
      name: "bash",
      arguments: {
        workspaceId,
        command: "node -e \"setTimeout(() => console.log('gate1-done'), 400)\"",
      },
    });
    const gate1Elapsed = performance.now() - gate1Started;

    // Must return near fast-path timeout (60ms), NOT wait the full 400ms!
    assert.ok(gate1Elapsed < 300, `bash must hand off asynchronously; took ${gate1Elapsed}ms`);
    assert.equal(Boolean(gate1BashRes.isError), false);
    const gate1Data = gate1BashRes.structuredContent as any;
    assert.ok(gate1Data.operationId, "operationId must be returned on fast-path timeout");
    assert.ok(gate1Data.status === "running" || gate1Data.status === "queued");
    assert.match(gate1Data.result, /Command exceeded 60ms fast-path and is executing in the background/);
    const gate1OpId = gate1Data.operationId;

    // Poll long_task_status until completion
    let gate1Status: any;
    for (let i = 0; i < 50; i++) {
      const statusRes = await client.callTool({
        name: "long_task_status",
        arguments: { operationId: gate1OpId },
      });
      gate1Status = statusRes.structuredContent as any;
      if (gate1Status.status === "succeeded" || gate1Status.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(gate1Status.status, "succeeded");
    assert.ok(gate1Status.result?.output);
    assert.match(gate1Status.result.output, /gate1-done/);

  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined);
  }
});

test("Regression Gate 2: Post-handoff disconnect survival and multi-session concurrency", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-gate2-test-"));
  await writeFile(join(parent, "sample.txt"), "gate2 test content", "utf8");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: parent,
    DEVSPACE_AUTHENTICATION: "none",
  });
  const workspaces = new WorkspaceRegistry(config);
  const manager = new LongTaskOperationManager<LongTaskToolResult>(50);

  // Session 1 server
  const server1 = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false,
      }),
    },
    undefined,
    manager,
    60, // 60ms fast-path timeout
  );
  const client1 = new Client({ name: "gate2-client-1", version: "1.0.0" });
  const [client1Transport, server1Transport] = InMemoryTransport.createLinkedPair();

  // Session 2 server (sharing workspaces & manager)
  const server2 = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    {
      launchWebConversation: async () => ({
        slice: "WEB-LAUNCH-0",
        launchSuccess: true,
        conversationIdentitySha256: "a".repeat(64),
        timestamp: new Date().toISOString(),
        assistantOutputCaptured: false,
      }),
    },
    undefined,
    manager,
    60,
  );
  const client2 = new Client({ name: "gate2-client-2", version: "1.0.0" });
  const [client2Transport, server2Transport] = InMemoryTransport.createLinkedPair();

  try {
    await server1.connect(server1Transport);
    await client1.connect(client1Transport);
    await server2.connect(server2Transport);
    await client2.connect(client2Transport);

    const openRes = await client1.callTool({
      name: "open_workspace",
      arguments: { path: parent },
    });
    const workspaceId = (openRes.structuredContent as any)?.workspaceId;
    assert.ok(workspaceId);

    // Session 1 starts a command crossing 60ms fast path with client signal
    const postHandoffAbortController = new AbortController();
    const gate2BashRes = await client1.callTool(
      {
        name: "bash",
        arguments: {
          workspaceId,
          command: "node -e \"setTimeout(() => console.log('gate2-survived'), 400)\"",
        },
      },
      undefined,
      { signal: postHandoffAbortController.signal },
    );

    const gate2Data = gate2BashRes.structuredContent as any;
    assert.ok(gate2Data.operationId, "operationId must be returned");
    const gate2OpId = gate2Data.operationId;

    // Post-handoff: client request/session disconnects
    postHandoffAbortController.abort();

    // Verify in manager that the operation is NOT cancelled
    const liveOp = manager.get(gate2OpId);
    assert.ok(liveOp.status === "running" || liveOp.status === "queued", "Operation must not be cancelled after handoff");

    // Concurrently, Session 2 performs read_files and checks status - no head-of-line blocking!
    const session2Read = await client2.callTool({
      name: "read_files",
      arguments: {
        workspaceId,
        files: [{ path: "sample.txt" }],
      },
    });
    assert.equal(Boolean(session2Read.isError), false);
    const readResult = (session2Read.structuredContent as any)?.result;
    assert.match(readResult, /gate2 test content/);

    // Concurrently, Session 2 polls long_task_status for the ongoing operation
    const session2Status = await client2.callTool({
      name: "long_task_status",
      arguments: { operationId: gate2OpId },
    });
    assert.equal(Boolean(session2Status.isError), false);
    assert.ok((session2Status.structuredContent as any).operationId === gate2OpId);

    // Both sessions can poll the same retained operation concurrently.
    const [session1ConcurrentStatus, session2ConcurrentStatus] = await Promise.all([
      client1.callTool({
        name: "long_task_status",
        arguments: { operationId: gate2OpId },
      }),
      client2.callTool({
        name: "long_task_status",
        arguments: { operationId: gate2OpId },
      }),
    ]);
    assert.equal(
      (session1ConcurrentStatus.structuredContent as any).operationId,
      gate2OpId,
    );
    assert.equal(
      (session2ConcurrentStatus.structuredContent as any).operationId,
      gate2OpId,
    );

    // Wait for the background operation to complete to verify full survival
    let gate2FinalStatus: any;
    for (let i = 0; i < 50; i++) {
      const statusRes = await client2.callTool({
        name: "long_task_status",
        arguments: { operationId: gate2OpId },
      });
      gate2FinalStatus = statusRes.structuredContent as any;
      if (gate2FinalStatus.status === "succeeded" || gate2FinalStatus.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(gate2FinalStatus.status, "succeeded", "Operation must succeed despite client abort");
    assert.match(gate2FinalStatus.result.output, /gate2-survived/);

  } finally {
    await client1.close().catch(() => undefined);
    await client2.close().catch(() => undefined);
    await server1.close().catch(() => undefined);
    await server2.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined);
  }
});
