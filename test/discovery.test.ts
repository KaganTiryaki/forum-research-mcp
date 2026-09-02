import assert from "node:assert/strict";
import test from "node:test";
import { catalog, getSource } from "../src/catalog.js";
import { discoverThreads } from "../src/discovery.js";
import { SourceRateLimiter } from "../src/rate-limit.js";

function source(id: string) {
  const match = getSource(id);
  assert.ok(match, `missing catalog source ${id}`);
  return match;
}

test("Reddit discovery works directly without an API key", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    requested.push(String(input));
    return new Response(JSON.stringify({
      data: {
        children: [{
          data: {
            title: "Türkiye'de fiber deneyimi",
            permalink: "/r/Turkey/comments/abc123/fiber_deneyimi/",
            selftext: "Kurulum ve hız hakkındaki kullanıcı deneyimi.",
            created_utc: 1_725_000_000,
            score: 42,
          },
        }],
      },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await discoverThreads({
    query: "fiber deneyimi",
    sources: [source("reddit-tr")],
    fetcher,
  });

  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/www\.reddit\.com\/r\/Turkey\+AskTurkey\+TurkeyJerky\+turkishlearning\/search\.json\?/);
  assert.match(requested[0], /q=fiber(?:\+|%20)deneyimi/);
  assert.match(requested[0], /restrict_sr=1/);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.threads.map(({ sourceId, url, title, score }) => ({ sourceId, url, title, score })), [{
    sourceId: "reddit-tr",
    url: "https://www.reddit.com/r/Turkey/comments/abc123/fiber_deneyimi/",
    title: "Türkiye'de fiber deneyimi",
    score: 42,
  }]);
});

test("direct discovery preserves successful sources when another source is rate limited", async () => {
  const calls = new Map<string, number>();
  const fetcher = (async (input: URL | string) => {
    const url = String(input);
    const host = new URL(url).hostname;
    calls.set(host, (calls.get(host) ?? 0) + 1);
    if (host === "www.reddit.com") return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({
      items: [{
        title: "How to test a TypeScript MCP server?",
        link: "https://stackoverflow.com/questions/12345/test-mcp-server",
        body: "A concrete testing approach.",
        creation_date: 1_725_000_000,
        score: 7,
      }],
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await discoverThreads({
    query: "test MCP server",
    sources: [source("reddit"), source("stack-overflow")],
    fetcher,
  });

  assert.equal(calls.get("www.reddit.com"), 1);
  assert.equal(calls.get("api.stackexchange.com"), 1);
  assert.deepEqual(result.threads.map((thread) => thread.sourceId), ["stack-overflow"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Reddit.*HTTP 429/i);
});

test("GitHub Discussions discovery reads GitHub's public JSON search response", async () => {
  const fetcher = (async () => new Response(JSON.stringify({
    meta: { title: "Discussion search results" },
    payload: {
      blackbirdSearchRoute: {
        results: [{
          title: "Real graphics card experience",
          body: "First-hand details from the discussion author.",
          url: "/example/project/discussions/42",
          created: "2026-08-17T22:35:48.000Z",
          num_comments: 7,
        }],
      },
    },
  }), { headers: { "content-type": "application/json; charset=utf-8" } })) as typeof fetch;

  const result = await discoverThreads({
    query: "graphics card experience",
    sources: [source("github-discussions")],
    fetcher,
    rateLimiter: new SourceRateLimiter(() => 0, async () => undefined),
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.threads.map(({ sourceId, title, url, snippet, publishedAt, score }) => ({ sourceId, title, url, snippet, publishedAt, score })), [{
    sourceId: "github-discussions",
    title: "Real graphics card experience",
    url: "https://github.com/example/project/discussions/42",
    snippet: "First-hand details from the discussion author.",
    publishedAt: "2026-08-17T22:35:48.000Z",
    score: 7,
  }]);
});

test("HTML forum discovery keeps only thread links on the selected source domain", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    requested.push(String(input));
    return new Response(`<!doctype html><html><body>
      <a href="/konu/rtx-5070-kullanici-deneyimleri.12345/">RTX 5070 kullanıcı deneyimleri</a>
      <a href="https://evil.example/konu/sahte">Katalog dışı sonuç</a>
      <a href="/uyeler/test.5/">Kullanıcı profili</a>
    </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;

  const result = await discoverThreads({
    query: "RTX 5070",
    sources: [source("donanimarsivi")],
    fetcher,
  });

  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0]).hostname, "forum.donanimarsivi.com");
  assert.deepEqual(result.threads.map(({ sourceId, url, title }) => ({ sourceId, url, title })), [{
    sourceId: "donanimarsivi",
    url: "https://forum.donanimarsivi.com/konu/rtx-5070-kullanici-deneyimleri.12345/",
    title: "RTX 5070 kullanıcı deneyimleri",
  }]);
});

test("discovery rejects unrelated rules pages before they can be read as evidence", async () => {
  const fetcher = (async () => new Response(`<!doctype html><html><body>
    <a href="/konu/forum-kurallari.1/">Forum Kuralları</a>
    <a href="/konu/gizlilik-bildirimi.2/">Gizlilik Bildirimi</a>
  </body></html>`, { headers: { "content-type": "text/html" } })) as typeof fetch;

  const result = await discoverThreads({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    sources: [source("donanimarsivi")],
    fetcher,
  });

  assert.deepEqual(result.threads, []);
  assert.equal(result.irrelevantResultsRejected, 2);
  assert.equal(result.sourceOutcomes?.[0]?.status, "success");
});

test("sitemap discovery never follows a child sitemap on another domain", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    requested.push(String(input));
    return new Response(`<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://evil.example/sitemap.xml</loc></sitemap>
      <sitemap><loc>https://forum.pchocasi.com.tr/posts.xml</loc></sitemap>
    </sitemapindex>`, { headers: { "content-type": "application/xml" } });
  }) as typeof fetch;

  await discoverThreads({ query: "RTX 5070", sources: [source("pc-hocasi")], fetcher });

  assert.equal(requested.some((url) => new URL(url).hostname === "evil.example"), false);
});

test("HTML discovery reports a 200 bot challenge as a coverage warning", async () => {
  const fetcher = (async () => new Response(`<!doctype html><html><head>
    <title>Just a moment...</title></head><body>Verify you are human</body></html>`, {
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  })) as typeof fetch;

  const result = await discoverThreads({
    query: "hardware",
    sources: [source("donanimarsivi")],
    fetcher,
  });

  assert.deepEqual(result.threads, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /captcha|bot challenge/i);
});

test("discovery cancels a chunked response when its size limit is exceeded", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 4) controller.enqueue(new Uint8Array(700_000));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (async () => new Response(body, {
    headers: { "content-type": "text/html" },
  })) as typeof fetch;

  const result = await discoverThreads({
    query: "large response",
    sources: [source("donanimarsivi")],
    fetcher,
    rateLimiter: new SourceRateLimiter(() => 0, async () => undefined),
  });

  assert.deepEqual(result.threads, []);
  assert.match(result.warnings.join(" "), /size limit/i);
  assert.equal(cancelled, true);
  assert.ok(pulls < 5);
});

test("direct discovery makes no network request when no sources are selected", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response("unexpected");
  }) as typeof fetch;

  const result = await discoverThreads({ query: "anything", sources: [], fetcher });

  assert.equal(calls, 0);
  assert.deepEqual(result, { threads: [], warnings: [] });
});

test("every enabled catalog source has a direct discovery adapter", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = String(input);
    requested.push(url);
    const hostname = new URL(url).hostname;
    if (hostname === "www.reddit.com") {
      return new Response(JSON.stringify({ data: { children: [] } }), { headers: { "content-type": "application/json" } });
    }
    if (hostname === "api.stackexchange.com") {
      return new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } });
    }
    if (hostname === "hn.algolia.com") {
      return new Response(JSON.stringify({ hits: [] }), { headers: { "content-type": "application/json" } });
    }
    if (hostname === "github.com") {
      return new Response(JSON.stringify({ payload: { blackbirdSearchRoute: { results: [] } } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (hostname === "search.donanimhaber.com") {
      return new Response(JSON.stringify({ hash: "fixture", messages: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response("<!doctype html><html><body>No matches</body></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const enabled = catalog.filter((candidate) => candidate.enabled);

  const result = await discoverThreads({
    query: "adapter coverage",
    sources: enabled,
    fetcher,
    rateLimiter: new SourceRateLimiter(() => 0, async () => undefined),
  });

  assert.equal(requested.length, enabled.length);
  assert.deepEqual(result.warnings, []);
});

test("every enabled adapter extracts a canonical thread from a realistic response fixture", async () => {
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stackexchange.com") {
      const site = url.searchParams.get("site");
      const domain = site === "stackoverflow" ? "stackoverflow.com" : `${site}.com`;
      return new Response(JSON.stringify({
        items: [{ title: `${site} adapter fixture`, link: `https://${domain}/questions/12345/example`, body: "Adapter fixture context", creation_date: 1_725_000_000, score: 3 }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "hn.algolia.com") {
      return new Response(JSON.stringify({
        hits: [{ objectID: "8863", title: "Hacker News adapter fixture", story_text: "Adapter fixture context", created_at: "2007-04-04T00:00:00Z", points: 104 }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "github.com") {
      return new Response(JSON.stringify({
        payload: { blackbirdSearchRoute: { results: [{ title: "GitHub adapter fixture", body: "Adapter fixture context", url: "/modelcontextprotocol/typescript-sdk/discussions/42", created: "2026-08-17T00:00:00Z", num_comments: 4 }] } },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "search.donanimhaber.com" && url.pathname.includes("/api/search/messages/")) {
      return new Response(JSON.stringify({
        hash: "fixture-hash",
        messages: [{ id: 7, subject: "Adapter fixture", body: "Adapter fixture context" }],
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "search.donanimhaber.com" && url.pathname.includes("/api/redirect/")) {
      return new Response(null, { status: 302, headers: { location: "https://forum.donanimhaber.com/adapter-fixture-konu-7" } });
    }
    const path = url.hostname === "www.technopat.net"
      ? "/sosyal/konu/ekran-karti-deneyimi.12345/"
      : url.hostname === "sergip.com"
        ? "/forum/123-adapter-fixture.html"
      : "/konu/ekran-karti-deneyimi.12345/";
    return new Response(`<html><body><a href="${path}">Adapter fixture result</a></body></html>`, {
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  const enabled = catalog.filter((candidate) => candidate.enabled);

  for (const candidate of enabled) {
    const result = await discoverThreads({
      query: "adapter fixture",
      sources: [candidate],
      fetcher,
      rateLimiter: new SourceRateLimiter(() => 0, async () => undefined),
    });
    assert.equal(result.warnings.length, 0, candidate.id);
    assert.equal(result.threads.length, 1, candidate.id);
    assert.equal(result.threads[0].sourceId, candidate.id);
    assert.equal(new URL(result.threads[0].url).hostname, candidate.domains[0]);
  }
});
