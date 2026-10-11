import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashRuntimeDist, inspectRuntimeIdentity } from "./runtime-identity.js";

const dir = await mkdtemp(join(tmpdir(), "devspace-build-identity-test-"));
try {
  const code = join(dir, "server.js");
  await writeFile(code, "export const compiled = true;\n", "utf8");
  const digest = hashRuntimeDist(dir);
  const identityPath = join(dir, "build-identity.json");
  const buildTime = "2026-10-10T12:00:00.000Z";
  await writeFile(identityPath, JSON.stringify({
    schemaVersion: "devspace-runtime/v1",
    toolSchemaRevision: "repo-custody-1",
    sourceHeadSha: "a".repeat(40),
    sourceDirty: true,
    binaryDigestSha256: digest,
    filesHashed: 1,
    builtAt: buildTime,
  }));

  const verified = inspectRuntimeIdentity(dir, "2026-10-10T12:30:00.000Z");
  assert.equal(verified.status, "DISK_BUILD_VERIFIED");
  assert.equal(verified.binaryDigestSha256, digest);
  assert.match(verified.receiptDigestSha256, /^[a-f0-9]{64}$/);

  const stale = inspectRuntimeIdentity(dir, "2026-10-10T11:00:00.000Z");
  assert.equal(stale.status, "STALE_RUNTIME");

  await writeFile(code, "export const compiled = false;\n", "utf8");
  const mismatched = inspectRuntimeIdentity(dir, "2026-10-10T12:30:00.000Z");
  assert.equal(mismatched.status, "UNVERIFIED");
  assert.equal(mismatched.binaryDigestSha256, null, "stale manifest digest must not be advertised as verified");
  await rm(identityPath);
  assert.equal(inspectRuntimeIdentity(dir, "2026-10-10T12:30:00.000Z").status, "UNVERIFIED");
} finally {
  await rm(dir, { recursive: true, force: true });
}
