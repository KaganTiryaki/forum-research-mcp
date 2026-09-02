import assert from "node:assert/strict";
import test from "node:test";

test("per-source rate limiter waits before a second request to the same source", async () => {
  const module = await import("../src/rate-limit.js").catch(() => ({}));
  const SourceRateLimiter = (module as {
    SourceRateLimiter?: new (now: () => number, wait: (milliseconds: number) => Promise<void>) => { acquire: (sourceId: string, intervalMs: number) => Promise<void> };
  }).SourceRateLimiter;
  let now = 1_000;
  const waits: number[] = [];
  const limiter = SourceRateLimiter
    ? new SourceRateLimiter(() => now, async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      })
    : undefined;

  await limiter?.acquire("source-a", 1_500);
  now = 1_100;
  await limiter?.acquire("source-a", 1_500);

  assert.deepEqual(waits, [1_400]);
});

test("concurrent requests to one source reserve separate rate-limit slots", async () => {
  const { SourceRateLimiter } = await import("../src/rate-limit.js");
  let now = 0;
  const waits: number[] = [];
  const releases: Array<() => void> = [];
  const completedAt: number[] = [];
  const limiter = new SourceRateLimiter(() => now, (milliseconds) => {
    waits.push(milliseconds);
    return new Promise<void>((resolve) => {
      releases.push(() => {
        now += milliseconds;
        resolve();
      });
    });
  });

  await limiter.acquire("source-a", 100);
  const first = limiter.acquire("source-a", 100).then(() => completedAt.push(now));
  const second = limiter.acquire("source-a", 100).then(() => completedAt.push(now));
  await Promise.resolve();

  assert.equal(releases.length, 1);
  releases.shift()?.();
  await first;
  await Promise.resolve();
  assert.equal(releases.length, 1);
  releases.shift()?.();
  await second;

  assert.deepEqual(waits, [100, 100]);
  assert.deepEqual(completedAt, [100, 200]);
});
