import assert from "node:assert/strict";
import test from "node:test";

test("catalog keeps 25 candidates per locale and excludes blocked platforms", async () => {
  const module = await import("../src/catalog.js").catch(() => ({}));
  const catalog = (module as { catalog?: Array<{ id: string; locale: string; enabled: boolean; robotsStatus?: string; termsStatus?: string }> }).catalog ?? [];

  assert.equal(catalog.filter((source) => source.locale === "tr").length, 25);
  assert.equal(catalog.filter((source) => source.locale === "en").length, 25);
  assert.equal(new Set(catalog.filter((source) => source.locale === "tr").map((source) => source.domains[0])).size, 25);
  assert.equal(new Set(catalog.filter((source) => source.locale === "en").map((source) => source.domains[0])).size, 25);
  assert.equal(catalog.some((source) => source.id === "eksi-sozluk" || source.id === "linkedin"), false);
  assert.deepEqual(catalog.filter((source) => source.enabled).map((source) => source.id), [
    "donanimarsivi", "donanimhaber", "technopat", "sergip",
    "stack-overflow", "super-user", "server-fault", "hacker-news", "github-discussions", "gcaptain",
  ]);
  assert.equal(catalog.find((source) => source.id === "reddit-tr")?.disabledReason, "http_403");
  assert.equal(catalog.find((source) => source.id === "denizcilik-fakultesi")?.disabledReason, "login_required");
  assert.deepEqual(catalog.find((source) => source.id === "gcaptain"), {
    id: "gcaptain",
    locale: "en",
    displayName: "gCaptain Professional Mariner Forum",
    domains: ["forum.gcaptain.com"],
    categories: ["maritime", "professional", "engineering"],
    readMethod: "public_html",
    policyStatus: "reference_allowed",
    robotsStatus: "reference_allowed",
    termsStatus: "read_only_assessed",
    rateLimitMs: 1500,
    enabled: true,
    discoveryStrategy: "category_index",
    searchCapability: "sampled_index",
    domainTags: ["maritime", "professional"],
    contentAdapter: "discourse_json",
    categoryIndexes: [
      "https://forum.gcaptain.com/c/professional-mariner-forum/5.json",
      "https://forum.gcaptain.com/c/engineering/16.json",
      "https://forum.gcaptain.com/c/offshore/11.json",
    ],
    discoveryDomains: undefined,
    sitemapUrl: "https://forum.gcaptain.com/sitemap.xml",
    sampleRequestLimit: 8,
    disabledReason: undefined,
  });
  assert.ok(catalog.every((source) => source.robotsStatus && source.termsStatus));
});
