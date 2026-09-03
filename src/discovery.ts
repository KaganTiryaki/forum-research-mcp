import type { Source } from "./catalog.js";
import { readTextWithLimit } from "./http-body.js";
import { defaultRateLimiter, type SourceRateLimiter } from "./rate-limit.js";
import { assessDiscoveryCandidate, assessRelevance } from "./relevance.js";
import { parseSitemapEntries, parseSitemapIndex } from "./sitemap.js";

export interface DiscoveredThread {
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface DiscoveryBatch {
  threads: DiscoveredThread[];
  warnings: string[];
  sourceOutcomes?: DiscoverySourceOutcome[];
  irrelevantResultsRejected?: number;
  duplicateResultsRejected?: number;
}

export interface DiscoverySourceOutcome {
  kind?: "query_search" | "sampled_index";
  sourceId: string;
  query?: string;
  indexUrl?: string;
  queriesEvaluated?: string[];
  status: "success" | "blocked" | "failed";
  discoveredCount: number;
  uniqueCandidateCount?: number;
  strategy: Source["discoveryStrategy"];
  attemptOrdinal: number;
  issueCode?: "http_403" | "rate_limited" | "robots_denied" | "login_required";
}

export interface ScheduledDiscoveryAttempt {
  source: Source;
  query: string;
  attemptOrdinal: number;
}

export type DiscoveryTask =
  | { kind: "query_search"; source: Source; query: string; attemptOrdinal: number }
  | { kind: "sampled_index"; source: Source; queries: string[]; requestBudget: number };

export interface DiscoverInput {
  query: string;
  sources: Source[];
  queryVariants?: string[];
  maxRequests?: number;
  fetcher?: typeof fetch;
  rateLimiter?: SourceRateLimiter;
}

const MAX_DISCOVERY_BYTES = 2_000_000;
const MAX_SITEMAP_TOTAL_BYTES = 6_000_000;
const MAX_SITEMAP_CHILDREN = 4;
const MAX_SAMPLED_CANDIDATES = 50;
const THREAD_PATH = /\/(?:comments|questions|discussions|threads?|topics?|konu|t)\//i;
const SERGIP_THREAD_PATH = /\/forum\/\d+-[^/]+\.html$/i;
const DISCOURSE_TOPIC_PATH = /^\/t\/[^/]+\/\d+\/?$/i;
const GCAPTAIN_SITEMAP_CHILD_PATH = /^\/sitemap_(?:\d+|recent)\.xml$/i;

const htmlSearchUrl: Record<string, (query: string) => string> = {
  donanimarsivi: (query) => `https://forum.donanimarsivi.com/ara/?q=${encodeURIComponent(query)}`,
  technopat: (query) => `https://www.technopat.net/sosyal/ara/?q=${encodeURIComponent(query)}`,
  techolay: (query) => `https://techolay.net/sosyal/ara/?q=${encodeURIComponent(query)}`,
  r10: (query) => `https://www.r10.net/search.php?query=${encodeURIComponent(query)}`,
  kizlarsoruyor: (query) => `https://www.kizlarsoruyor.com/ara?q=${encodeURIComponent(query)}`,
  forumtr: (query) => `https://www.forumtr.com/ara/?q=${encodeURIComponent(query)}`,
  "github-discussions": (query) => `https://github.com/search?q=${encodeURIComponent(query)}&type=discussions`,
  "xda-developers": (query) => `https://xdaforums.com/search/?q=${encodeURIComponent(query)}`,
  "toms-hardware": (query) => `https://forums.tomshardware.com/search/?q=${encodeURIComponent(query)}`,
  "linus-tech-tips": (query) => `https://linustechtips.com/search/?q=${encodeURIComponent(query)}&type=forums_topic`,
  "bleeping-computer": (query) => `https://www.bleepingcomputer.com/forums/index.php?app=core&module=search&do=search&search_term=${encodeURIComponent(query)}`,
};

const stackExchangeSite: Record<string, string> = {
  "stack-overflow": "stackoverflow",
  "super-user": "superuser",
  "server-fault": "serverfault",
};

function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function isAllowedResultUrl(url: URL, source: Source): boolean {
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && source.domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

function normalizeResult(source: Source, value: Omit<DiscoveredThread, "sourceId" | "sourceName">): DiscoveredThread | undefined {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (!isAllowedResultUrl(url, source)) return undefined;
  return {
    sourceId: source.id,
    sourceName: source.displayName,
    ...value,
    url: url.toString(),
    title: textFromHtml(value.title) || "Untitled thread",
    snippet: textFromHtml(value.snippet).slice(0, 500),
  };
}

async function request(
  source: Source,
  url: string,
  fetcher: typeof fetch,
  rateLimiter: SourceRateLimiter,
  init: RequestInit = {},
): Promise<Response> {
  await rateLimiter.acquire(source.id, source.rateLimitMs);
  const response = await fetcher(url, {
    ...init,
    headers: {
      Accept: "application/json,text/html;q=0.9,application/xhtml+xml;q=0.8",
      "User-Agent": "ForumResearchMCP/0.1 (read-only research)",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`redirect refused (HTTP ${response.status})`);
  if ([401, 403, 429].includes(response.status)) throw new Error(`access blocked (HTTP ${response.status}); no retry attempted`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) throw new Error("response exceeded the discovery size limit");
  return response;
}

async function resolveDonanimhaberMessage(
  source: Source,
  id: number,
  hash: string,
  fetcher: typeof fetch,
  rateLimiter: SourceRateLimiter,
): Promise<string | undefined> {
  await rateLimiter.acquire(source.id, source.rateLimitMs);
  const response = await fetcher(`https://search.donanimhaber.com/api/redirect/${encodeURIComponent(id)}/?hash=${encodeURIComponent(hash)}&type=0`, {
    headers: { Accept: "text/html", "User-Agent": "ForumResearchMCP/0.2 (read-only research)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;
  const target = new URL(location, "https://forum.donanimhaber.com");
  return isAllowedResultUrl(target, source) ? target.toString() : undefined;
}

async function responseText(response: Response): Promise<string> {
  return readTextWithLimit(response, MAX_DISCOVERY_BYTES);
}

async function discoverReddit(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const scope = source.id === "reddit-tr"
    ? "/r/Turkey+AskTurkey+TurkeyJerky+turkishlearning"
    : "";
  const restrict = source.id === "reddit-tr" ? "&restrict_sr=1" : "";
  const url = `https://www.reddit.com${scope}/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=all&limit=5&raw_json=1${restrict}`;
  const response = await request(source, url, fetcher, rateLimiter);
  const payload = JSON.parse(await responseText(response)) as {
    data?: { children?: Array<{ data?: { title?: string; permalink?: string; selftext?: string; created_utc?: number; score?: number } }> };
  };
  return (payload.data?.children ?? []).flatMap(({ data }) => {
    if (!data?.permalink || !/\/comments\//i.test(data.permalink)) return [];
    const result = normalizeResult(source, {
      url: new URL(data.permalink, "https://www.reddit.com").toString(),
      title: data.title ?? "",
      snippet: data.selftext ?? "",
      publishedAt: data.created_utc ? new Date(data.created_utc * 1_000).toISOString() : undefined,
      score: data.score,
    });
    return result ? [result] : [];
  });
}

async function discoverStackExchange(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const site = stackExchangeSite[source.id];
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${site}&filter=withbody&pagesize=5`;
  const response = await request(source, url, fetcher, rateLimiter);
  const payload = JSON.parse(await responseText(response)) as {
    items?: Array<{ title?: string; link?: string; body?: string; creation_date?: number; score?: number }>;
  };
  return (payload.items ?? []).flatMap((item) => {
    if (!item.link) return [];
    const result = normalizeResult(source, {
      url: item.link,
      title: item.title ?? "",
      snippet: item.body ?? "",
      publishedAt: item.creation_date ? new Date(item.creation_date * 1_000).toISOString() : undefined,
      score: item.score,
    });
    return result ? [result] : [];
  });
}

async function discoverHackerNews(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const response = await request(source, url, fetcher, rateLimiter);
  const payload = JSON.parse(await responseText(response)) as {
    hits?: Array<{ objectID?: string; title?: string; story_text?: string; created_at?: string; points?: number }>;
  };
  return (payload.hits ?? []).flatMap((hit) => {
    if (!hit.objectID) return [];
    const result = normalizeResult(source, {
      url: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`,
      title: hit.title ?? "",
      snippet: hit.story_text ?? "",
      publishedAt: hit.created_at,
      score: hit.points,
    });
    return result ? [result] : [];
  });
}

async function discoverGitHub(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const url = htmlSearchUrl[source.id](query);
  const response = await request(source, url, fetcher, rateLimiter);
  const payload = JSON.parse(await responseText(response)) as {
    payload?: {
      blackbirdSearchRoute?: {
        results?: Array<{ title?: string; body?: string; url?: string; created?: string; num_comments?: number }>;
      };
    };
  };
  return (payload.payload?.blackbirdSearchRoute?.results ?? []).flatMap((item) => {
    if (!item.url) return [];
    const result = normalizeResult(source, {
      url: new URL(item.url, "https://github.com").toString(),
      title: item.title ?? "",
      snippet: item.body ?? "",
      publishedAt: item.created,
      score: item.num_comments,
    });
    return result ? [result] : [];
  });
}

async function discoverDonanimhaber(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const response = await request(
    source,
    "https://search.donanimhaber.com/api/search/messages/?p=1&order=rank&in=all&type=both&scope=all&daterange=all",
    fetcher,
    rateLimiter,
    { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: query },
  );
  const payload = JSON.parse(await responseText(response)) as {
    hash?: string;
    messages?: Array<{ id?: number; topicId?: number; subject?: string; body?: string; dateString?: string }>;
  };
  if (!payload.hash) return [];
  const results: DiscoveredThread[] = [];
  for (const message of (payload.messages ?? []).slice(0, 5)) {
    if (!message.id) continue;
    const url = await resolveDonanimhaberMessage(source, message.id, payload.hash, fetcher, rateLimiter);
    if (!url) continue;
    const result = normalizeResult(source, {
      url,
      title: message.subject ?? "",
      snippet: message.body ?? "",
      publishedAt: message.dateString,
    });
    if (result) results.push(result);
  }
  return results;
}

async function discoverCategoryIndex(source: Source, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const results: DiscoveredThread[] = [];
  for (const indexUrl of (source.categoryIndexes ?? []).slice(0, 2)) {
    const response = await request(source, indexUrl, fetcher, rateLimiter);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("category index response was not HTML");
    const html = await responseText(response);
    const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(anchor)) {
      let url: URL;
      try {
        url = new URL(decodeHtml(match[2]), indexUrl);
      } catch {
        continue;
      }
      if (!SERGIP_THREAD_PATH.test(url.pathname)) continue;
      const result = normalizeResult(source, { url: url.toString(), title: match[3], snippet: "" });
      if (result) results.push(result);
      if (results.length >= 5) return results;
    }
  }
  return results;
}

async function discoverGcaptainIndex(source: Source, attemptOrdinal: number, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const indexes = source.categoryIndexes ?? [];
  if (!indexes.length) throw new Error("no gCaptain category index is configured");
  const categoryIndex = indexes[(attemptOrdinal - 1) % indexes.length]!;
  const page = Math.floor((attemptOrdinal - 1) / indexes.length);
  const url = new URL(categoryIndex);
  if (page > 0) url.searchParams.set("page", String(page));
  const response = await request(source, url.toString(), fetcher, rateLimiter);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/application\/json/i.test(contentType)) throw new Error("gCaptain category index response was not JSON");
  const payload = JSON.parse(await responseText(response)) as {
    topic_list?: { topics?: Array<{ id?: number; slug?: string; title?: string; excerpt?: string; created_at?: string }> };
  };
  return (payload.topic_list?.topics ?? []).flatMap((topic) => {
    if (!topic.id || !topic.slug) return [];
    const result = normalizeResult(source, {
      url: `https://forum.gcaptain.com/t/${encodeURIComponent(topic.slug)}/${encodeURIComponent(topic.id)}`,
      title: topic.title ?? "",
      snippet: topic.excerpt ?? "",
      publishedAt: topic.created_at,
    });
    return result ? [result] : [];
  });
}

interface SampledDiscoveryResult {
  threads: DiscoveredThread[];
  warnings: string[];
  outcomes: DiscoverySourceOutcome[];
  irrelevantResultsRejected: number;
  duplicateResultsRejected: number;
}

function classifyDiscoveryError(error: unknown): {
  message: string;
  status: "blocked" | "failed";
  issueCode?: DiscoverySourceOutcome["issueCode"];
} {
  const message = error instanceof Error ? error.message : "unknown source error";
  const blocked = /HTTP (?:401|403|429)|captcha|bot challenge/i.test(message);
  const issueCode = /HTTP 429/i.test(message)
    ? "rate_limited" as const
    : /HTTP 401|login/i.test(message)
      ? "login_required" as const
      : /robots/i.test(message)
        ? "robots_denied" as const
        : "http_403" as const;
  return { message, status: blocked ? "blocked" : "failed", issueCode: blocked ? issueCode : undefined };
}

async function discoverGcaptainSample(
  source: Source,
  queries: string[],
  requestBudget: number,
  fetcher: typeof fetch,
  rateLimiter: SourceRateLimiter,
): Promise<SampledDiscoveryResult> {
  const sitemapUrl = source.sitemapUrl;
  if (!sitemapUrl) throw new Error("no gCaptain sitemap is configured");

  const pending: string[] = [sitemapUrl];
  const visited = new Set<string>();
  const seenThreads = new Set<string>();
  const threads: DiscoveredThread[] = [];
  const warnings: string[] = [];
  const outcomes: DiscoverySourceOutcome[] = [];
  let sitemapBytes = 0;
  let irrelevantResultsRejected = 0;
  let duplicateResultsRejected = 0;
  let categoriesQueued = false;

  const queueCategories = () => {
    if (categoriesQueued) return;
    categoriesQueued = true;
    pending.push(...(source.categoryIndexes ?? []));
  };

  while (pending.length && outcomes.length < requestBudget) {
    const indexUrl = pending.shift()!;
    if (visited.has(indexUrl)) continue;
    visited.add(indexUrl);
    const attemptOrdinal = outcomes.length + 1;
    try {
      const response = await request(source, indexUrl, fetcher, rateLimiter);
      const contentType = response.headers.get("content-type") ?? "";
      const body = await responseText(response);
      let rawThreads: DiscoveredThread[] = [];

      if (/application\/(?:xml|[^;]+\+xml)|text\/xml/i.test(contentType)) {
        sitemapBytes += new TextEncoder().encode(body).byteLength;
        if (sitemapBytes > MAX_SITEMAP_TOTAL_BYTES) throw new Error("aggregate sitemap responses exceeded the discovery size limit");
        const current = new URL(indexUrl);
        const children = parseSitemapIndex(body).flatMap((childUrl) => {
          try {
            const child = new URL(childUrl);
            return isAllowedResultUrl(child, source)
              && child.hostname === current.hostname
              && GCAPTAIN_SITEMAP_CHILD_PATH.test(child.pathname)
              ? [child.toString()]
              : [];
          } catch {
            return [];
          }
        }).slice(0, MAX_SITEMAP_CHILDREN);
        if (children.length) {
          pending.unshift(...children.filter((child) => !visited.has(child)));
          queueCategories();
        }
        rawThreads = parseSitemapEntries(body).flatMap((entry) => {
          const url = new URL(entry.url);
          if (!DISCOURSE_TOPIC_PATH.test(url.pathname)) return [];
          const result = normalizeResult(source, {
            url: entry.url,
            title: entry.titleHint,
            snippet: "",
            publishedAt: entry.publishedAt,
          });
          return result ? [result] : [];
        });
      } else if (/application\/json/i.test(contentType)) {
        const payload = JSON.parse(body) as {
          topic_list?: { topics?: Array<{ id?: number; slug?: string; title?: string; excerpt?: string; created_at?: string }> };
        };
        rawThreads = (payload.topic_list?.topics ?? []).flatMap((topic) => {
          if (!topic.id || !topic.slug) return [];
          const result = normalizeResult(source, {
            url: `https://forum.gcaptain.com/t/${encodeURIComponent(topic.slug)}/${encodeURIComponent(topic.id)}`,
            title: topic.title ?? "",
            snippet: topic.excerpt ?? "",
            publishedAt: topic.created_at,
          });
          return result ? [result] : [];
        });
      } else {
        throw new Error("gCaptain sampled index response had an unsupported content type");
      }

      const seenBeforeIndex = seenThreads.size;
      for (const thread of rawThreads) {
        const key = thread.url.replace(/\/$/, "");
        if (seenThreads.has(key)) {
          duplicateResultsRejected += 1;
          continue;
        }
        seenThreads.add(key);
        const relevance = assessDiscoveryCandidate({
          query: queries[0] ?? "",
          variants: queries.slice(1),
          title: thread.title,
          text: thread.snippet,
          domainTags: source.domainTags,
        });
        if (relevance.accepted && threads.length < MAX_SAMPLED_CANDIDATES) {
          threads.push({ ...thread, score: relevance.score });
        }
      }

      outcomes.push({
        kind: "sampled_index",
        sourceId: source.id,
        indexUrl,
        queriesEvaluated: queries,
        status: "success",
        discoveredCount: rawThreads.length,
        uniqueCandidateCount: seenThreads.size - seenBeforeIndex,
        strategy: source.discoveryStrategy,
        attemptOrdinal,
      });
      if (indexUrl === sitemapUrl && !pending.length) queueCategories();
    } catch (error) {
      const failure = classifyDiscoveryError(error);
      warnings.push(`${source.displayName} sampled discovery failed for ${indexUrl}: ${failure.message}`);
      outcomes.push({
        kind: "sampled_index",
        sourceId: source.id,
        indexUrl,
        queriesEvaluated: queries,
        status: failure.status,
        discoveredCount: 0,
        strategy: source.discoveryStrategy,
        attemptOrdinal,
        issueCode: failure.issueCode,
      });
      if (indexUrl === sitemapUrl) queueCategories();
    }
  }

  return { threads, warnings, outcomes, irrelevantResultsRejected, duplicateResultsRejected };
}

async function discoverSampledTask(
  source: Source,
  queries: string[],
  requestBudget: number,
  fetcher: typeof fetch,
  rateLimiter: SourceRateLimiter,
): Promise<SampledDiscoveryResult> {
  if (source.id === "gcaptain") return discoverGcaptainSample(source, queries, requestBudget, fetcher, rateLimiter);
  try {
    const rawThreads = source.discoveryStrategy === "sitemap"
      ? await discoverSitemap(source, fetcher, rateLimiter)
      : await discoverCategoryIndex(source, fetcher, rateLimiter);
    const threads = rawThreads.flatMap((thread) => {
      const relevance = assessDiscoveryCandidate({
        query: queries[0] ?? "",
        variants: queries.slice(1),
        title: thread.title,
        text: thread.snippet,
        domainTags: source.domainTags,
      });
      return relevance.accepted ? [{ ...thread, score: relevance.score }] : [];
    });
    return {
      threads,
      warnings: [],
      outcomes: [{
        kind: "sampled_index",
        sourceId: source.id,
        indexUrl: source.sitemapUrl ?? source.categoryIndexes?.[0] ?? source.domains[0],
        queriesEvaluated: queries,
        status: "success",
        discoveredCount: rawThreads.length,
        uniqueCandidateCount: new Set(rawThreads.map((thread) => thread.url.replace(/\/$/, ""))).size,
        strategy: source.discoveryStrategy,
        attemptOrdinal: 1,
      }],
      irrelevantResultsRejected: 0,
      duplicateResultsRejected: 0,
    };
  } catch (error) {
    const failure = classifyDiscoveryError(error);
    return {
      threads: [],
      warnings: [`${source.displayName} sampled discovery failed: ${failure.message}`],
      outcomes: [{
        kind: "sampled_index",
        sourceId: source.id,
        indexUrl: source.sitemapUrl ?? source.categoryIndexes?.[0] ?? source.domains[0],
        queriesEvaluated: queries,
        status: failure.status,
        discoveredCount: 0,
        strategy: source.discoveryStrategy,
        attemptOrdinal: 1,
        issueCode: failure.issueCode,
      }],
      irrelevantResultsRejected: 0,
      duplicateResultsRejected: 0,
    };
  }
}

async function discoverSitemap(source: Source, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  if (!source.sitemapUrl) throw new Error("no sitemap URL is configured");
  const readSitemap = async (url: string) => responseText(await request(source, url, fetcher, rateLimiter));
  const root = await readSitemap(source.sitemapUrl);
  let entries = parseSitemapEntries(root);
  for (const childUrl of parseSitemapIndex(root).slice(0, 2)) {
    let child: URL;
    try {
      child = new URL(childUrl);
    } catch {
      continue;
    }
    if (!isAllowedResultUrl(child, source)) continue;
    entries = [...entries, ...parseSitemapEntries(await readSitemap(child.toString()))];
  }
  return entries.slice(0, 30).flatMap((entry) => {
    const result = normalizeResult(source, {
      url: entry.url,
      title: entry.titleHint,
      snippet: "",
      publishedAt: entry.publishedAt,
    });
    return result ? [result] : [];
  });
}

async function discoverHtml(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  const buildUrl = htmlSearchUrl[source.id];
  if (!buildUrl) throw new Error("no direct search adapter is configured");
  const searchUrl = buildUrl(query);
  const response = await request(source, searchUrl, fetcher, rateLimiter);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("search response was not HTML");
  const html = await responseText(response);
  const title = textFromHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const isChallenge = response.headers.get("cf-mitigated") === "challenge"
    || /^(?:just a moment|attention required|security check)/i.test(title)
    || /verify you are (?:a )?human/i.test(textFromHtml(html).slice(0, 1_000));
  if (isChallenge) throw new Error("CAPTCHA or bot challenge returned instead of search results");
  const results: DiscoveredThread[] = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    let url: URL;
    try {
      url = new URL(decodeHtml(match[2]), searchUrl);
    } catch {
      continue;
    }
    if (!THREAD_PATH.test(url.pathname)) continue;
    const result = normalizeResult(source, { url: url.toString(), title: match[3], snippet: "" });
    if (result) results.push(result);
    if (results.length >= 5) break;
  }
  return results;
}

async function discoverSource(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter, attemptOrdinal: number): Promise<DiscoveredThread[]> {
  if (source.id === "reddit" || source.id === "reddit-tr") return discoverReddit(source, query, fetcher, rateLimiter);
  if (source.id in stackExchangeSite) return discoverStackExchange(source, query, fetcher, rateLimiter);
  if (source.id === "hacker-news") return discoverHackerNews(source, query, fetcher, rateLimiter);
  if (source.id === "github-discussions") return discoverGitHub(source, query, fetcher, rateLimiter);
  if (source.id === "donanimhaber") return discoverDonanimhaber(source, query, fetcher, rateLimiter);
  if (source.id === "gcaptain") return discoverGcaptainIndex(source, attemptOrdinal, fetcher, rateLimiter);
  if (source.discoveryStrategy === "category_index") return discoverCategoryIndex(source, fetcher, rateLimiter);
  if (source.discoveryStrategy === "sitemap") return discoverSitemap(source, fetcher, rateLimiter);
  return discoverHtml(source, query, fetcher, rateLimiter);
}

function deduplicate(threads: DiscoveredThread[]): DiscoveredThread[] {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    const key = thread.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scheduleDiscoveryAttempts({
  queries,
  sources,
  maxRequests,
}: {
  queries: string[];
  sources: Source[];
  maxRequests?: number;
}): ScheduledDiscoveryAttempt[] {
  const budget = maxRequests ?? Number.POSITIVE_INFINITY;
  const attempts: ScheduledDiscoveryAttempt[] = [];
  if (!queries.length || !sources.length || budget <= 0) return attempts;

  const maxRounds = Number.isFinite(budget)
    ? Math.min(sources.length, Math.ceil(budget / queries.length))
    : sources.length;
  for (let round = 0; round < maxRounds && attempts.length < budget; round += 1) {
    let scheduledInRound = 0;
    for (let queryIndex = 0; queryIndex < queries.length && attempts.length < budget; queryIndex += 1) {
      const source = sources[(queryIndex + round) % sources.length]!;
      attempts.push({ source, query: queries[queryIndex]!, attemptOrdinal: round + 1 });
      scheduledInRound += 1;
    }
    if (!scheduledInRound) break;
  }
  return attempts;
}

export function scheduleDiscoveryTasks({
  queries,
  sources,
  maxRequests,
}: {
  queries: string[];
  sources: Source[];
  maxRequests?: number;
}): DiscoveryTask[] {
  const budget = Math.max(0, maxRequests ?? Number.MAX_SAFE_INTEGER);
  if (!queries.length || !sources.length || budget === 0) return [];

  const querySources = sources.filter((source) => source.searchCapability === "query_search");
  const sampledSources = sources.filter((source) => source.searchCapability === "sampled_index");
  const tasks: DiscoveryTask[] = [];
  let requestsReserved = 0;
  // A partial query-search sweep must not starve the only permitted specialist
  // index. When the requested three-source coverage cannot fit, reserve each
  // sampled source's bounded crawl first, then spend the remainder on queries.
  const sampledReservation = Math.min(
    budget,
    sampledSources.reduce((total, source) => total + (source.sampleRequestLimit ?? 1), 0),
  );
  const queryBudget = budget - sampledReservation;

  const requiredRounds = Math.min(3, querySources.length);
  for (let round = 0; round < requiredRounds && requestsReserved < queryBudget; round += 1) {
    for (let queryIndex = 0; queryIndex < queries.length && requestsReserved < queryBudget; queryIndex += 1) {
      const source = querySources[(queryIndex + round) % querySources.length]!;
      tasks.push({ kind: "query_search", source, query: queries[queryIndex]!, attemptOrdinal: round + 1 });
      requestsReserved += 1;
    }
  }

  for (const source of sampledSources) {
    if (requestsReserved >= budget) break;
    const requestBudget = Math.min(source.sampleRequestLimit ?? 1, budget - requestsReserved);
    if (requestBudget <= 0) continue;
    tasks.push({ kind: "sampled_index", source, queries, requestBudget });
    requestsReserved += requestBudget;
  }

  for (let round = requiredRounds; round < querySources.length && requestsReserved < budget; round += 1) {
    for (let queryIndex = 0; queryIndex < queries.length && requestsReserved < budget; queryIndex += 1) {
      const source = querySources[(queryIndex + round) % querySources.length]!;
      tasks.push({ kind: "query_search", source, query: queries[queryIndex]!, attemptOrdinal: round + 1 });
      requestsReserved += 1;
    }
  }

  return tasks;
}

export async function discoverThreads({
  query,
  sources,
  queryVariants = [],
  maxRequests,
  fetcher = fetch,
  rateLimiter = defaultRateLimiter,
}: DiscoverInput): Promise<DiscoveryBatch> {
  if (!sources.length) return { threads: [], warnings: [] };
  const queries = [...new Set([query, ...queryVariants].map((item) => item.trim()).filter(Boolean))];
  const tasks = scheduleDiscoveryTasks({ queries, sources, maxRequests });
  const queryTasks = tasks.filter((task): task is Extract<DiscoveryTask, { kind: "query_search" }> => task.kind === "query_search");
  const sampledTasks = tasks.filter((task): task is Extract<DiscoveryTask, { kind: "sampled_index" }> => task.kind === "sampled_index");
  const outcomes = await Promise.all(queryTasks.map(async ({ source, query: queryVariant, attemptOrdinal }) => {
    try {
      const rawThreads = await discoverSource(source, queryVariant, fetcher, rateLimiter, attemptOrdinal);
      const threads = rawThreads.filter((thread) => assessRelevance({
        query,
        variants: queryVariants,
        title: thread.title,
        text: thread.snippet,
      }).accepted);
      return {
        threads,
        rejected: rawThreads.length - threads.length,
        outcome: { kind: "query_search" as const, sourceId: source.id, query: queryVariant, status: "success" as const, discoveredCount: rawThreads.length, strategy: source.discoveryStrategy, attemptOrdinal },
      };
    } catch (error) {
      const failure = classifyDiscoveryError(error);
      return {
        threads: [] as DiscoveredThread[],
        rejected: 0,
        outcome: { kind: "query_search" as const, sourceId: source.id, query: queryVariant, status: failure.status, discoveredCount: 0, strategy: source.discoveryStrategy, attemptOrdinal, issueCode: failure.issueCode },
        warning: `${source.displayName} discovery failed: ${failure.message}`,
      };
    }
  }));
  const sampled = await Promise.all(sampledTasks.map((task) => discoverSampledTask(
    task.source,
    task.queries,
    task.requestBudget,
    fetcher,
    rateLimiter,
  )));
  return {
    threads: deduplicate([
      ...outcomes.flatMap((outcome) => outcome.threads),
      ...sampled.flatMap((result) => result.threads),
    ]),
    warnings: [
      ...outcomes.flatMap((outcome) => outcome.warning ? [outcome.warning] : []),
      ...sampled.flatMap((result) => result.warnings),
    ],
    sourceOutcomes: [
      ...outcomes.map((outcome) => outcome.outcome),
      ...sampled.flatMap((result) => result.outcomes),
    ],
    irrelevantResultsRejected: outcomes.reduce((total, outcome) => total + outcome.rejected, 0)
      + sampled.reduce((total, result) => total + result.irrelevantResultsRejected, 0),
    duplicateResultsRejected: sampled.reduce((total, result) => total + result.duplicateResultsRejected, 0),
  };
}
