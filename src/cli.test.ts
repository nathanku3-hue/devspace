import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const configDir = mkdtempSync(join(tmpdir(), "devspace-cli-provider-"));
  try {
    const env = { ...process.env, DEVSPACE_CONFIG_DIR: configDir };
    writeFileSync(
      join(configDir, "config.json"),
      `\uFEFF${JSON.stringify({ port: 7676 }, null, 2)}\n`,
      "utf8",
    );
    execFileSync(
      "node",
      ["--import", "tsx", "src/cli.ts", "config", "set", "chatSessionProvider", "chatshare"],
      { encoding: "utf8", env },
    );
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as {
      port?: number;
      chatSessionProvider?: string;
    };
    assert.equal(config.port, 7676);
    assert.equal(config.chatSessionProvider, "chatshare");

    const invalid = spawnSync(
      "node",
      ["--import", "tsx", "src/cli.ts", "config", "set", "chatSessionProvider", "invalid"],
      { encoding: "utf8", env },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /chatSessionProvider must be `chatgpt` or `chatshare`/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
