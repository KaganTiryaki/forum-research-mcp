import { lookup } from "node:dns/promises";
import { assessEvidenceRelevance } from "./relevance.js";
import { getSource } from "./catalog.js";
import { readTextWithLimit } from "./http-body.js";
import { defaultRateLimiter, type SourceRateLimiter } from "./rate-limit.js";
import { discourseExcerpt, discourseTopicJsonUrl, parseDiscourseTopic, type ReadFocus } from "./discourse.js";

export interface ThreadReadInput {
  sourceId: string;
  url: string;
}

export interface ThreadEvidence {
  messages?: Array<{ author?: string; publishedAt?: string; url: string; excerpt: string }>;
  threadCoverage?: { totalPosts?: number; readPosts: number; truncated: boolean; warnings: string[] };
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  excerpt: string;
  publishedAt?: string;
}

export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const BLOCKED_PATH = /\/(?:login|giris|signin|auth|account|captcha)(?:\/|$)/i;
const PRIVATE_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|\[?::1\]?)$/i;
const MAX_HTML_BYTES = 2_000_000;

function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function evidenceTextFromHtml(html: string): string {
  const blocks: string[] = [];
  const preferredBlock = /<([a-z][\w:-]*)\b(?=[^>]*(?:(?:class|id)=["'][^"']*(?:bbWrapper|message-body|message-content|postbody|post-content|post_message|cooked)[^"']*["']|itemprop=["']articleBody["']))[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(preferredBlock)) {
    const text = textFromHtml(match[2]);
    if (text) blocks.push(text);
  }
  if (blocks.length) return blocks.join(" ");

  const semanticBlock = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(semanticBlock)) {
    const text = textFromHtml(match[2]);
    if (text) blocks.push(text);
  }
  return blocks.length ? blocks.join(" ") : textFromHtml(html);
}

function titleFromHtml(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? textFromHtml(title) : "Untitled thread";
}

function hackerNewsCommentText(html: string): string {
  const blocks: string[] = [];
  const pattern = /<div\b[^>]*class=["'][^"']*commtext[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(pattern)) {
    const text = textFromHtml(match[1]);
    if (text) blocks.push(text);
  }
  return blocks.join(" ");
}

function publishedAtFromHtml(html: string): string | undefined {
  const meta = html.match(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>/i);
  return meta?.[1];
}

function isAllowedHost(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function expandIpv6(address: string): number[] | undefined {
  const normalized = address.toLowerCase().split("%")[0];
  const mappedIpv4 = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let ipv6 = normalized;
  if (mappedIpv4) {
    const octets = mappedIpv4[2].split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return undefined;
    ipv6 = `${mappedIpv4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = ipv6.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const parts = [...left, ...Array(fill).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  return parts.length === 8 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? parts : undefined;
}

function isPrivateOrReservedAddress(address: string): boolean {
  if (address.includes(".")) {
    const ipv4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (ipv4) return isPrivateOrReservedIpv4(ipv4);
  }
  const parts = expandIpv6(address);
  if (!parts) return isPrivateOrReservedIpv4(address);
  const [first, second] = parts;
  const isUnspecifiedOrLoopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] <= 1;
  return isUnspecifiedOrLoopback
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0db8);
}

const resolveHost: HostResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

async function assertPublicResolution(hostname: string, resolver: HostResolver): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new Error(`Source DNS resolution failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!addresses.length) throw new Error("Source DNS resolution returned no addresses");
  if (addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new Error("Source DNS resolution included a private or reserved address");
  }
}

function validateTarget(target: URL, domains: string[]): URL {
  if (target.protocol !== "https:") throw new Error("Only HTTPS thread URLs are allowed");
  if (target.username || target.password) throw new Error("Credential-bearing thread URLs are not allowed");
  if (PRIVATE_HOST.test(target.hostname)) throw new Error("Private network URLs are not allowed");
  if (!isAllowedHost(target.hostname, domains)) throw new Error("Thread URL host is not allowlisted for this source");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(target.pathname);
  } catch {
    throw new Error("Malformed thread URL path is not allowed");
  }
  if (BLOCKED_PATH.test(decodedPath)) throw new Error("Login and account pages cannot be read");
  return target;
}

export async function readThread(
  input: ThreadReadInput,
  fetcher: typeof fetch = fetch,
  rateLimiter: SourceRateLimiter = defaultRateLimiter,
  resolver: HostResolver | undefined = fetcher === fetch ? resolveHost : undefined,
  focus?: ReadFocus,
  paginate = true,
): Promise<ThreadEvidence> {
  const source = getSource(input.sourceId);
  if (!source?.enabled) throw new Error("Source is not enabled for read-only research");

  const evidenceTarget = validateTarget(new URL(input.url), source.domains);
  let target = source.contentAdapter === "discourse_json"
    ? validateTarget(discourseTopicJsonUrl(evidenceTarget), source.domains)
    : evidenceTarget;
  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    if (resolver) await assertPublicResolution(target.hostname, resolver);
    await rateLimiter.acquire(source.id, source.rateLimitMs);
    response = await fetcher(target, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "ForumResearchMCP/0.1 (read-only research)",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) break;
    if (redirects >= 2) throw new Error("Source redirect limit exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("Source redirect was refused because it had no destination");
    try {
      target = validateTarget(new URL(location, target), source.domains);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid destination";
      throw new Error(`Source redirect was refused: ${message}`);
    }
  }
  if ([401, 403, 429].includes(response.status)) {
    throw new Error(`Source access blocked (${response.status}); no retry will be attempted`);
  }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  if (source.contentAdapter === "discourse_json" && !/application\/json/i.test(contentType)) {
    throw new Error("Discourse thread response is not JSON");
  }
  if (source.contentAdapter === "html" && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error("Thread response is not an HTML document");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
    throw new Error("Thread page is too large for the evidence size limit");
  }

  const html = await readTextWithLimit(response, MAX_HTML_BYTES);
  if (source.contentAdapter === "discourse_json") {
    const topic = parseDiscourseTopic(html);
    const messages: NonNullable<ThreadEvidence["messages"]> = topic.posts.map(post => ({
      author: post.username, publishedAt: post.createdAt,
      url: post.postNumber ? `${evidenceTarget.origin}${evidenceTarget.pathname.replace(/\/$/, "")}/${post.postNumber}` : evidenceTarget.toString(),
      excerpt: post.text.slice(0, 600),
    }));
    const warnings: string[] = [];
    let readPosts = topic.posts.length;
    if (paginate && !evidenceTarget.searchParams.has("page") && topic.totalPosts && topic.totalPosts > readPosts) {
      for (let page = 2; page <= 3 && readPosts < topic.totalPosts; page++) {
        const next = new URL(evidenceTarget);
        next.searchParams.set("page", String(page));
        try {
          const batch = await readThread({ ...input, url: next.toString() }, fetcher, rateLimiter, resolver, undefined, false);
          const fresh = (batch.messages ?? []).filter(message => !messages.some(existing => existing.url === message.url));
          if (!fresh.length) break;
          messages.push(...fresh);
          readPosts += fresh.length;
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : "Additional page failed");
          break;
        }
      }
    }
    if (topic.totalPosts !== undefined && readPosts > topic.totalPosts) warnings.push("Source post count is inconsistent with returned messages");
    const selected = focus ? messages.filter(message => assessEvidenceRelevance({ ...focus, title: topic.title, text: message.excerpt }).accepted) : messages;
    return {
      sourceId: source.id,
      sourceName: source.displayName,
      url: evidenceTarget.toString(),
      title: topic.title,
      excerpt: selected.length ? selected.slice(0, 8).map(message => message.excerpt.slice(0, 150)).join(" ").slice(0, 1200) : discourseExcerpt(topic, focus),
      publishedAt: topic.publishedAt,
      messages: selected.slice(0, 40),
      threadCoverage: { totalPosts: topic.totalPosts, readPosts, truncated: (topic.totalPosts ?? readPosts) > readPosts || selected.length > 40, warnings },
    };
  }
  const text = textFromHtml(html);
  const title = source.id === "hacker-news"
    ? titleFromHtml(html).replace(/\s*\|\s*Hacker News\s*$/i, "").trim()
    : titleFromHtml(html);
  const isChallenge = response.headers.get("cf-mitigated") === "challenge"
    || /^(?:just a moment|attention required|security check)/i.test(title)
    || /verify you are (?:a )?human/i.test(text.slice(0, 1_000));
  if (isChallenge) throw new Error("Source returned a CAPTCHA or bot challenge instead of thread content");
  if (!text) throw new Error("Thread page contained no readable text");
  const evidenceText = source.id === "hacker-news"
    ? hackerNewsCommentText(html) || evidenceTextFromHtml(html)
    : evidenceTextFromHtml(html);

  return {
    sourceId: source.id,
    sourceName: source.displayName,
    url: target.toString(),
    title,
    excerpt: evidenceText.slice(0, 600),
    publishedAt: publishedAtFromHtml(html),
  };
}
