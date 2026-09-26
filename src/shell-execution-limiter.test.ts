import assert from "node:assert/strict";
import { ShellExecutionLimiter } from "./shell-execution-limiter.js";

const limiter = new ShellExecutionLimiter({
  maxActive: 2,
  maxActivePerKey: 1,
  maxQueued: 2,
  queueTimeoutMs: 5_000,
});

const a1 = await limiter.acquire("a");
const b1 = await limiter.acquire("b");
assert.deepEqual(limiter.snapshot(), {
  active: 2,
  queued: 0,
  activeByKey: { a: 1, b: 1 },
});

let a2Started = false;
const a2Promise = limiter.acquire("a").then((lease) => {
  a2Started = true;
  return lease;
});
const c1Promise = limiter.acquire("c");
await Promise.resolve();
assert.equal(a2Started, false);
assert.equal(limiter.snapshot().queued, 2);

await assert.rejects(
  () => limiter.acquire("d"),
  /queue is full/i,
);

b1.release();
const c1 = await c1Promise;
assert.equal(a2Started, false, "per-workspace limit should keep a queued");
c1.release();

a1.release();
const a2 = await a2Promise;
assert.equal(a2Started, true);
a2.release();

const abortLimiter = new ShellExecutionLimiter({
  maxActive: 1,
  maxActivePerKey: 1,
  maxQueued: 1,
  queueTimeoutMs: 5_000,
});
const held = await abortLimiter.acquire("a");
const controller = new AbortController();
const waiting = abortLimiter.acquire("b", controller.signal);
controller.abort();
await assert.rejects(() => waiting, /cancelled while waiting/i);
held.release();
assert.equal(abortLimiter.snapshot().queued, 0);
