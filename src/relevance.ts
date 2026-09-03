export interface RelevanceInput {
  query: string;
  variants?: string[];
  title: string;
  text: string;
}

export interface RelevanceAssessment {
  accepted: boolean;
  reason: "relevant" | "domain_candidate" | "insufficient_term_overlap" | "system_page" | "non_experience_page" | "ambiguous_short_term";
  matchedTerms: string[];
  score: number;
}

export interface DiscoveryCandidateClassification {
  kind: "accepted" | "related" | "rejected";
  assessment: RelevanceAssessment;
}

const STOP_WORDS = new Set([
  "acaba", "ama", "bir", "bu", "cok", "da", "daha", "de", "deneyim", "deneyimleri",
  "en", "gibi", "hakkinda", "hangi", "icin", "ile", "iste", "kullanici", "kullanicilari",
  "mi", "mu", "mü", "mı", "nasıl", "nedir", "ne", "olan", "olarak", "ve", "veya", "ya",
  "yorum", "yorumlari", "uzerine", "var", "varmi", "varmı", "forum", "forumlarda", "turk",
  "turkiye", "turkiyede", "turkce",
]);

const SYSTEM_PAGE_PATTERN = /\b(?:kurallar?|gizlilik(?:\s+bildirimi)?|sik\s+sorulan\s+sorular|sss|faq|kullanim\s+kosullari|uyelik|giris(?:\s+yap)?|kayit(?:\s+ol)?|privacy|terms?(?:\s+of\s+service)?|sign\s*in|log\s*in)\b/i;
const NON_EXPERIENCE_PAGE_PATTERN = /\b(?:job\s+posting|job\s+opening|career\s+opportunit|recruit(?:er)?s?|recruitment|recruiting|we\s+are\s+hiring|apply\s+now|position\s+available|is\s+seeking|vacanc(?:y|ies)|ilan(?:i|lar)?|is\s+ilan(?:i|lari)|basvuru)\b/i;
const AMBIGUOUS_SHORT_TERMS = new Set(["amos", "pms"]);
const CONTEXT_TERMS = new Set(["gemi", "bakim", "yazilim", "ship", "maritime", "maintenance", "vessel"]);
const MARITIME_CANDIDATE_TERMS = ["gemi", "ship", "shipboard", "vessel", "marine", "maritime", "engine", "deck"];
const MAINTENANCE_WORKFLOW_TERMS = [
  "bakim", "maintenance", "planned maintenance", "work list", "work lists", "work order", "cmms", "pms",
  "inventory", "spare parts", "inspection", "audit",
];
const MARITIME_OPERATION_SOFTWARE_TERMS = [
  "software", "report", "reporting", "noon report", "daily report", "fleet management", "vessel management",
  "api", "database", "integration", "dashboard", "workflow", "operations", "operation", "logbook",
];

export function normalizeForRelevance(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(value: string): string[] {
  return [...new Set(normalizeForRelevance(value)
    .split(" ")
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)))];
}

function termMatches(term: string, candidateTerms: string[]): boolean {
  return candidateTerms.some((candidate) => candidate === term
    || (term.length >= 5 && candidate.length >= 5 && (candidate.startsWith(term) || term.startsWith(candidate))));
}

function containsRequestedSystemInfo(query: string): boolean {
  return SYSTEM_PAGE_PATTERN.test(normalizeForRelevance(query));
}

function phraseMatches(query: string, candidate: string): boolean {
  const phrase = terms(query).join(" ");
  return phrase.split(" ").length >= 2 && candidate.includes(phrase);
}

export function assessRelevance({ query, variants = [], title, text }: RelevanceInput): RelevanceAssessment {
  const candidate = normalizeForRelevance(`${title} ${text}`);
  const candidateTerms = terms(candidate);

  if (SYSTEM_PAGE_PATTERN.test(candidate) && !containsRequestedSystemInfo(query)) {
    return { accepted: false, reason: "system_page", matchedTerms: [], score: 0 };
  }
  if (NON_EXPERIENCE_PAGE_PATTERN.test(candidate) && !/\b(?:job|career|recruit|ilan|basvuru)\b/i.test(normalizeForRelevance(query))) {
    return { accepted: false, reason: "non_experience_page", matchedTerms: [], score: 0 };
  }

  const queryTerms = terms(query);
  const allQueries = [query, ...variants.filter(Boolean).slice(0, 12)];
  const matchedTerms = [...new Set(queryTerms.filter((term) => termMatches(term, candidateTerms)))];
  const hasPhrase = allQueries.some((candidateQuery) => phraseMatches(candidateQuery, candidate));
  const hasContext = [...CONTEXT_TERMS].some((term) => termMatches(term, candidateTerms));
  const matchedAmbiguous = [...AMBIGUOUS_SHORT_TERMS].filter((term) => termMatches(term, candidateTerms));

  if (matchedAmbiguous.length > 0 && !hasContext) {
    return { accepted: false, reason: "ambiguous_short_term", matchedTerms, score: matchedTerms.length };
  }

  const variantMatches = allQueries.some((candidateQuery) => terms(candidateQuery)
    .filter((term) => !AMBIGUOUS_SHORT_TERMS.has(term))
    .filter((term) => termMatches(term, candidateTerms)).length >= 2);
  const accepted = hasPhrase || matchedTerms.length >= 2 || variantMatches;

  return {
    accepted,
    reason: accepted ? "relevant" : "insufficient_term_overlap",
    matchedTerms,
    score: matchedTerms.length + (hasPhrase ? 2 : 0),
  };
}

export function assessDiscoveryCandidate(input: RelevanceInput & { domainTags: string[] }): RelevanceAssessment {
  const strict = assessRelevance(input);
  if (strict.accepted || !input.domainTags.includes("maritime")) return strict;

  const candidate = normalizeForRelevance(`${input.title} ${input.text}`);
  const maritimeMatches = MARITIME_CANDIDATE_TERMS.filter((term) => candidate.includes(term));
  const workflowMatches = MAINTENANCE_WORKFLOW_TERMS.filter((term) => candidate.includes(term));
  const hasMaritimeTerm = maritimeMatches.length > 0;
  const hasWorkflowTerm = workflowMatches.length > 0;
  return hasMaritimeTerm && hasWorkflowTerm
    ? { accepted: true, reason: "domain_candidate", matchedTerms: [], score: maritimeMatches.length + workflowMatches.length }
    : strict;
}

export function classifyDiscoveryCandidate(input: RelevanceInput & { domainTags: string[] }): DiscoveryCandidateClassification {
  const strict = assessDiscoveryCandidate(input);
  const candidate = normalizeForRelevance(`${input.title} ${input.text}`);
  const requestedTerms = normalizeForRelevance([input.query, ...(input.variants ?? [])].join(" "));
  const isMaritimeMaintenanceResearch = /\b(?:gemi|ship|vessel|maritime|marine)\b/.test(requestedTerms)
    && /\b(?:bakim|maintenance|planned maintenance|pms|cmms)\b/.test(requestedTerms);
  const hasMaintenanceWorkflow = MAINTENANCE_WORKFLOW_TERMS.some((term) => candidate.includes(term));
  const hasMaritimeContext = MARITIME_CANDIDATE_TERMS.some((term) => candidate.includes(term));
  const hasOperationsSoftware = MARITIME_OPERATION_SOFTWARE_TERMS.some((term) => candidate.includes(term));

  if (strict.accepted && (!isMaritimeMaintenanceResearch || hasMaintenanceWorkflow)) {
    return { kind: "accepted", assessment: strict };
  }

  if (!input.domainTags.includes("maritime")
    || ["system_page", "non_experience_page", "ambiguous_short_term"].includes(strict.reason)) {
    return { kind: "rejected", assessment: strict };
  }

  if (!hasMaritimeContext || !hasOperationsSoftware) return { kind: "rejected", assessment: strict };

  return { kind: "related", assessment: strict };
}
