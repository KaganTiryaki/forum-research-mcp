import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readThread } from "../src/reader.js";
import { SourceRateLimiter } from "../src/rate-limit.js";

const noWaitLimiter = () => new SourceRateLimiter(() => 0, async () => undefined);
const gcaptainTopicHtml = readFileSync(new URL("./fixtures/gcaptain/topic-63622.html", import.meta.url), "utf8");
const gcaptainTopicJson = readFileSync(new URL("./fixtures/gcaptain/topic-63622.json", import.meta.url), "utf8");

test("thread reader rejects URLs outside the source allowlist", async () => {
  const module = await import("../src/reader.js").catch(() => ({}));
  const readThread = (module as { readThread?: (input: unknown, fetcher: typeof fetch) => Promise<unknown> }).readThread;

  const message = await readThread?.({ sourceId: "donanimarsivi", url: "https://evil.example/thread" }, fetch)
    .then(() => "allowed")
    .catch((error: Error) => error.message);

  assert.match(message ?? "", /not allowlisted/i);
});

test("thread reader keeps Reddit passive even when a public URL is supplied", async () => {
  const message = await readThread(
    { sourceId: "reddit", url: "https://www.reddit.com/r/maritime/comments/1f90me6/example/" },
    fetch,
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.match(message, /not enabled/i);
});

test("thread reader rejects an allowlisted hostname that resolves to a private address", async () => {
  let fetched = false;
  const fetcher = (async () => {
    fetched = true;
    return new Response("<html><body>private service</body></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/dns-rebinding" },
    fetcher,
    noWaitLimiter(),
    async () => [{ address: "127.0.0.1", family: 4 }],
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.equal(fetched, false);
  assert.match(message, /private|reserved|DNS/i);
});

test("thread reader allows an allowlisted hostname with a public DNS address", async () => {
  let fetched = false;
  const fetcher = (async () => {
    fetched = true;
    return new Response("<html><title>Public</title><body>Public forum evidence</body></html>", {
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const evidence = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/public-dns" },
    fetcher,
    noWaitLimiter(),
    async () => [{ address: "192.0.1.1", family: 4 }],
  );

  assert.equal(fetched, true);
  assert.equal(evidence.title, "Public");
});

test("thread reader keeps the public title, short excerpt and published date", async () => {
  const fetcher = (async () => new Response(
    '<html><head><title>Real user thread</title><meta property="article:published_time" content="2026-09-01T10:00:00Z"></head><body><p>Useful first-hand experience.</p></body></html>',
    { headers: { "content-type": "text/html" } },
  )) as typeof fetch;

  const evidence = await readThread({ sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/example" }, fetcher, noWaitLimiter());

  assert.equal(evidence.title, "Real user thread");
  assert.match(evidence.excerpt, /Useful first-hand experience/);
  assert.equal(evidence.publishedAt, "2026-09-01T10:00:00Z");
});

test("thread reader prefers forum post content over navigation and cookie chrome", async () => {
  const pageChrome = `Navigation cookie settings ${"menu ".repeat(140)}`;
  const fetcher = (async () => new Response(
    `<html><head><title>Forum topic</title></head><body><nav>${pageChrome}</nav><main><article><div class="bbWrapper">Actual first-hand user experience about the product.</div></article></main></body></html>`,
    { headers: { "content-type": "text/html" } },
  )) as typeof fetch;

  const evidence = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/content" },
    fetcher,
    noWaitLimiter(),
  );

  assert.match(evidence.excerpt, /^Actual first-hand user experience/);
  assert.doesNotMatch(evidence.excerpt, /cookie settings/i);
});

test("gCaptain reader extracts public Discourse posts instead of application chrome", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    return url.pathname.endsWith(".json")
      ? new Response(gcaptainTopicJson, { headers: { "content-type": "application/json" } })
      : new Response(gcaptainTopicHtml, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const evidence = await readThread(
    { sourceId: "gcaptain", url: "https://forum.gcaptain.com/t/generating-and-maintaining-shipboard-work-lists/63622" },
    fetcher,
    noWaitLimiter(),
    async () => [{ address: "192.0.1.1", family: 4 }],
    { query: "gemi bakım yazılımı", variants: ["NS5 ship maintenance", "planned maintenance system PMS"] },
  );

  assert.deepEqual(requested, ["https://forum.gcaptain.com/t/generating-and-maintaining-shipboard-work-lists/63622.json"]);
  assert.match(evidence.excerpt, /NS Enterprise|NS5/i);
  assert.match(evidence.excerpt, /Planned Maintenance System|data entry/i);
  assert.doesNotMatch(evidence.excerpt, /Edit CSS|stylesheet/i);
});

test("thread reader refuses redirects instead of following an allowlisted URL elsewhere", async () => {
  let redirectMode: RequestRedirect | undefined;
  const fetcher = (async (_url: URL | string, init?: RequestInit) => {
    redirectMode = init?.redirect;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  }) as typeof fetch;

  const message = await readThread({ sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/redirect" }, fetcher, noWaitLimiter())
    .then(() => "allowed")
    .catch((error: Error) => error.message);

  assert.equal(redirectMode, "manual");
  assert.match(message, /redirect/i);
});

test("thread reader follows a same-source redirect after revalidating its destination", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: URL | string) => {
    requested.push(String(input));
    if (requested.length === 1) {
      return new Response(null, { status: 301, headers: { location: "/konu/canonical.123/" } });
    }
    return new Response("<html><title>Canonical thread</title><body>Direct user evidence</body></html>", {
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const evidence = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/original.123/" },
    fetcher,
    noWaitLimiter(),
  );

  assert.deepEqual(requested, [
    "https://forum.donanimarsivi.com/konu/original.123/",
    "https://forum.donanimarsivi.com/konu/canonical.123/",
  ]);
  assert.equal(evidence.url, "https://forum.donanimarsivi.com/konu/canonical.123/");
  assert.equal(evidence.title, "Canonical thread");
});

test("thread reader rejects a 200 response that is actually a bot challenge", async () => {
  const fetcher = (async () => new Response(
    "<html><title>Just a moment...</title><body>Verify you are human to continue. CAPTCHA</body></html>",
    { headers: { "content-type": "text/html" } },
  )) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/challenge" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.match(message, /challenge|captcha/i);
});

test("thread reader rejects an oversized page before storing evidence", async () => {
  const fetcher = (async () => new Response(
    "<html><title>Huge</title><body>content</body></html>",
    { headers: { "content-type": "text/html", "content-length": "3000000" } },
  )) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/huge" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.match(message, /too large|size limit/i);
});

test("thread reader cancels a chunked response as soon as its size limit is exceeded", async () => {
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

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/chunked-huge" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.match(message, /too large|size limit/i);
  assert.equal(cancelled, true);
  assert.ok(pulls < 5);
});

test("thread reader rejects credential-bearing URLs before making a request", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://user:secret@forum.donanimarsivi.com/konu/private" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.equal(called, false);
  assert.match(message, /credential/i);
});

test("thread reader rejects percent-encoded login paths before making a request", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/%6cogin" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.equal(called, false);
  assert.match(message, /login|account/i);
});

test("thread reader does not retry 403 or 429 source responses", async (context) => {
  for (const status of [403, 429]) {
    await context.test(String(status), async () => {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        return new Response("blocked", { status });
      }) as typeof fetch;

      const message = await readThread(
        { sourceId: "donanimarsivi", url: `https://forum.donanimarsivi.com/konu/status-${status}` },
        fetcher,
        noWaitLimiter(),
      ).then(() => "allowed").catch((error: Error) => error.message);

      assert.equal(calls, 1);
      assert.match(message, new RegExp(String(status)));
    });
  }
});

test("thread reader rejects non-HTML responses", async () => {
  const fetcher = (async () => new Response('{"private":"data"}', {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  const message = await readThread(
    { sourceId: "donanimarsivi", url: "https://forum.donanimarsivi.com/konu/json" },
    fetcher,
    noWaitLimiter(),
  ).then(() => "allowed").catch((error: Error) => error.message);

  assert.match(message, /not an HTML document/i);
});
