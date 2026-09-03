import { catalog, sourcesForLocales, type Source } from "./catalog.js";
import type { ResearchCache } from "./cache.js";
import type { DiscoveredThread, DiscoveryBatch, RelatedLead } from "./discovery.js";
import type { ThreadEvidence } from "./reader.js";
import type { ReadFocus } from "./discourse.js";
import { assessRelevance } from "./relevance.js";
import { secondaryLocale, selectInitialLocales, type Locale, type LocalePreference } from "./routing.js";

export interface SearchInput {
  query: string;
  locale?: LocalePreference;
  sources?: string[];
  queryVariants?: string[];
  depth?: ResearchDepth;
}

export interface SearchResult {
  query_variants: string[];
  coverage_complete_for_no_relevant_evidence: boolean;
  locales: Locale[];
  expandedToBoth: boolean;
  threads: DiscoveredThread[];
  related_leads: RelatedLead[];
  warnings: string[];
  coverage: Coverage;
  issues: ResearchIssue[];
}

export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchInput extends SearchInput {
}

export interface ResearchResult extends SearchResult {
  evidence: ThreadEvidence[];
  summary: string;
  status: ResearchStatus;
  findings: {
    userExperienceSummaries: string[];
    disagreements: string[];
    recurringFindings: string[];
    coverageWarning?: string;
  };
}

export type ResearchStatus = "ok" | "partial" | "no_relevant_evidence" | "coverage_limited";

export interface ResearchIssue {
  stage: "discovery" | "reading" | "relevance";
  code: "http_403" | "rate_limited" | "robots_denied" | "login_required" | "irrelevant_result" | "read_failed" | "discovery_failed" | "source_search_missed";
  message: string;
  sourceId?: string;
  url?: string;
}

export interface Coverage {
  attemptedSources: string[];
  successfulSources: string[];
  failedSources: string[];
  blockedSources: string[];
  passiveSources: string[];
  querySearchSources: string[];
  sampledIndexSources: string[];
  irrelevantResultsRejected: number;
  duplicateResultsRejected: number;
  queriesUsed: string[];
  requestedQueries: string[];
  executedQueries: string[];
  locallyEvaluatedQueries: string[];
  sampledIndexes: Array<{
    sourceId: string;
    indexUrl: string;
    status: "success" | "blocked" | "failed";
    uniqueCandidates: number;
    matchedQueries: string[];
  }>;
  nativeDiscovery: Array<{
    sourceId: string;
    strategy: Source["discoveryStrategy"];
    indexUrl?: string;
    status: "success" | "blocked" | "failed";
    discoveredCandidates: number;
  }>;
  perQuery: QueryCoverage[];
  completeForNoRelevantEvidence: boolean;
}

export interface QueryCoverage {
  query: string;
  attemptedSources: string[];
  successfulSources: string[];
  blockedSources: string[];
  strategies: Source["discoveryStrategy"][];
  querySearchSuccessfulSources: string[];
  sampledIndexMatchedSources: string[];
}

export interface ForumResearchDependencies {
  discover(input: { query: string; sources: Source[]; queryVariants?: string[]; maxRequests?: number }): Promise<DiscoveryBatch | DiscoveredThread[]>;
  read?(input: { sourceId: string; url: string }, focus?: ReadFocus): Promise<ThreadEvidence>;
  cache?: Pick<ResearchCache, "get" | "set">;
}

const MINIMUM_DISTINCT_SOURCES = 3;
const DEPTH_LIMIT: Record<ResearchDepth, number> = { quick: 3, standard: 6, deep: 12 };
const DISCOVERY_REQUEST_BUDGET: Record<ResearchDepth, number> = { quick: 6, standard: 18, deep: 40 };
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

function deduplicateRelatedLeads(leads: RelatedLead[]): RelatedLead[] {
  const seen = new Set<string>();
  return leads.filter((lead) => {
    const key = lead.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function prioritizeDistinctSources(threads: DiscoveredThread[]): DiscoveredThread[] {
  const ranked = [...threads].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const seenSources = new Set<string>();
  const firstFromEachSource: DiscoveredThread[] = [];
  const remaining: DiscoveredThread[] = [];
  for (const thread of ranked) {
    if (seenSources.has(thread.sourceId)) remaining.push(thread);
    else {
      seenSources.add(thread.sourceId);
      firstFromEachSource.push(thread);
    }
  }
  return [...firstFromEachSource, ...remaining];
}

function normalizeVariants(variants: string[] | undefined): string[] {
  const seen = new Set<string>();
  return (variants ?? []).flatMap((variant) => {
    const trimmed = variant.trim().replace(/\s+/g, " ");
    const key = trimmed.toLocaleLowerCase("tr-TR");
    if (!trimmed || seen.has(key) || seen.size >= 12) return [];
    seen.add(key);
    return [trimmed];
  });
}

function suggestedVariants(query: string): string[] {
  const normalized = query.toLocaleLowerCase("tr-TR").replace(/ı/g, "i");
  if (/\bgemi\b/.test(normalized) && /\bbakim\b/.test(normalized)) {
    return [
      "AMOS gemi bakım",
      "ShipManager planned maintenance",
      "Sertica gemi",
      "BASSnet bakım",
      "NS5 ship maintenance",
      "TM Master",
      "planned maintenance system PMS",
      "gemi bakım yönetim sistemi",
      "fleet management software",
      "vessel management software",
      "vessel-to-shore reporting software",
      "noon report software",
    ];
  }
  return [];
}

export class ForumResearchService {
  constructor(private readonly dependencies: ForumResearchDependencies) {}

  private normalizeDiscovery(value: DiscoveryBatch | DiscoveredThread[]): DiscoveryBatch {
    return Array.isArray(value) ? { threads: value, warnings: [] } : value;
  }

  private async discover(query: string, sources: Source[], queryVariants: string[], maxRequests: number): Promise<DiscoveryBatch> {
    const cacheKey = `v5:discovery:${query}:${queryVariants.join("|")}:${maxRequests}:${sources.map((source) => source.id).sort().join(",")}`;
    const cached = this.dependencies.cache?.get<DiscoveryBatch | DiscoveredThread[]>(cacheKey);
    if (cached) return this.normalizeDiscovery(cached);

    const result = this.normalizeDiscovery(await this.dependencies.discover({ query, sources, queryVariants, maxRequests }));
    this.dependencies.cache?.set(cacheKey, result, DISCOVERY_CACHE_TTL_MS);
    return result;
  }

  private async safeDiscover(query: string, sources: Source[], queryVariants: string[], maxRequests: number): Promise<DiscoveryBatch> {
    try {
      return await this.discover(query, sources, queryVariants, maxRequests);
    } catch (error) {
      return {
        threads: [],
        relatedLeads: [],
        warnings: [`Discovery failed: ${error instanceof Error ? error.message : "unknown discovery error"}`],
      };
    }
  }

  async search({ query, locale = "auto", sources, queryVariants: rawVariants, depth = "standard" }: SearchInput): Promise<SearchResult> {
    const queryVariants = normalizeVariants(rawVariants?.length ? rawVariants : suggestedVariants(query));
    const discoveryBudget = DISCOVERY_REQUEST_BUDGET[depth];
    const initialLocales = selectInitialLocales(query, locale);
    if (sources?.length && sourcesForLocales(["tr", "en"], sources).length === 0) {
      return {
        locales: initialLocales,
        query_variants: queryVariants,
        expandedToBoth: false,
        threads: [],
        related_leads: [],
        warnings: ["None of the requested sources are enabled in the forum catalog."],
        coverage_complete_for_no_relevant_evidence: false,
        coverage: this.emptyCoverage(query, queryVariants),
        issues: [],
      };
    }

    if (initialLocales.length > 1) {
      const outcomes = await Promise.all(initialLocales.map((selectedLocale) =>
        this.safeDiscover(query, sourcesForLocales([selectedLocale], sources), queryVariants, Math.ceil(discoveryBudget / initialLocales.length))
      ));
      const threads = deduplicate(outcomes.flatMap((outcome) => outcome.threads));
      const relatedLeads = deduplicateRelatedLeads(outcomes.flatMap((outcome) => outcome.relatedLeads ?? []));
      const warnings = outcomes.flatMap((outcome) => outcome.warnings);
      if (!threads.length) warnings.push("No eligible forum threads were found for this research scope.");
      const coverage = this.coverageFor(query, queryVariants, initialLocales, sources, threads, outcomes);
      return {
        locales: initialLocales,
        query_variants: queryVariants,
        coverage_complete_for_no_relevant_evidence: coverage.completeForNoRelevantEvidence,
        expandedToBoth: false,
        threads,
        related_leads: relatedLeads,
        warnings,
        coverage,
        issues: this.issuesFor(outcomes),
      };
    }

    const initialSources = sourcesForLocales(initialLocales, sources);
    const initialBudget = locale === "auto" ? Math.ceil(discoveryBudget / 2) : discoveryBudget;
    const initial = await this.safeDiscover(query, initialSources, queryVariants, initialBudget);
    const initialThreads = initial.threads;
    const locales = [...initialLocales];
    let expandedToBoth = false;
    let threads = initialThreads;
    let relatedLeads = initial.relatedLeads ?? [];
    const discoveryBatches = [initial];
    const warnings: string[] = [...initial.warnings];

    if (locale === "auto" && !hasSufficientEvidence(initialThreads)) {
      const fallback = secondaryLocale(initialLocales);
      if (fallback) {
        const fallbackSources = sourcesForLocales([fallback], sources);
        const fallbackResult = await this.safeDiscover(query, fallbackSources, queryVariants, discoveryBudget - initialBudget);
        discoveryBatches.push(fallbackResult);
        threads = [...initialThreads, ...fallbackResult.threads];
        relatedLeads = [...relatedLeads, ...(fallbackResult.relatedLeads ?? [])];
        warnings.push(...fallbackResult.warnings);
        locales.push(fallback);
        expandedToBoth = true;
      }
    }

    const uniqueThreads = deduplicate(threads);
    if (!uniqueThreads.length) warnings.push("No eligible forum threads were found for this research scope.");
    if (expandedToBoth) warnings.push("Initial evidence was limited, so the research expanded to both languages.");

    const coverage = this.coverageFor(query, queryVariants, locales, sources, uniqueThreads, discoveryBatches);
    return {
      locales,
      query_variants: queryVariants,
      coverage_complete_for_no_relevant_evidence: coverage.completeForNoRelevantEvidence,
      expandedToBoth,
      threads: uniqueThreads,
      related_leads: deduplicateRelatedLeads(relatedLeads),
      warnings,
      coverage,
      issues: this.issuesFor(discoveryBatches),
    };
  }

  private emptyCoverage(query: string, queryVariants: string[]): Coverage {
    const requestedQueries = [query, ...queryVariants];
    return {
      attemptedSources: [], successfulSources: [], failedSources: [], blockedSources: [], passiveSources: [],
      querySearchSources: [], sampledIndexSources: [], irrelevantResultsRejected: 0, duplicateResultsRejected: 0,
      queriesUsed: [], requestedQueries, executedQueries: [],
      locallyEvaluatedQueries: [], sampledIndexes: [],
      nativeDiscovery: [],
      perQuery: requestedQueries.map((requestedQuery) => ({
        query: requestedQuery, attemptedSources: [], successfulSources: [], blockedSources: [], strategies: [],
        querySearchSuccessfulSources: [], sampledIndexMatchedSources: [],
      })),
      completeForNoRelevantEvidence: false,
    };
  }

  private coverageFor(query: string, queryVariants: string[], locales: Locale[], sourceFilter: string[] | undefined, threads: DiscoveredThread[], batches: DiscoveryBatch[]): Coverage {
    const outcomes = batches.flatMap((batch) => batch.sourceOutcomes ?? []);
    const requestedQueries = [query, ...queryVariants];
    const isQueryOutcome = (outcome: NonNullable<DiscoveryBatch["sourceOutcomes"]>[number]) => outcome.kind === "query_search" || typeof outcome.query === "string";
    const isSampledOutcome = (outcome: NonNullable<DiscoveryBatch["sourceOutcomes"]>[number]) => outcome.kind === "sampled_index";
    const queryOutcomes = outcomes.filter(isQueryOutcome);
    const sampledOutcomes = outcomes.filter(isSampledOutcome);
    const perQuery = requestedQueries.map((requestedQuery) => {
      const matching = queryOutcomes.filter((outcome) => outcome.query === requestedQuery);
      const sampledMatching = sampledOutcomes.filter((outcome) => outcome.queriesEvaluated?.includes(requestedQuery));
      const querySearchSuccessfulSources = [...new Set(matching
        .filter((outcome) => outcome.status === "success")
        .map((outcome) => outcome.sourceId))];
      const sampledIndexMatchedSources = [...new Set(sampledMatching
        .filter((outcome) => outcome.status === "success")
        .map((outcome) => outcome.sourceId))];
      return {
        query: requestedQuery,
        attemptedSources: [...new Set([...matching, ...sampledMatching].map((outcome) => outcome.sourceId))],
        successfulSources: [...new Set([...querySearchSuccessfulSources, ...sampledIndexMatchedSources])],
        blockedSources: [...new Set(matching.filter((outcome) => outcome.status === "blocked").map((outcome) => outcome.sourceId))],
        strategies: [...new Set([...matching, ...sampledMatching].map((outcome) => outcome.strategy))],
        querySearchSuccessfulSources,
        sampledIndexMatchedSources,
      };
    });
    const maritimePms = /\b(?:gemi|ship|maritime|vessel)\b/i.test(requestedQueries.join(" "))
      && /\b(?:bakım|bakim|maintenance|planned|pms)\b/i.test(requestedQueries.join(" "));
    const hasThreeQuerySearchSources = perQuery.every((item) => item.querySearchSuccessfulSources.length >= MINIMUM_DISTINCT_SOURCES);
    const hasMaritimeQuerySearchSource = !maritimePms || perQuery.every((item) => item.querySearchSuccessfulSources
      .some((sourceId) => {
        const source = catalog.find((candidate) => candidate.id === sourceId);
        return source?.searchCapability === "query_search" && source.domainTags.includes("maritime");
      }));
    const completeForNoRelevantEvidence = hasThreeQuerySearchSources && hasMaritimeQuerySearchSource;
    return {
      attemptedSources: [...new Set(outcomes.map((outcome) => outcome.sourceId))],
      successfulSources: outcomes.length
        ? [...new Set(outcomes.filter((outcome) => outcome.status === "success").map((outcome) => outcome.sourceId))]
        : [...new Set(threads.map((thread) => thread.sourceId))],
      failedSources: [...new Set(outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.sourceId))],
      blockedSources: [...new Set(outcomes.filter((outcome) => outcome.status === "blocked").map((outcome) => outcome.sourceId))],
      passiveSources: catalog
        .filter((source) => locales.includes(source.locale) && !source.enabled && (!sourceFilter?.length || sourceFilter.includes(source.id)))
        .map((source) => source.id),
      querySearchSources: [...new Set(queryOutcomes.map((outcome) => outcome.sourceId))],
      sampledIndexSources: [...new Set(sampledOutcomes.map((outcome) => outcome.sourceId))],
      irrelevantResultsRejected: batches.reduce((total, batch) => total + (batch.irrelevantResultsRejected ?? 0), 0),
      duplicateResultsRejected: batches.reduce((total, batch) => total + (batch.duplicateResultsRejected ?? 0), 0),
      queriesUsed: requestedQueries.filter((requestedQuery) => queryOutcomes.some((outcome) => outcome.query === requestedQuery)),
      requestedQueries,
      executedQueries: requestedQueries.filter((requestedQuery) => queryOutcomes.some((outcome) => outcome.query === requestedQuery)),
      locallyEvaluatedQueries: requestedQueries.filter((requestedQuery) => sampledOutcomes.some((outcome) => outcome.status === "success" && outcome.queriesEvaluated?.includes(requestedQuery))),
      sampledIndexes: sampledOutcomes.map((outcome) => ({
        sourceId: outcome.sourceId,
        indexUrl: outcome.indexUrl ?? "",
        status: outcome.status,
        uniqueCandidates: outcome.uniqueCandidateCount ?? outcome.discoveredCount,
        matchedQueries: outcome.queriesEvaluated ?? [],
      })),
      nativeDiscovery: outcomes.map((outcome) => ({
        sourceId: outcome.sourceId,
        strategy: outcome.strategy,
        indexUrl: outcome.indexUrl,
        status: outcome.status,
        discoveredCandidates: outcome.discoveredCount,
      })),
      perQuery,
      completeForNoRelevantEvidence,
    };
  }

  private issuesFor(batches: DiscoveryBatch[]): ResearchIssue[] {
    return batches.flatMap((batch) => (batch.sourceOutcomes ?? []).flatMap((outcome): ResearchIssue[] => {
      const context = outcome.kind === "sampled_index"
        ? outcome.indexUrl ?? "sampled index"
        : outcome.query ?? "query";
      if (outcome.status === "blocked") {
        return [{
          stage: "discovery" as const,
          code: outcome.issueCode ?? "http_403",
          message: `Source blocked discovery for ${context}.`,
          sourceId: outcome.sourceId,
        }];
      }
      if (outcome.status === "failed") {
        return [{
          stage: "discovery" as const,
          code: "discovery_failed" as const,
          message: `Source discovery failed for ${context}.`,
          sourceId: outcome.sourceId,
        }];
      }
      if (outcome.status === "success" && outcome.discoveredCount === 0 && outcome.kind === "query_search") {
        return [{
          stage: "discovery" as const,
          code: "source_search_missed" as const,
          message: `Source-native search found no candidate for ${context}.`,
          sourceId: outcome.sourceId,
        }];
      }
      return [];
    }));
  }

  private coverageGapWarning(coverage: Coverage): string {
    const incompleteQueries = coverage.perQuery
      .filter((item) => item.querySearchSuccessfulSources.length < MINIMUM_DISTINCT_SOURCES)
      .map((item) => `${item.query} (${item.querySearchSuccessfulSources.length}/3 query-search sources)`);
    const maritimeGap = coverage.requestedQueries.some((requestedQuery) => /\b(?:gemi|ship|maritime|vessel)\b/i.test(requestedQuery))
      && coverage.perQuery.some((item) => !item.successfulSources.some((sourceId) => {
        const source = catalog.find((candidate) => candidate.id === sourceId);
        return source?.searchCapability === "query_search" && source.domainTags.includes("maritime");
      }));
    const details = [
      incompleteQueries.length ? `Incomplete query coverage: ${incompleteQueries.join(", ")}.` : "",
      coverage.locallyEvaluatedQueries.length
        ? `${coverage.locallyEvaluatedQueries.length} requested quer${coverage.locallyEvaluatedQueries.length === 1 ? "y was" : "ies were"} locally evaluated against sampled indexes; they were not remotely searched there.`
        : "",
      maritimeGap ? "No successful maritime query-search source covered every requested query." : "",
    ].filter(Boolean).join(" ");
    return `${details} Absence of evidence is not evidence of absence.`.trim();
  }

  async research({ depth = "standard", ...input }: ResearchInput): Promise<ResearchResult> {
    const search = await this.search({ ...input, depth });
    const evidence: ThreadEvidence[] = [];
    const warnings = [...search.warnings];
    const issues = [...search.issues];
    const coverage: Coverage = { ...search.coverage, irrelevantResultsRejected: search.coverage.irrelevantResultsRejected };
    const evidenceVariants = search.query_variants;
    let relatedLeads = [...search.related_leads];
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
            const direct = await this.dependencies.read!({ sourceId: thread.sourceId, url: thread.url }, {
              query: input.query,
              variants: evidenceVariants,
            });
            const relevance = assessRelevance({
              query: input.query,
              variants: evidenceVariants,
              title: direct.title,
              text: direct.excerpt,
            });
            if (relevance.accepted) evidence.push(direct);
            else {
              coverage.irrelevantResultsRejected += 1;
              issues.push({
                stage: "relevance",
                code: "irrelevant_result",
                message: `Discarded direct read: ${relevance.reason}.`,
                sourceId: thread.sourceId,
                url: thread.url,
              });
            }
          } catch (error) {
            warnings.push(`Skipped ${thread.url}: ${error instanceof Error ? error.message : "unreadable source"}`);
            issues.push({ stage: "reading", code: "read_failed", message: "Direct thread read failed.", sourceId: thread.sourceId, url: thread.url });
          }
        }
      };

      await readCandidates(threads);
      const directSourceCount = new Set(evidence.map((item) => item.sourceId)).size;
      if ((input.locale ?? "auto") === "auto" && !expandedToBoth && directSourceCount < MINIMUM_DISTINCT_SOURCES) {
        const fallback = secondaryLocale(locales);
        const fallbackSources = fallback ? sourcesForLocales([fallback], input.sources) : [];
        if (fallback && fallbackSources.length) {
          const fallbackResult = await this.safeDiscover(input.query, fallbackSources, normalizeVariants(input.queryVariants), Math.floor(DISCOVERY_REQUEST_BUDGET[depth] / 2));
          warnings.push(...fallbackResult.warnings);
          threads = deduplicate([...threads, ...fallbackResult.threads]);
          relatedLeads = deduplicateRelatedLeads([...relatedLeads, ...(fallbackResult.relatedLeads ?? [])]);
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

    const status: ResearchStatus = sourceCount >= MINIMUM_DISTINCT_SOURCES
      ? "ok"
      : evidence.length > 0
        ? "partial"
        : coverage.completeForNoRelevantEvidence
          ? "no_relevant_evidence"
          : "coverage_limited";
    const coverageWarning = status === "ok"
      ? undefined
      : status === "partial"
        ? "Relevant evidence exists, but fewer than three independent sources were read."
        : status === "no_relevant_evidence"
          ? "At least three sources were searched, but no directly read relevant evidence was found."
          : this.coverageGapWarning(coverage);
    return {
      ...search,
      locales,
      expandedToBoth,
      threads,
      related_leads: relatedLeads,
      warnings,
      evidence,
      summary,
      status,
      coverage,
      issues,
      findings: {
        userExperienceSummaries: evidence.map((item) => item.excerpt.slice(0, 500)),
        disagreements: [],
        recurringFindings: [],
        coverageWarning,
      },
    };
  }
}
