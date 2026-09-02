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
    "donanimarsivi",
    "technopat",
    "stack-overflow",
    "super-user",
    "server-fault",
    "hacker-news",
    "github-discussions",
  ]);
  assert.ok(catalog.every((source) => source.robotsStatus && source.termsStatus));
});
