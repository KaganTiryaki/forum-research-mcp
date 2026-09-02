import type { Locale } from "./routing.js";

export type ReadMethod = "public_html" | "official_api";
export type PolicyStatus = "reference_allowed" | "api_required" | "needs_review";
export type RobotsStatus = "reference_allowed" | "needs_review";
export type TermsStatus = "read_only_assessed" | "manual_review_required";
export type DiscoveryStrategy = "direct_search" | "category_index" | "sitemap";
export type SearchCapability = "query_search" | "sampled_index";

export interface Source {
  id: string;
  locale: Locale;
  displayName: string;
  domains: string[];
  categories: string[];
  readMethod: ReadMethod;
  policyStatus: PolicyStatus;
  robotsStatus: RobotsStatus;
  termsStatus: TermsStatus;
  rateLimitMs: number;
  enabled: boolean;
  discoveryStrategy: DiscoveryStrategy;
  searchCapability: SearchCapability;
  domainTags: string[];
  discoveryDomains?: string[];
  categoryIndexes?: string[];
  sitemapUrl?: string;
  disabledReason?: string;
}

interface SourceOptions {
  discoveryStrategy?: DiscoveryStrategy;
  discoveryDomains?: string[];
  categoryIndexes?: string[];
  sitemapUrl?: string;
  disabledReason?: string;
  searchCapability?: SearchCapability;
  domainTags?: string[];
}

const tr = (id: string, displayName: string, domain: string, categories: string[], enabled = false, options: SourceOptions = {}): Source => ({
  id,
  locale: "tr",
  displayName,
  domains: [domain],
  categories,
  readMethod: "public_html",
  policyStatus: enabled ? "reference_allowed" : "needs_review",
  robotsStatus: enabled ? "reference_allowed" : "needs_review",
  termsStatus: enabled ? "read_only_assessed" : "manual_review_required",
  rateLimitMs: 1_500,
  enabled,
  discoveryStrategy: options.discoveryStrategy ?? "direct_search",
  searchCapability: options.searchCapability ?? "query_search",
  domainTags: options.domainTags ?? [],
  discoveryDomains: options.discoveryDomains,
  categoryIndexes: options.categoryIndexes,
  sitemapUrl: options.sitemapUrl,
  disabledReason: enabled ? undefined : options.disabledReason ?? "policy_or_access_review",
});

const en = (
  id: string,
  displayName: string,
  domain: string,
  categories: string[],
  enabled = false,
  readMethod: ReadMethod = "public_html",
  options: SourceOptions = {},
): Source => ({
  id,
  locale: "en",
  displayName,
  domains: [domain],
  categories,
  readMethod,
  policyStatus: enabled ? "reference_allowed" : "needs_review",
  robotsStatus: enabled ? "reference_allowed" : "needs_review",
  termsStatus: enabled ? "read_only_assessed" : "manual_review_required",
  rateLimitMs: 1_500,
  enabled,
  discoveryStrategy: options.discoveryStrategy ?? "direct_search",
  searchCapability: options.searchCapability ?? "query_search",
  domainTags: options.domainTags ?? [],
  discoveryDomains: options.discoveryDomains,
  categoryIndexes: options.categoryIndexes,
  sitemapUrl: options.sitemapUrl,
  disabledReason: enabled ? undefined : options.disabledReason ?? "policy_or_access_review",
});

export const catalog: Source[] = [
  tr("reddit-tr", "Reddit Türkiye toplulukları", "www.reddit.com", ["genel", "teknoloji", "gündem"], false, { disabledReason: "http_403" }),
  tr("donanimarsivi", "Donanım Arşivi Forum", "forum.donanimarsivi.com", ["teknoloji", "oyun", "donanım"], true),
  tr("donanimhaber", "DonanımHaber Forum", "forum.donanimhaber.com", ["teknoloji", "otomobil", "alışveriş"], true, {
    discoveryDomains: ["search.donanimhaber.com"],
  }),
  tr("technopat", "Technopat Sosyal", "www.technopat.net", ["teknoloji", "yazılım", "oyun"], true),
  tr("techolay", "Techolay Sosyal", "techolay.net", ["teknoloji", "yazılım", "oyun"]),
  tr("r10", "R10.net", "www.r10.net", ["webmaster", "yazılım", "SEO"]),
  tr("kizlarsoruyor", "KızlarSoruyor", "www.kizlarsoruyor.com", ["yaşam", "ilişkiler", "soru-cevap"]),
  tr("forumtr", "ForumTR", "www.forumtr.com", ["genel", "teknoloji", "yaşam"]),
  tr("shiftdelete", "ShiftDelete.Net Forum", "forum.shiftdelete.net", ["teknoloji", "mobil", "oyun"], false, {
    discoveryStrategy: "sitemap", sitemapUrl: "https://forum.shiftdelete.net/sitemap.xml", disabledReason: "policy_verification_pending",
  }),
  tr("sergip", "SERGİP Forum", "sergip.com", ["denizcilik", "gemiadamları", "kariyer"], true, {
    discoveryStrategy: "category_index",
    categoryIndexes: ["https://sergip.com/forum/23-gemiadamlari-tartisma-bolumu/"],
    searchCapability: "sampled_index",
    domainTags: ["maritime", "professional"],
  }),
  tr("kadinlarkulubu", "Kadınlar Kulübü", "www.kadinlarkulubu.com", ["yaşam", "sağlık", "ebeveynlik"]),
  tr("memurlar", "Memurlar.net Forum", "forum.memurlar.net", ["kamu", "kariyer", "hukuk"]),
  tr("hukuki", "Hukuki.NET Forum", "www.hukuki.net", ["hukuk", "yaşam"]),
  tr("msxlabs", "MsXLabs", "www.msxlabs.org", ["yazılım", "Windows", "sistem"]),
  tr("turkceandroid", "Turkcell Topluluk", "topluluk.turkcell.com.tr", ["mobil", "telekom", "destek"]),
  tr("vodafone-topluluk", "Vodafone Topluluk", "yanimda.vodafone.com.tr", ["mobil", "telekom", "destek"]),
  tr("turktelekom-topluluk", "Türk Telekom Topluluk", "forum.turktelekom.com.tr", ["internet", "telekom", "destek"]),
  tr("denizcilik-fakultesi", "Denizcilik Fakültesi", "www.denizcilikfakultesi.com", ["denizcilik", "eğitim", "gemiadamları"], false, { disabledReason: "login_required" }),
  tr("otopark", "Otopark.com", "www.otopark.com", ["otomobil", "ulaşım"]),
  tr("motordelisi", "MotorDelisi", "www.motordelisi.com", ["motosiklet", "ulaşım"]),
  tr("bisikletforum", "Bisiklet Forum", "www.bisikletforum.com", ["spor", "ulaşım"]),
  tr("technoseyir", "TeknoSeyir", "teknoseyir.com", ["teknoloji", "oyun", "yazılım"]),
  tr("oyunfor", "Oyunfor Forum", "forum.oyunfor.com", ["oyun", "e-spor"]),
  tr("frpnet", "FRPNet Forum", "forum.frpnet.net", ["oyun", "kültür"]),
  tr("pc-hocasi", "PC Hocası Forum", "forum.pchocasi.com.tr", ["teknoloji", "donanım", "kullanıcı deneyimi"], false, {
    discoveryStrategy: "sitemap", sitemapUrl: "https://forum.pchocasi.com.tr/sitemap.xml", disabledReason: "policy_verification_pending",
  }),

  en("reddit", "Reddit", "www.reddit.com", ["general", "technology", "communities"]),
  en("stack-overflow", "Stack Overflow", "stackoverflow.com", ["programming", "software"], true),
  en("super-user", "Super User", "superuser.com", ["software", "hardware"], true),
  en("server-fault", "Server Fault", "serverfault.com", ["infrastructure", "security"], true),
  en("hacker-news", "Hacker News", "news.ycombinator.com", ["technology", "startups"], true),
  en("github-discussions", "GitHub Discussions", "github.com", ["software", "open-source"], true),
  en("gcaptain", "gCaptain Professional Mariner Forum", "forum.gcaptain.com", ["maritime", "professional", "engineering"], true, "public_html", {
    discoveryStrategy: "category_index",
    searchCapability: "sampled_index",
    domainTags: ["maritime", "professional"],
    categoryIndexes: [
      "https://forum.gcaptain.com/c/professional-mariner-forum/5.json",
      "https://forum.gcaptain.com/c/engineering/16.json",
      "https://forum.gcaptain.com/c/offshore/11.json",
    ],
  }),
  en("xda-developers", "XDA Developers", "xdaforums.com", ["mobile", "hardware"]),
  en("toms-hardware", "Tom's Hardware", "forums.tomshardware.com", ["hardware", "gaming"]),
  en("linus-tech-tips", "Linus Tech Tips Forum", "linustechtips.com", ["hardware", "gaming"]),
  en("bleeping-computer", "BleepingComputer", "www.bleepingcomputer.com", ["security", "support"]),
  en("ars-technica", "Ars Technica Forums", "arstechnica.com", ["technology", "science"]),
  en("macrumors", "MacRumors Forums", "forums.macrumors.com", ["Apple", "hardware"]),
  en("avs-forum", "AVS Forum", "www.avsforum.com", ["audio", "video", "home-theater"]),
  en("spiceworks", "Spiceworks Community", "community.spiceworks.com", ["IT", "infrastructure"]),
  en("cloudflare-community", "Cloudflare Community", "community.cloudflare.com", ["web", "security", "infrastructure"]),
  en("wordpress-support", "WordPress Support", "wordpress.org", ["web", "CMS", "support"]),
  en("mozilla-support", "Mozilla Support", "support.mozilla.org", ["browser", "support"]),
  en("ubuntu-discourse", "Ubuntu Discourse", "discourse.ubuntu.com", ["Linux", "software"]),
  en("microsoft-qna", "Microsoft Q&A", "learn.microsoft.com", ["software", "cloud", "support"]),
  en("apple-support", "Apple Support Community", "discussions.apple.com", ["Apple", "support"]),
  en("unity-discussions", "Unity Discussions", "discussions.unity.com", ["game-development", "software"]),
  en("unreal-forums", "Unreal Engine Forums", "forums.unrealengine.com", ["game-development", "software"]),
  en("blender-artists", "Blender Artists", "blenderartists.org", ["3D", "software"]),
  en("shopify-community", "Shopify Community", "community.shopify.com", ["ecommerce", "business"]),
];

export function sourcesForLocales(locales: Locale[], requestedIds?: string[]): Source[] {
  return catalog.filter((source) =>
    source.enabled && locales.includes(source.locale) && (!requestedIds?.length || requestedIds.includes(source.id)),
  );
}

export function getSource(sourceId: string): Source | undefined {
  return catalog.find((source) => source.id === sourceId);
}
