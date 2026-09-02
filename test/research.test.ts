import assert from "node:assert/strict";
import test from "node:test";
import { ResearchCache } from "../src/cache.js";

test("auto research expands to the other locale when initial evidence is insufficient", async () => {
  const module = await import("../src/research.js").catch(() => ({}));
  const ForumResearchService = (module as {
    ForumResearchService?: new (dependencies: unknown) => { search: (input: unknown) => Promise<{ locales: string[]; expandedToBoth: boolean; threads: unknown[] }> };
  }).ForumResearchService;
  const service = ForumResearchService
    ? new ForumResearchService({
        discover: async ({ sources }: { sources: Array<{ locale: string }> }) =>
          sources[0]?.locale === "tr"
            ? [{ sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "A", snippet: "a" }]
            : [
                { sourceId: "stack-overflow", sourceName: "SO", url: "https://stackoverflow.com/a", title: "B", snippet: "b" },
                { sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/a", title: "C", snippet: "c" },
                { sourceId: "reddit", sourceName: "Reddit", url: "https://www.reddit.com/a", title: "D", snippet: "d" },
              ],
      })
    : undefined;

  const result = await service?.search({ query: "Türkiye'de internet deneyimi", locale: "auto" });

  assert.deepEqual(result?.locales, ["tr", "en"]);
  assert.equal(result?.expandedToBoth, true);
  assert.equal(result?.threads.length, 4);
});

test("research evidence comes from direct thread reads rather than discovery snippets", async () => {
  const module = await import("../src/research.js").catch(() => ({}));
  const ForumResearchService = (module as {
    ForumResearchService?: new (dependencies: unknown) => { research: (input: unknown) => Promise<{ evidence: Array<{ excerpt: string }>; summary: string }> };
  }).ForumResearchService;
  const service = ForumResearchService
    ? new ForumResearchService({
        discover: async () => [{ sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "Search title", snippet: "search snippet" }],
        read: async () => ({ sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "Thread title", excerpt: "direct page evidence" }),
      })
    : undefined;

  const result = await service?.research?.({ query: "ekran kartı", locale: "tr" });

  assert.deepEqual(result?.evidence.map(({ excerpt }) => excerpt), ["direct page evidence"]);
  assert.match(result?.summary ?? "", /1 directly read thread/i);
});

test("search caches discovery metadata instead of repeating identical source requests", async () => {
  const module = await import("../src/research.js");
  let calls = 0;
  const cache = new ResearchCache(":memory:");
  const service = new module.ForumResearchService({
    cache,
    discover: async () => {
      calls += 1;
      return [{ sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "A", snippet: "a" }];
    },
  });

  await service.search({ query: "aynı sorgu", locale: "tr" });
  await service.search({ query: "aynı sorgu", locale: "tr" });
  cache.close();

  assert.equal(calls, 1);
});

test("auto search survives a failed initial locale by returning fallback-locale results", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async ({ sources }) => {
      if (sources[0]?.locale === "tr") throw new Error("temporary network failure");
      return [{ sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/item?id=1", title: "Fallback", snippet: "evidence" }];
    },
  });

  const result = await service.search({ query: "Türkiye'de yeni teknoloji", locale: "auto" })
    .catch((error: Error) => ({ locales: [], threads: [], expandedToBoth: false, warnings: [error.message] }));

  assert.deepEqual(result.locales, ["tr", "en"]);
  assert.equal(result.threads.length, 1);
  assert.match(result.warnings.join(" "), /temporary network failure/i);
});

test("both-locale search preserves English results when Turkish discovery fails", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async ({ sources }) => {
      if (sources[0]?.locale === "tr") throw new Error("Turkish source outage");
      return [{ sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/item?id=2", title: "English result", snippet: "evidence" }];
    },
  });

  const result = await service.search({ query: "cross-language research", locale: "both" });

  assert.deepEqual(result.locales, ["tr", "en"]);
  assert.equal(result.threads.length, 1);
  assert.match(result.warnings.join(" "), /Turkish source outage/i);
});

test("search preserves per-source warnings from partial direct discovery", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async () => ({
      threads: [{ sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/item?id=3", title: "Result", snippet: "" }],
      warnings: ["Reddit discovery failed: access blocked (HTTP 429); no retry attempted"],
    }),
  });

  const result = await service.search({ query: "direct search", locale: "en" });

  assert.deepEqual(result.threads.map((thread) => thread.sourceId), ["hacker-news"]);
  assert.match(result.warnings.join(" "), /Reddit.*HTTP 429/i);
});

test("search reports an invalid source filter without calling discovery", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  let calls = 0;
  const service = new ForumResearchService({
    discover: async () => {
      calls += 1;
      return [];
    },
  });

  const result = await service.search({ query: "test query", locale: "both", sources: ["not-a-source"] });

  assert.equal(calls, 0);
  assert.match(result.warnings.join(" "), /requested source|not enabled/i);
});

test("research returns an explicit empty evidence pack when every direct read fails", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async () => [
      { sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "A", snippet: "search only" },
      { sourceId: "technopat", sourceName: "Technopat", url: "https://www.technopat.net/b", title: "B", snippet: "search only" },
    ],
    read: async ({ url }) => {
      throw new Error(`blocked direct read: ${url}`);
    },
  });

  const result = await service.research({ query: "failure case", locale: "en" });

  assert.deepEqual(result.evidence, []);
  assert.match(result.summary, /^0 directly read threads/);
  assert.match(result.warnings.join(" "), /do not treat discovery snippets as findings/i);
});

test("quick research samples distinct sources before reading more threads from one source", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const attempted: string[] = [];
  const service = new ForumResearchService({
    discover: async () => [
      { sourceId: "stack-overflow", sourceName: "SO", url: "https://stackoverflow.com/questions/1/a", title: "A", snippet: "" },
      { sourceId: "stack-overflow", sourceName: "SO", url: "https://stackoverflow.com/questions/2/b", title: "B", snippet: "" },
      { sourceId: "stack-overflow", sourceName: "SO", url: "https://stackoverflow.com/questions/3/c", title: "C", snippet: "" },
      { sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/item?id=4", title: "D", snippet: "" },
    ],
    read: async ({ sourceId, url }) => {
      attempted.push(url);
      if (sourceId === "stack-overflow") throw new Error("blocked");
      return { sourceId, sourceName: "HN", url, title: "D", excerpt: "direct evidence" };
    },
  });

  const result = await service.research({ query: "source diversity", locale: "en", depth: "quick" });

  assert.equal(attempted.length, 3);
  assert.ok(attempted.includes("https://news.ycombinator.com/item?id=4"));
  assert.deepEqual(result.evidence.map((item) => item.sourceId), ["hacker-news"]);
});

test("auto research expands languages when discovered threads produce no direct evidence", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async ({ sources }) => sources[0]?.locale === "tr"
      ? [
          { sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/konu/a", title: "A", snippet: "" },
          { sourceId: "technopat", sourceName: "Technopat", url: "https://www.technopat.net/sosyal/konu/b", title: "B", snippet: "" },
          { sourceId: "r10", sourceName: "R10", url: "https://www.r10.net/konu/c", title: "C", snippet: "" },
        ]
      : [{ sourceId: "hacker-news", sourceName: "HN", url: "https://news.ycombinator.com/item?id=5", title: "Fallback", snippet: "" }],
    read: async ({ sourceId, url }) => {
      if (sourceId !== "hacker-news") throw new Error("initial locale blocked");
      return { sourceId, sourceName: "HN", url, title: "Fallback", excerpt: "readable fallback evidence" };
    },
  });

  const result = await service.research({ query: "Türkiye kullanıcı deneyimi", locale: "auto", depth: "standard" });

  assert.deepEqual(result.locales, ["tr", "en"]);
  assert.equal(result.expandedToBoth, true);
  assert.deepEqual(result.evidence.map((item) => item.sourceId), ["hacker-news"]);
  assert.match(result.warnings.join(" "), /direct evidence.*expanded|expanded.*direct evidence/i);
});
