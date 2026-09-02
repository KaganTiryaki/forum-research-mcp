import assert from "node:assert/strict";
import test from "node:test";
import { parseSitemapEntries } from "../src/sitemap.js";

test("sitemap parser keeps URL, lastmod, and a safe title hint", () => {
  const entries = parseSitemapEntries(`<?xml version="1.0"?><urlset>
    <url><loc>https://forum.example.test/konu/rtx-5070-deneyimi.1/</loc><lastmod>2026-09-01</lastmod></url>
  </urlset>`);

  assert.deepEqual(entries, [{
    url: "https://forum.example.test/konu/rtx-5070-deneyimi.1/",
    publishedAt: "2026-09-01",
    titleHint: "rtx 5070 deneyimi",
  }]);
});

test("malformed XML does not yield URLs", () => {
  assert.deepEqual(parseSitemapEntries("<url><loc>https://forum.example.test/konu/a"), []);
});
