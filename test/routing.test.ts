import assert from "node:assert/strict";
import test from "node:test";

test("Turkish local-context queries initially search the Turkish catalog", async () => {
  const module = await import("../src/routing.js").catch(() => ({}));
  const selectInitialLocales = (module as { selectInitialLocales?: (query: string) => string[] }).selectInitialLocales;

  assert.deepEqual(selectInitialLocales?.("Türkiye'de TurkNet deneyimleri neler?"), ["tr"]);
});

test("explicit locale preferences override automatic language detection", async () => {
  const { selectInitialLocales } = await import("../src/routing.js");

  assert.deepEqual(selectInitialLocales("Türkiye fiyatları", "en"), ["en"]);
  assert.deepEqual(selectInitialLocales("global hardware research", "tr"), ["tr"]);
  assert.deepEqual(selectInitialLocales("mixed research", "both"), ["tr", "en"]);
});
