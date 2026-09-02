export interface RelevanceInput {
  query: string;
  variants?: string[];
  title: string;
  text: string;
}

export interface RelevanceAssessment {
  accepted: boolean;
  reason: "relevant" | "insufficient_term_overlap" | "system_page" | "ambiguous_short_term";
  matchedTerms: string[];
  score: number;
}

const STOP_WORDS = new Set([
  "acaba", "ama", "bir", "bu", "cok", "da", "daha", "de", "deneyim", "deneyimleri",
  "en", "gibi", "hakkinda", "hangi", "icin", "ile", "iste", "kullanici", "kullanicilari",
  "mi", "mu", "mü", "mı", "nasıl", "nedir", "ne", "olan", "olarak", "ve", "veya", "ya",
  "yorum", "yorumlari", "uzerine", "var", "varmi", "varmı", "forum", "forumlarda", "turk",
  "turkiye", "turkiyede", "turkce",
]);

const SYSTEM_PAGE_PATTERN = /\b(?:kurallar?|gizlilik(?:\s+bildirimi)?|sik\s+sorulan\s+sorular|sss|faq|kullanim\s+kosullari|uyelik|giris(?:\s+yap)?|kayit(?:\s+ol)?|privacy|terms?(?:\s+of\s+service)?|sign\s*in|log\s*in)\b/i;
const AMBIGUOUS_SHORT_TERMS = new Set(["amos", "pms"]);
const CONTEXT_TERMS = new Set(["gemi", "bakim", "yazilim", "ship", "maritime", "maintenance", "vessel"]);

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
