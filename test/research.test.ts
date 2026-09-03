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
        read: async () => ({ sourceId: "donanimarsivi", sourceName: "DA", url: "https://forum.donanimarsivi.com/a", title: "Ekran kartı kullanıcı deneyimi", excerpt: "Ekran kartı için doğrudan sayfa kanıtı" }),
      })
    : undefined;

  const result = await service?.research?.({ query: "ekran kartı", locale: "tr" });

  assert.deepEqual(result?.evidence.map(({ excerpt }) => excerpt), ["Ekran kartı için doğrudan sayfa kanıtı"]);
  assert.match(result?.summary ?? "", /1 directly read thread/i);
});

test("research passes the primary query and variants to focused direct reads", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  let capturedFocus: { query: string; variants: string[] } | undefined;
  const service = new ForumResearchService({
    discover: async () => [{
      sourceId: "gcaptain",
      sourceName: "gCaptain",
      url: "https://forum.gcaptain.com/t/generating-and-maintaining-shipboard-work-lists/63622",
      title: "Generating and maintaining shipboard work lists",
      snippet: "",
    }],
    read: async ({ sourceId, url }, focus) => {
      capturedFocus = focus;
      return {
        sourceId,
        sourceName: "gCaptain",
        url,
        title: "Generating and maintaining shipboard work lists",
        excerpt: "NS5 ship maintenance and Planned Maintenance System experience.",
      };
    },
  });

  const result = await service.research({
    query: "gemi bakım yazılımı",
    queryVariants: ["NS5 ship maintenance", "planned maintenance system PMS"],
    locale: "en",
  });

  assert.deepEqual(capturedFocus, {
    query: "gemi bakım yazılımı",
    variants: ["NS5 ship maintenance", "planned maintenance system PMS"],
  });
  assert.equal(result.status, "partial");
});

test("default maritime variants remain available to the direct evidence gate", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async () => [{
      sourceId: "gcaptain",
      sourceName: "gCaptain",
      url: "https://forum.gcaptain.com/t/generating-and-maintaining-shipboard-work-lists/63622",
      title: "Generating and maintaining shipboard work lists",
      snippet: "",
    }],
    read: async ({ sourceId, url }) => ({
      sourceId,
      sourceName: "gCaptain",
      url,
      title: "Generating and maintaining shipboard work lists",
      excerpt: "NS5 maintenance and the Planned Maintenance System reduce forgotten jobs during crew handover.",
    }),
  });

  const result = await service.research({ query: "gemi bakım yazılımı kullanıcı deneyimleri", locale: "en" });

  assert.equal(result.status, "partial");
  assert.equal(result.evidence.length, 1);
});

test("research reads a higher-scored sampled candidate before lower-scored candidates from the same source", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const attempted: string[] = [];
  const service = new ForumResearchService({
    discover: async () => [
      { sourceId: "gcaptain", sourceName: "gCaptain", url: "https://forum.gcaptain.com/t/low-one/1", title: "Inspection notice", snippet: "", score: 1 },
      { sourceId: "gcaptain", sourceName: "gCaptain", url: "https://forum.gcaptain.com/t/low-two/2", title: "Vessel notice", snippet: "", score: 1 },
      { sourceId: "gcaptain", sourceName: "gCaptain", url: "https://forum.gcaptain.com/t/work-lists/63622", title: "Generating and maintaining shipboard work lists", snippet: "", score: 9 },
    ],
    read: async ({ sourceId, url }) => {
      attempted.push(url);
      return {
        sourceId,
        sourceName: "gCaptain",
        url,
        title: "Generating and maintaining shipboard work lists",
        excerpt: "NS5 maintenance and Planned Maintenance System experience.",
      };
    },
  });

  await service.research({ query: "gemi bakım yazılımı", queryVariants: ["NS5 ship maintenance"], locale: "en", depth: "quick" });

  assert.equal(attempted[0], "https://forum.gcaptain.com/t/work-lists/63622");
});

test("unhappiest path: six irrelevant system pages are not reported as evidence", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const systemPages = ["Forum Kuralları", "Gizlilik Bildirimi", "Sık Sorulan Sorular", "Kullanım Koşulları", "Üyelik", "Giriş Yap"];
  const service = new ForumResearchService({
    discover: async () => systemPages.map((title, index) => ({
      sourceId: index < 3 ? "technopat" : "donanimarsivi",
      sourceName: "TR forum",
      url: `https://forum.example.test/thread-${index}`,
      title,
      snippet: "Genel forum yönetim sayfası",
    })),
    read: async ({ sourceId, url }) => ({
      sourceId,
      sourceName: "TR forum",
      url,
      title: systemPages[Number(url.at(-1))]!,
      excerpt: "Kullanım koşulları, üyelik ve gizlilik bilgileri.",
    }),
  });

  const result = await service.research({ query: "gemi bakım yazılımı kullanıcı deneyimleri", locale: "tr", depth: "deep" });

  assert.deepEqual(result.evidence, []);
  assert.equal(result.status, "coverage_limited");
  assert.equal(result.coverage.irrelevantResultsRejected, 6);
  assert.ok(result.issues.some((issue) => issue.code === "irrelevant_result"));
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

test("search normalizes variants and caps discovery requests by depth", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const calls: Array<{ queryVariants?: string[]; maxRequests?: number }> = [];
  const service = new ForumResearchService({
    discover: async (input) => {
      calls.push(input);
      return { threads: [], warnings: [] };
    },
  });

  const result = await service.search({
    query: "gemi bakım yazılımı",
    locale: "tr",
    depth: "quick",
    queryVariants: [" AMOS gemi bakım ", "AMOS gemi bakım", "ShipManager planned maintenance"],
  });

  assert.deepEqual(calls[0]?.queryVariants, ["AMOS gemi bakım", "ShipManager planned maintenance"]);
  assert.equal(calls[0]?.maxRequests, 6);
  assert.deepEqual(result.coverage.requestedQueries, ["gemi bakım yazılımı", "AMOS gemi bakım", "ShipManager planned maintenance"]);
  assert.deepEqual(result.coverage.queriesUsed, []);
});

test("maritime maintenance queries receive bounded specialist variants when none are supplied", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({ discover: async () => ({ threads: [], warnings: [] }) });

  const result = await service.search({ query: "gemi bakım yazılımı deneyimleri", locale: "tr", depth: "deep" });

  assert.ok(result.query_variants.includes("AMOS gemi bakım"));
  assert.ok(result.query_variants.includes("gemi bakım yönetim sistemi"));
  assert.ok(result.query_variants.length <= 12);
});

test("research reports coverage_limited when a requested variant lacks three successful sources", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async () => ({
      threads: [],
      warnings: [],
      sourceOutcomes: [
        { query: "gemi bakım yazılımı", sourceId: "donanimarsivi", status: "success", discoveredCount: 0, strategy: "direct_search", attemptOrdinal: 1 },
        { query: "gemi bakım yazılımı", sourceId: "technopat", status: "success", discoveredCount: 0, strategy: "direct_search", attemptOrdinal: 2 },
        { query: "gemi bakım yazılımı", sourceId: "donanimhaber", status: "success", discoveredCount: 0, strategy: "direct_search", attemptOrdinal: 3 },
        { query: "AMOS gemi bakım", sourceId: "donanimarsivi", status: "success", discoveredCount: 0, strategy: "direct_search", attemptOrdinal: 1 },
        { query: "AMOS gemi bakım", sourceId: "technopat", status: "success", discoveredCount: 0, strategy: "direct_search", attemptOrdinal: 2 },
      ],
    }),
  });

  const result = await service.research({
    query: "gemi bakım yazılımı",
    queryVariants: ["AMOS gemi bakım"],
    locale: "tr",
    depth: "deep",
  });

  assert.equal(result.status, "coverage_limited");
  assert.equal(result.coverage_complete_for_no_relevant_evidence, false);
  assert.deepEqual(result.coverage.requestedQueries, ["gemi bakım yazılımı", "AMOS gemi bakım"]);
  assert.deepEqual(result.coverage.executedQueries, ["gemi bakım yazılımı", "AMOS gemi bakım"]);
  assert.equal(result.coverage.perQuery.find((item) => item.query === "AMOS gemi bakım")?.successfulSources.length, 2);
  assert.match(result.findings.coverageWarning ?? "", /maritime query-search source/i);
});

test("sampled indexes are locally evaluated without being reported as remote query searches", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const queries = ["gemi bakım yazılımı", "NS5 ship maintenance"];
  const service = new ForumResearchService({
    discover: async () => ({
      threads: [],
      warnings: [],
      irrelevantResultsRejected: 2,
      duplicateResultsRejected: 7,
      sourceOutcomes: [{
        kind: "sampled_index" as const,
        sourceId: "gcaptain",
        indexUrl: "https://forum.gcaptain.com/sitemap_3.xml",
        queriesEvaluated: queries,
        status: "success" as const,
        // A sitemap may expose twenty raw entries while only two unique topic
        // candidates survive canonical URL de-duplication.
        discoveredCount: 20,
        uniqueCandidateCount: 2,
        strategy: "category_index" as const,
        attemptOrdinal: 3,
      }],
    }),
  });

  const result = await service.research({ query: queries[0]!, queryVariants: [queries[1]!], locale: "en", depth: "deep" });

  assert.deepEqual(result.coverage.executedQueries, []);
  assert.deepEqual(result.coverage.locallyEvaluatedQueries, queries);
  assert.deepEqual(result.coverage.sampledIndexSources, ["gcaptain"]);
  assert.equal(result.coverage.sampledIndexes[0]?.uniqueCandidates, 2);
  assert.equal(result.coverage.duplicateResultsRejected, 7);
  assert.equal(result.coverage.perQuery[0]?.querySearchSuccessfulSources.length, 0);
  assert.deepEqual(result.coverage.perQuery[0]?.sampledIndexMatchedSources, ["gcaptain"]);
  assert.equal(result.coverage_complete_for_no_relevant_evidence, false);
  assert.equal(result.status, "coverage_limited");
  assert.match(result.findings.coverageWarning ?? "", /locally evaluated|not remotely searched/i);
});

test("failed discovery outcomes are returned as structured discovery failures", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const service = new ForumResearchService({
    discover: async () => ({
      threads: [],
      warnings: [],
      sourceOutcomes: [{
        kind: "sampled_index" as const,
        sourceId: "gcaptain",
        indexUrl: "https://forum.gcaptain.com/sitemap.xml",
        queriesEvaluated: ["gemi bakım yazılımı"],
        status: "failed" as const,
        discoveredCount: 0,
        strategy: "category_index" as const,
        attemptOrdinal: 1,
      }],
    }),
  });

  const result = await service.search({ query: "gemi bakım yazılımı", locale: "en" });

  assert.deepEqual(result.coverage.failedSources, ["gcaptain"]);
  assert.ok(result.issues.some((issue) => issue.code === "discovery_failed" && issue.sourceId === "gcaptain"));
});

test("research returns no_relevant_evidence only after every non-maritime query has three successful sources", async () => {
  const { ForumResearchService } = await import("../src/research.js");
  const queries = ["programming editor experience", "editor integration"];
  const sourceIds = ["stack-overflow", "super-user", "server-fault"];
  const service = new ForumResearchService({
    discover: async () => ({
      threads: [],
      warnings: [],
      sourceOutcomes: queries.flatMap((query) => sourceIds.map((sourceId, index) => ({
        query, sourceId, status: "success" as const, discoveredCount: 0, strategy: "direct_search" as const, attemptOrdinal: index + 1,
      }))),
    }),
  });

  const result = await service.research({ query: queries[0]!, queryVariants: [queries[1]!], locale: "en", depth: "deep" });

  assert.equal(result.status, "no_relevant_evidence");
  assert.equal(result.coverage_complete_for_no_relevant_evidence, true);
  assert.deepEqual(result.coverage.queriesUsed, queries);
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

  const result = await service.research({ query: "direct evidence", locale: "en", depth: "quick" });

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

  const result = await service.research({ query: "Türkiye fallback evidence", locale: "auto", depth: "standard" });

  assert.deepEqual(result.locales, ["tr", "en"]);
  assert.equal(result.expandedToBoth, true);
  assert.deepEqual(result.evidence.map((item) => item.sourceId), ["hacker-news"]);
  assert.match(result.warnings.join(" "), /direct evidence.*expanded|expanded.*direct evidence/i);
});
