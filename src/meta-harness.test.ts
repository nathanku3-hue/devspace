import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  continueMetaHarness,
  fixedMetaCommand,
  inspectMetaHarnessContinuationReadiness,
  inspectMetaHarnessEntry,
  looksLikeMetaHarnessRepository,
  type MetaHarnessRunner,
} from "./meta-harness.js";

test("Windows Meta-Harness execution routes through WSL bash login shell", () => {
  assert.deepEqual(fixedMetaCommand([], "win32"), {
    executable: "wsl.exe",
    args: ["bash", "-lc", "\"meta-harness\""],
  });
  assert.deepEqual(fixedMetaCommand(["inspect", "--json"], "win32"), {
    executable: "wsl.exe",
    args: ["bash", "-lc", "\"meta-harness\" \"inspect\" \"--json\""],
  });
});

test("non-Windows Meta-Harness execution remains direct", () => {
  assert.deepEqual(fixedMetaCommand(["inspect", "--json"], "linux"), {
    executable: "meta-harness",
    args: ["inspect", "--json"],
  });
});

test("Meta repository detection requires an exact Git root and accepts repo-declared init metadata", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-detect-"));
  const root = join(parent, "repo");
  const nested = join(root, "nested");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".meta-harness-project.json"), "{}\n", "utf8");
    assert.equal(looksLikeMetaHarnessRepository(root), true);
    assert.equal(looksLikeMetaHarnessRepository(nested), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("planner continuation readiness blocks a missing decision-plane current-world pointer", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-continuation-ready-"));
  const root = join(parent, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".meta-harness"), { recursive: true });
    await writeFile(join(root, ".meta-harness", "repo-charter.json"), "{}\n", "utf8");

    assert.deepEqual(inspectMetaHarnessContinuationReadiness(root), {
      status: "BLOCKED",
      blockers: [
        "Meta-Harness repo planning is enabled, but .git/meta-harness/decision-plane-v2/current-world.json is missing; automatic continuation would fail before a current WorldHead is available.",
      ],
    });

    await mkdir(join(root, ".git", "meta-harness", "decision-plane-v2"), { recursive: true });
    await writeFile(join(root, ".git", "meta-harness", "decision-plane-v2", "current-world.json"), "{}\n", "utf8");
    assert.deepEqual(inspectMetaHarnessContinuationReadiness(root), {
      status: "READY",
      blockers: [],
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("declared project startup allows Meta-Harness to bootstrap a missing current-world pointer", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-meta-continuation-bootstrap-"));
  const root = join(parent, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".meta-harness"), { recursive: true });
    await writeFile(join(root, ".meta-harness", "repo-charter.json"), "{}\n", "utf8");
    await writeFile(join(root, ".meta-harness-project.json"), "{}\n", "utf8");

    assert.deepEqual(inspectMetaHarnessContinuationReadiness(root), {
      status: "READY",
      blockers: [],
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("inspect accepts only topology-blind meta-entry/v1 and fixed inspect arguments", async () => {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const runner: MetaHarnessRunner = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ schemaVersion: "meta-entry/v1", action: "CONTINUE", result: "Ship it." })}\n`,
      stderr: "",
    };
  };
  const entry = await inspectMetaHarnessEntry("C:\\repo", runner);
  assert.deepEqual(calls, [{ cwd: "C:\\repo", args: ["inspect", "--json"] }]);
  assert.deepEqual(entry, {
    schemaVersion: "meta-entry/v1",
    action: "CONTINUE",
    result: "Ship it.",
  });
});

test("inspect accepts topology-blind meta-entry/v2 startup context from fixed inspect arguments", async () => {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const runner: MetaHarnessRunner = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: "meta-entry/v2",
        action: "IDLE",
        result: null,
        startupContext: {
          schemaVersion: "project-startup-context/v1",
          status: "READY",
          lines: ["Loop: RUN7", "Next: WAIT"],
          sources: [{ id: "loop", path: "docs/context/state.json", status: "fresh", observedAt: "2026-09-07T14:01:05.000Z" }],
          blockers: [],
        },
      })}\n`,
      stderr: "",
    };
  };
  const entry = await inspectMetaHarnessEntry("C:\\repo", runner);
  assert.deepEqual(calls, [{ cwd: "C:\\repo", args: ["inspect", "--json"] }]);
  assert.equal(entry.schemaVersion, "meta-entry/v2");
  assert.equal(entry.startupContext.status, "READY");
  assert.deepEqual(entry.startupContext.lines, ["Loop: RUN7", "Next: WAIT"]);
});

test("legacy INVALID inspect output is rejected as a recoverable diagnostic rather than exposed as an execution state", async () => {
  const runner: MetaHarnessRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: "meta-entry/v1",
      action: "INVALID",
      result: null,
    }),
    stderr: "",
  });
  await assert.rejects(
    inspectMetaHarnessEntry("C:\\repo", runner),
    /legacy INVALID continuation state.*recoverable inspection diagnostic/i,
  );
});

test("inspect rejects Meta internal topology fields", async () => {
  const runner: MetaHarnessRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: "meta-entry/v1",
      action: "CONTINUE",
      result: null,
      kind: "REPO_WAVE",
    }),
    stderr: "",
  });
  await assert.rejects(
    inspectMetaHarnessEntry("C:\\repo", runner),
    /invalid meta-entry\/v1 contract/i,
  );
});

test("continue invokes only bare Meta entry and preserves nonzero product exits as structured stops", async () => {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const runner: MetaHarnessRunner = async (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    return {
      exitCode: 1,
      stdout: "Need you: provide protected access.\n",
      stderr: "",
    };
  };
  const result = await continueMetaHarness("C:\\repo", runner);
  assert.deepEqual(calls, [{ cwd: "C:\\repo", args: [] }]);
  assert.deepEqual(result, {
    exitCode: 1,
    result: "Need you: provide protected access.",
  });
});

test("continue preserves an empty nonzero exit as a structured stop diagnostic", async () => {
  const runner: MetaHarnessRunner = async () => ({
    exitCode: 7,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(await continueMetaHarness("C:\\repo", runner), {
    exitCode: 7,
    result: "Meta-Harness continuation stopped with exit 7 and no product output.",
  });
});
