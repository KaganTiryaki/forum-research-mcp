import assert from "node:assert/strict";
import test from "node:test";

test("research cache stores compact discovery metadata with an expiry", async () => {
  const module = await import("../src/cache.js").catch(() => ({}));
  const ResearchCache = (module as { ResearchCache?: new (path: string) => { set: (key: string, value: unknown, ttlMs: number) => void; get: (key: string) => unknown; close: () => void } }).ResearchCache;
  const cache = ResearchCache ? new ResearchCache(":memory:") : undefined;
  const evidence = { title: "Thread", url: "https://example.com/thread", excerpt: "short evidence" };

  cache?.set("research:tr:query", evidence, 60_000);
  assert.deepEqual(cache?.get("research:tr:query"), evidence);
  cache?.close();
});

test("research cache never returns expired discovery metadata", async () => {
  const { ResearchCache } = await import("../src/cache.js");
  let now = 1_000;
  const cache = new ResearchCache(":memory:", () => now);

  cache.set("expired", { url: "https://example.com/old" }, 100);
  now = 1_101;

  assert.equal(cache.get("expired"), undefined);
  cache.close();
});
