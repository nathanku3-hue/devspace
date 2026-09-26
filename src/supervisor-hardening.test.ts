import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../scripts/install-devspace-supervisor.ps1", import.meta.url));
const runnerPath = fileURLToPath(new URL("../scripts/devspace-origin-runner.ps1", import.meta.url));
const supervisorPath = fileURLToPath(new URL("../scripts/devspace-supervisor.ps1", import.meta.url));
const installer = await readFile(installerPath, "utf8");
const runner = await readFile(runnerPath, "utf8");
const supervisor = await readFile(supervisorPath, "utf8");

assert.doesNotMatch(installer, /set "NODE_OPTIONS=/i, "origin heap cap must not leak to bash children");
assert.match(installer, /devspace-origin-runner\.ps1/i);
assert.match(installer, /-MaxOldSpaceMb 512/i);
assert.match(installer, /DEVSPACE_SHELL_MAX_ACTIVE=2/i);
assert.match(installer, /DEVSPACE_SHELL_MAX_ACTIVE_PER_WORKSPACE=1/i);
assert.match(installer, /DEVSPACE_SHELL_MAX_OUTPUT_BYTES=8388608/i);
assert.match(installer, /\[switch\]\$ApplyNow/);
assert.match(installer, /Protected DevSpace origin is healthy and active/);

assert.match(runner, /CREATE_SUSPENDED/);
assert.match(runner, /AssignProcessToJobObject/);
assert.match(runner, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
assert.match(runner, /--max-old-space-size=/);
assert.match(runner, /ResumeThread/);
assert.match(supervisor, /Origin wrapper did not stop after node exit/);
assert.match(supervisor, /Stop-ScheduledTask -TaskName \$Config\.originTaskName/);
assert.match(supervisor, /remained Running after forced stop/);

if (process.platform === "win32") {
  for (const scriptPath of [installerPath, runnerPath, supervisorPath]) {
    const parseCommand = [
      "$tokens = $null",
      "$errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(scriptPath)}, [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
    ].join("; ");
    const parsed = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", parseCommand],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    assert.equal(parsed.status, 0, `PowerShell parse failed for ${scriptPath}:\n${parsed.stderr}`);
  }

  const temp = await mkdtemp(join(tmpdir(), "devspace-origin-runner-test-"));
  try {
    const probe = join(temp, "probe.js");
    const childPidPath = join(temp, "child.pid");
    await writeFile(
      probe,
      [
        '"use strict";',
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'if (!process.argv.includes("serve")) process.exit(7);',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });',
        'child.unref();',
        'writeFileSync(join(__dirname, "child.pid"), String(child.pid));',
        'setTimeout(() => process.exit(0), 100);',
        '',
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        runnerPath,
        "-NodeExe",
        process.execPath,
        "-CliPath",
        probe,
        "-Repository",
        temp,
        "-MaxOldSpaceMb",
        "128",
      ],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
    assert.equal(
      result.status,
      0,
      `origin job runner failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    const childPid = Number((await readFile(childPidPath, "utf8")).trim());
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(
      () => process.kill(childPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "closing the origin Job Object must kill surviving descendants",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
