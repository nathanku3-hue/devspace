import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireProfileLease,
  parseProfileLockRecord,
  processExists,
  WebLaunchBrowserError,
} from "./web-launch-browser.js";

test("processExists treats missing PIDs as dead and EPERM-class as present", () => {
  assert.equal(processExists(2_147_483_646), false);
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(-1), true);
  assert.equal(processExists(0), true);
});

test("parseProfileLockRecord fails closed on malformed ownership", () => {
  assert.equal(parseProfileLockRecord("not-json"), undefined);
  assert.equal(parseProfileLockRecord("{}"), undefined);
  assert.equal(parseProfileLockRecord(JSON.stringify({ pid: "1", token: "t", createdAt: "x" })), undefined);
  assert.equal(parseProfileLockRecord(JSON.stringify({ pid: 1, token: "", createdAt: "x" })), undefined);
  assert.deepEqual(
    parseProfileLockRecord(
      JSON.stringify({ pid: 123, token: "abc", createdAt: "2026-08-02T00:00:00.000Z" }),
    ),
    { pid: 123, token: "abc", createdAt: "2026-08-02T00:00:00.000Z" },
  );
});

test("acquireProfileLease reclaims only when recorded PID is provably dead", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-profile-lease-"));
  const profilePath = join(parent, "profile");
  const lockPath = `${profilePath}.devspace.lock`;

  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_646,
        token: "dead-owner-token",
        createdAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const lease = await acquireProfileLease(profilePath, {
      processExists: (pid) => pid === process.pid,
    });
    const body = parseProfileLockRecord(await readFile(lockPath, "utf8"));
    assert.ok(body);
    assert.equal(body.pid, process.pid);
    assert.notEqual(body.token, "dead-owner-token");
    await lease.release();
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("acquireProfileLease refuses live foreign ownership", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-profile-lease-live-"));
  const profilePath = join(parent, "profile");
  const lockPath = `${profilePath}.devspace.lock`;

  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 42,
        token: "live-owner-token",
        createdAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () =>
        acquireProfileLease(profilePath, {
          processExists: () => true,
        }),
      (error: unknown) =>
        error instanceof WebLaunchBrowserError && /already in use/.test(error.message),
    );
    const body = parseProfileLockRecord(await readFile(lockPath, "utf8"));
    assert.equal(body?.token, "live-owner-token");
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("acquireProfileLease fails closed on malformed locks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "devspace-profile-lease-bad-"));
  const profilePath = join(parent, "profile");
  const lockPath = `${profilePath}.devspace.lock`;

  try {
    await writeFile(lockPath, "not-json\n", "utf8");
    await assert.rejects(
      () => acquireProfileLease(profilePath, { processExists: () => false }),
      (error: unknown) =>
        error instanceof WebLaunchBrowserError && /malformed/.test(error.message),
    );
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
