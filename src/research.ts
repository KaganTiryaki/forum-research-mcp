import { sourcesForLocales, type Source } from "./catalog.js";
import type { ResearchCache } from "./cache.js";
import type { DiscoveredThread, DiscoveryBatch } from "./discovery.js";
import type { ThreadEvidence } from "./reader.js";
import { secondaryLocale, selectInitialLocales, type Locale, type LocalePreference } from "./routing.js";

export interface SearchInput {
  query: string;
  locale?: LocalePreference;
  sources?: string[];
}

export interface SearchResult {
  locales: Locale[];
  expandedToBoth: boolean;
  threads: DiscoveredThread[];
  warnings: string[];
}

export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchInput extends SearchInput {
  depth?: ResearchDepth;
}

export interface ResearchResult extends SearchResult {
  evidence: ThreadEvidence[];
  summary: string;
}

export interface ForumResearchDependencies {
  discover(input: { query: string; sources: Source[] }): Promise<DiscoveryBatch | DiscoveredThread[]>;
  read?(input: { sourceId: string; url: string }): Promise<ThreadEvidence>;
  cache?: Pick<ResearchCache, "get" | "set">;
}

const MINIMUM_DISTINCT_SOURCES = 3;
const DEPTH_LIMIT: Record<ResearchDepth, number> = { quick: 3, standard: 6, deep: 12 };
const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

function hasSufficientEvidence(threads: DiscoveredThread[]): boolean {
  return new Set(threads.map((thread) => thread.sourceId)).size >= MINIMUM_DISTINCT_SOURCES;
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

function prioritizeDistinctSources(threads: DiscoveredThread[]): DiscoveredThread[] {
  const seenSources = new Set<string>();
  const firstFromEachSource: DiscoveredThread[] = [];
  const remaining: DiscoveredThread[] = [];
  for (const thread of threads) {
    if (seenSources.has(thread.sourceId)) remaining.push(thread);
    else {
      seenSources.add(thread.sourceId);
      firstFromEachSource.push(thread);
    }
  }
  return [...firstFromEachSource, ...remaining];
}

export class ForumResearchService {
  constructor(private readonly dependencies: ForumResearchDependencies) {}

  private normalizeDiscovery(value: DiscoveryBatch | DiscoveredThread[]): DiscoveryBatch {
    return Array.isArray(value) ? { threads: value, warnings: [] } : value;
  }

  private async discover(query: string, sources: Source[]): Promise<DiscoveryBatch> {
    const cacheKey = `discovery:${query}:${sources.map((source) => source.id).sort().join(",")}`;
    const cached = this.dependencies.cache?.get<DiscoveryBatch | DiscoveredThread[]>(cacheKey);
    if (cached) return this.normalizeDiscovery(cached);

    const result = this.normalizeDiscovery(await this.dependencies.discover({ query, sources }));
    this.dependencies.cache?.set(cacheKey, result, DISCOVERY_CACHE_TTL_MS);
    return result;
  }

  private async safeDiscover(query: string, sources: Source[]): Promise<DiscoveryBatch> {
    try {
      return await this.discover(query, sources);
    } catch (error) {
      return {
        threads: [],
        warnings: [`Discovery failed: ${error instanceof Error ? error.message : "unknown discovery error"}`],
      };
    }
  }

  async search({ query, locale = "auto", sources }: SearchInput): Promise<SearchResult> {
    const initialLocales = selectInitialLocales(query, locale);
    if (sources?.length && sourcesForLocales(["tr", "en"], sources).length === 0) {
      return {
        locales: initialLocales,
        expandedToBoth: false,
        threads: [],
        warnings: ["None of the requested sources are enabled in the forum catalog."],
      };
    }

    if (initialLocales.length > 1) {
      const outcomes = await Promise.all(initialLocales.map((selectedLocale) =>
        this.safeDiscover(query, sourcesForLocales([selectedLocale], sources))
      ));
      const threads = deduplicate(outcomes.flatMap((outcome) => outcome.threads));
      const warnings = outcomes.flatMap((outcome) => outcome.warnings);
      if (!threads.length) warnings.push("No eligible forum threads were found for this research scope.");
      return { locales: initialLocales, expandedToBoth: false, threads, warnings };
    }

    const initialSources = sourcesForLocales(initialLocales, sources);
    const initial = await this.safeDiscover(query, initialSources);
    const initialThreads = initial.threads;
    const locales = [...initialLocales];
    let expandedToBoth = false;
    let threads = initialThreads;
    const warnings: string[] = [...initial.warnings];

    if (locale === "auto" && !hasSufficientEvidence(initialThreads)) {
      const fallback = secondaryLocale(initialLocales);
      if (fallback) {
        const fallbackSources = sourcesForLocales([fallback], sources);
        const fallbackResult = await this.safeDiscover(query, fallbackSources);
        threads = [...initialThreads, ...fallbackResult.threads];
        warnings.push(...fallbackResult.warnings);
        locales.push(fallback);
        expandedToBoth = true;
      }
    }

    const uniqueThreads = deduplicate(threads);
    if (!uniqueThreads.length) warnings.push("No eligible forum threads were found for this research scope.");
    if (expandedToBoth) warnings.push("Initial evidence was limited, so the research expanded to both languages.");

    return { locales, expandedToBoth, threads: uniqueThreads, warnings };
  }

  async research({ depth = "standard", ...input }: ResearchInput): Promise<ResearchResult> {
    const search = await this.search(input);
    const evidence: ThreadEvidence[] = [];
    const warnings = [...search.warnings];
    const attemptedUrls = new Set<string>();
    let threads = [...search.threads];
    let locales = [...search.locales];
    let expandedToBoth = search.expandedToBoth;

    if (!this.dependencies.read) {
      warnings.push("Direct thread reading is not configured; discovery results are not treated as evidence.");
    } else {
      const readCandidates = async (candidates: DiscoveredThread[]) => {
        for (const thread of prioritizeDistinctSources(candidates)
          .filter((candidate) => !attemptedUrls.has(candidate.url))
          .slice(0, DEPTH_LIMIT[depth])) {
          attemptedUrls.add(thread.url);
          try {
            evidence.push(await this.dependencies.read!({ sourceId: thread.sourceId, url: thread.url }));
          } catch (error) {
            warnings.push(`Skipped ${thread.url}: ${error instanceof Error ? error.message : "unreadable source"}`);
          }
        }
      };

      await readCandidates(threads);
      const directSourceCount = new Set(evidence.map((item) => item.sourceId)).size;
      if ((input.locale ?? "auto") === "auto" && !expandedToBoth && directSourceCount < MINIMUM_DISTINCT_SOURCES) {
        const fallback = secondaryLocale(locales);
        const fallbackSources = fallback ? sourcesForLocales([fallback], input.sources) : [];
        if (fallback && fallbackSources.length) {
          const fallbackResult = await this.safeDiscover(input.query, fallbackSources);
          warnings.push(...fallbackResult.warnings);
          threads = deduplicate([...threads, ...fallbackResult.threads]);
          locales = [...locales, fallback];
          expandedToBoth = true;
          warnings.push("Direct evidence was limited, so the research expanded to both languages.");
          await readCandidates(fallbackResult.threads);
        }
      }
    }

    const sourceCount = new Set(evidence.map((item) => item.sourceId)).size;
    const summary = `${evidence.length} directly read thread${evidence.length === 1 ? "" : "s"} from ${sourceCount} source${sourceCount === 1 ? "" : "s"}.`;
    if (!evidence.length) warnings.push("No direct thread evidence could be read; do not treat discovery snippets as findings.");

    return { ...search, locales, expandedToBoth, threads, warnings, evidence, summary };
  }
}
