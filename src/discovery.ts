import type { Source } from "./catalog.js";
import { readTextWithLimit } from "./http-body.js";
import { defaultRateLimiter, type SourceRateLimiter } from "./rate-limit.js";

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
}

export interface DiscoverInput {
  query: string;
  sources: Source[];
  fetcher?: typeof fetch;
  rateLimiter?: SourceRateLimiter;
}

const MAX_DISCOVERY_BYTES = 2_000_000;
const THREAD_PATH = /\/(?:comments|questions|discussions|threads?|topics?|konu|t)\//i;

const htmlSearchUrl: Record<string, (query: string) => string> = {
  donanimarsivi: (query) => `https://forum.donanimarsivi.com/ara/?q=${encodeURIComponent(query)}`,
  donanimhaber: (query) => `https://forum.donanimhaber.com/search?q=${encodeURIComponent(query)}`,
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

async function request(source: Source, url: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<Response> {
  await rateLimiter.acquire(source.id, source.rateLimitMs);
  const response = await fetcher(url, {
    headers: {
      Accept: "application/json,text/html;q=0.9,application/xhtml+xml;q=0.8",
      "User-Agent": "ForumResearchMCP/0.1 (read-only research)",
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

async function discoverSource(source: Source, query: string, fetcher: typeof fetch, rateLimiter: SourceRateLimiter): Promise<DiscoveredThread[]> {
  if (source.id === "reddit" || source.id === "reddit-tr") return discoverReddit(source, query, fetcher, rateLimiter);
  if (source.id in stackExchangeSite) return discoverStackExchange(source, query, fetcher, rateLimiter);
  if (source.id === "hacker-news") return discoverHackerNews(source, query, fetcher, rateLimiter);
  if (source.id === "github-discussions") return discoverGitHub(source, query, fetcher, rateLimiter);
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

export async function discoverThreads({
  query,
  sources,
  fetcher = fetch,
  rateLimiter = defaultRateLimiter,
}: DiscoverInput): Promise<DiscoveryBatch> {
  if (!sources.length) return { threads: [], warnings: [] };
  const outcomes = await Promise.all(sources.map(async (source) => {
    try {
      return { threads: await discoverSource(source, query, fetcher, rateLimiter) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown source error";
      return { threads: [] as DiscoveredThread[], warning: `${source.displayName} discovery failed: ${message}` };
    }
  }));
  return {
    threads: deduplicate(outcomes.flatMap((outcome) => outcome.threads)),
    warnings: outcomes.flatMap((outcome) => outcome.warning ? [outcome.warning] : []),
  };
}
