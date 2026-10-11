import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsx = (name, testHarness = false) => ({
  name,
  command: process.execPath,
  args: ["--import", "tsx", ...(testHarness ? ["--test"] : []), `src/${name}.test.ts`],
});
const runnerTest = {
  name: "test-runner",
  command: process.execPath,
  args: ["--test", "scripts/run-tests.test.mjs"],
};
const powershell = {
  name: "powershell",
  command: process.execPath,
  args: ["scripts/run-powershell-tests.mjs"],
};

// The original npm test order is preserved; no unrelated Git/SQLite fixtures
// execute concurrently on Windows. Each group gets a retained log and status.
export const TEST_GROUPS = [
  {
    name: "foundation",
    cases: [
      "config", "bash-runtime-policy", "workspace-shell", "shell-execution-limiter",
      "long-task-operations", "long-task-journal", "shell-runtime", "supervisor-hardening",
    ].map((name) => tsx(name)),
  },
  {
    name: "scope",
    cases: [
      "roots", "write-scope", "write-lease", "runtime-identity", "skills",
      "workspaces", "review-checkpoints",
    ].map((name) => tsx(name)),
  },
  {
    name: "auth-mcp",
    cases: [
      ...["device-authorization", "oauth-store", "oauth-discovery", "mcp-transport-mode"].map((name) => tsx(name)),
      tsx("mcp-modern-server", true),
    ],
  },
  {
    name: "files-git",
    cases: ["read-files", "git-publish", "session-artifacts", "cli", "safe-rename"].map((name) => tsx(name)),
  },
  {
    name: "meta-web",
    cases: ["meta-harness", "meta-harness-server", "web-launch", "long-task-control-plane"]
      .map((name) => tsx(name, true)),
  },
  {
    name: "returns",
    cases: ["audit-return", "source-resolve", "review-return"].map((name) => tsx(name, true)),
  },
  { name: "platform", cases: [powershell] },
  { name: "runner", cases: [runnerTest] },
];

export function parseTestArgs(args) {
  const options = { group: undefined, resultsDir: undefined, list: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--list") options.list = true;
    else if ((args[i] === "--group" || args[i] === "--results-dir") && args[i + 1]) {
      const key = args[i] === "--group" ? "group" : "resultsDir";
      options[key] = args[++i];
    } else {
      throw new Error(`Unknown or incomplete test runner option: ${args[i]}`);
    }
  }
  if (options.group && !TEST_GROUPS.some((group) => group.name === options.group)) {
    throw new Error(`Unknown test group: ${options.group}. Use --list to see available groups.`);
  }
  return options;
}

function defaultTimeout() {
  const raw = process.env.DEVSPACE_TEST_CASE_TIMEOUT_MS;
  const value = raw ? Number(raw) : 300_000;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("DEVSPACE_TEST_CASE_TIMEOUT_MS must be a positive integer.");
  }
  return value;
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function runCase(spec, { rootDir, log, output, errorOutput, timeoutMs }) {
  const started = Date.now();
  log.write(`\n=== ${spec.name}: ${spec.command} ${spec.args.join(" ")} ===\n`);
  output.write(`\n[test] ${spec.name}\n`);
  let child;
  let timedOut = false;
  let spawnError;
  let exitCode = null;
  let signal = null;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => { log.write(chunk); output.write(chunk); });
    child.stderr.on("data", (chunk) => { log.write(chunk); errorOutput.write(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
    const outcome = await new Promise((resolve) => {
      child.once("error", (error) => { spawnError = error; resolve({ code: null, signal: null }); });
      child.once("close", (code, terminationSignal) => resolve({ code, signal: terminationSignal }));
    });
    clearTimeout(timer);
    exitCode = outcome.code;
    signal = outcome.signal;
  } catch (error) {
    spawnError = error;
  }
  const status = timedOut ? "timed_out" : spawnError || exitCode !== 0 ? "failed" : "passed";
  const result = {
    name: spec.name,
    status,
    exitCode,
    signal,
    durationMs: Date.now() - started,
    ...(spawnError ? { error: spawnError.message } : {}),
  };
  const line = `[test] ${spec.name}: ${status} (exit ${exitCode ?? "none"}, ${result.durationMs}ms)\n`;
  log.write(line);
  output.write(line);
  return result;
}

async function writeSummary(file, summary) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(summary, null, 2) + "\n");
  await rename(tmp, file);
}

/**
 * Run and preserve every selected group. Any failed or timed-out case makes the
 * aggregate exit code nonzero. No retries or silent skipping.
 */
export async function runTestSuite(groups, {
  rootDir = ROOT,
  resultsRoot = join(ROOT, "test-results"),
  timeoutMs = defaultTimeout(),
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid case timeout.");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(resolve(resultsRoot), runId);
  await mkdir(runDir, { recursive: true });
  const summaryFile = join(runDir, "summary.json");
  const summary = {
    schemaVersion: "devspace-test-results/v1",
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    platform: process.platform,
    nodeVersion: process.version,
    groups: [],
    totals: { passed: 0, failed: 0, timedOut: 0 },
    status: "running",
  };
  await writeSummary(summaryFile, summary);
  for (const group of groups) {
    const groupDirectory = join(runDir, safeName(group.name));
    await mkdir(groupDirectory, { recursive: true });
    const groupLog = createWriteStream(join(groupDirectory, "group.log"), { flags: "wx" });
    const groupResult = { name: group.name, status: "running", cases: [] };
    summary.groups.push(groupResult);
    await writeSummary(summaryFile, summary);
    output.write(`\n===== group: ${group.name} =====\n`);
    try {
      for (const spec of group.cases) {
        const result = await runCase(spec, {
          rootDir, log: groupLog, output, errorOutput, timeoutMs,
        });
        groupResult.cases.push(result);
        if (result.status === "passed") summary.totals.passed++;
        else if (result.status === "timed_out") summary.totals.timedOut++;
        else summary.totals.failed++;
        await writeSummary(summaryFile, summary);
      }
      groupResult.status = groupResult.cases.every((testCase) => testCase.status === "passed")
        ? "passed" : "failed";
    } catch (error) {
      groupResult.status = "failed";
      groupResult.error = error instanceof Error ? error.message : String(error);
      summary.totals.failed++;
      errorOutput.write(`[test] group ${group.name} runner error: ${groupResult.error}\n`);
    } finally {
      groupLog.end();
      await finished(groupLog);
      await writeSummary(summaryFile, summary);
    }
  }
  summary.finishedAt = new Date().toISOString();
  summary.status = summary.totals.failed + summary.totals.timedOut === 0 ? "passed" : "failed";
  await writeSummary(summaryFile, summary);
  output.write(`\n[test] ${summary.status.toUpperCase()}: ${summary.totals.passed} passed, ${summary.totals.failed} failed, ${summary.totals.timedOut} timed out\n[test] evidence: ${runDir}\n`);
  return { exitCode: summary.status === "passed" ? 0 : 1, runDir, summary };
}

async function main() {
  const options = parseTestArgs(process.argv.slice(2));
  if (options.list) {
    for (const group of TEST_GROUPS) console.log(`${group.name}: ${group.cases.map((item) => item.name).join(", ")}`);
    return;
  }
  const selected = options.group ? TEST_GROUPS.filter((group) => group.name === options.group) : TEST_GROUPS;
  const result = await runTestSuite(selected, {
    resultsRoot: options.resultsDir ? resolve(options.resultsDir) : undefined,
  });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[test] runner failure:", error);
    process.exitCode = 1;
  });
}
