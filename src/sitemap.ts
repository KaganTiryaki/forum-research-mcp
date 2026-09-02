export interface SitemapEntry {
  url: string;
  publishedAt?: string;
  titleHint: string;
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function titleFromUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname)
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .trim() ?? "";
  } catch {
    return "";
  }
}

export function parseSitemapEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlPattern = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  for (const match of xml.matchAll(urlPattern)) {
    const loc = match[1].match(/<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const url = decodeXml(loc.trim());
    try {
      new URL(url);
    } catch {
      continue;
    }
    const publishedAt = match[1].match(/<lastmod\b[^>]*>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim();
    entries.push({ url, publishedAt, titleHint: titleFromUrl(url) });
  }
  return entries;
}

export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc\b[^>]*>\s*([^<]+?)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)]
    .map((match) => decodeXml(match[1].trim()))
    .filter((url) => {
      try {
        return new URL(url).protocol === "https:";
      } catch {
        return false;
      }
    });
}
