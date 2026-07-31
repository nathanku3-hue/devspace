import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createShutdownHandler } from "./cli.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

{
  const events: string[] = [];
  const exitCodes: number[] = [];
  let releaseClose!: () => void;
  let markCloseStarted!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  const shutdown = createShutdownHandler({
    stopHttpServer: async () => {
      events.push("http-stopped");
    },
    closeApplication: async () => {
      events.push("cleanup-started");
      markCloseStarted();
      await closeGate;
      events.push("cleanup-completed");
    },
    exit: (code) => {
      exitCodes.push(code);
      events.push(`exit-${code}`);
    },
    logError: (message) => {
      events.push(`error-${message}`);
    },
  });

  const pending = shutdown();
  assert.equal(shutdown(), pending);
  await closeStarted;
  assert.deepEqual(events, ["http-stopped", "cleanup-started"]);
  assert.deepEqual(exitCodes, []);

  releaseClose();
  await pending;
  assert.deepEqual(events, [
    "http-stopped",
    "cleanup-started",
    "cleanup-completed",
    "exit-0",
  ]);
  assert.deepEqual(exitCodes, [0]);
}

{
  const exitCodes: number[] = [];
  const errors: string[] = [];
  const shutdown = createShutdownHandler({
    stopHttpServer: async () => undefined,
    closeApplication: async () => {
      throw new Error("deliberate cleanup failure");
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    logError: (message) => {
      errors.push(message);
    },
  });

  await shutdown();
  assert.deepEqual(exitCodes, [1]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /DevSpace shutdown failed: deliberate cleanup failure/);
}
