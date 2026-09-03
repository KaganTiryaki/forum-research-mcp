# Zero-Configuration Native Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP discover and transparently report source-native, adjacent forum leads without an API key, login, or general web search provider.

**Architecture:** Extend the discovery batch with bounded `relatedLeads` and native-index outcome metadata. Keep accepted discovery candidates and direct evidence unchanged; route only strict candidates into reading. Add bounded maritime query variants, then surface adjacent source-native candidates as non-evidence navigation leads.

**Tech Stack:** Node.js 24, TypeScript, MCP SDK, Node test runner, existing source-specific HTTP adapters.

**Spec:** `docs/superpowers/specs/2026-09-03-zero-config-native-discovery-design.md`

## Global Constraints

- No API key, browser session, account, general-search API, or search-engine-result scraping.
- Do not enable Reddit or request any robots-disallowed source.
- Every native URL must be HTTPS and covered by the source discovery allowlist.
- Related leads are metadata only and must never enter direct-reading, evidence, status, or coverage-completeness calculations.
- Keep the normalized caller/default variant list at twelve values at most.
- Preserve the existing public tool input schema; new result fields are additive.
- Use `v5:` cache keys for the changed discovery result schema.

---

### Task 1: Classify and retain bounded related leads

**Files:**
- Modify: `src/relevance.ts`
- Modify: `src/discovery.ts`
- Modify: `test/relevance.test.ts`
- Modify: `test/discovery.test.ts`

**Interfaces:**
- Produces `DiscoveryCandidateClassification` with `kind: "accepted" | "related" | "rejected"` and a reason.
- Produces `DiscoveryBatch.relatedLeads: RelatedLead[]` and `nativeDiscoveryOutcomes`.
- Consumes source `domainTags` and existing `assessRelevance` system/recruitment guards.

- [ ] **Step 1: Write the failing classification tests**

```ts
test("classifies vessel-to-shore reporting as a related maritime software lead", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["vessel-to-shore reporting software"],
    title: "Looking for suggestions for vessel to shore reporting software",
    text: "Need daily reports from ship to office.",
    domainTags: ["maritime", "professional"],
  });
  assert.equal(result.kind, "related");
});

test("classifies a ship-engineering career page as rejected rather than a related lead", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    title: "Gemi İnşaatı ve Gemi Makineleri Mühendisliği Bölümü Bilgi",
    text: "Kariyer fırsatları ve bölüm hakkında sorular.",
    domainTags: ["maritime"],
  });
  assert.equal(result.kind, "rejected");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --test-name-pattern "classifies"`

Expected: FAIL because `classifyDiscoveryCandidate` does not exist.

- [ ] **Step 3: Add the minimal classification and discovery-batch structures**

```ts
export interface RelatedLead extends DiscoveredThread {
  exclusionReason: "adjacent_topic";
}

export function classifyDiscoveryCandidate(input: RelevanceInput & { domainTags: string[] }) {
  const strict = assessRelevance(input);
  if (strict.accepted) return { kind: "accepted" as const, assessment: strict };
  // Admit only maritime operation/software metadata after existing guards ran.
  // Every other candidate remains rejected.
}
```

Filter `threads` from `kind === "accepted"`, collect at most twelve unique related leads after URL deduplication, and keep rejection counts for all other candidates.

- [ ] **Step 4: Add a fixture-backed discovery test**

```ts
test("discovery preserves an adjacent lead outside the evidence candidate list", async () => {
  const result = await discoverThreads({ /* fixture source and fetcher */ });
  assert.deepEqual(result.threads, []);
  assert.equal(result.relatedLeads[0]?.title, "Looking for suggestions for vessel to shore reporting software");
  assert.equal(result.relatedLeads[0]?.exclusionReason, "adjacent_topic");
});
```

- [ ] **Step 5: Run focused relevance and discovery tests**

Run: `npm test -- --test-name-pattern "related|adjacent|career page"`

Expected: PASS.

- [ ] **Step 6: Commit the completed task**

```bash
git add src/relevance.ts src/discovery.ts test/relevance.test.ts test/discovery.test.ts
git commit -m "feat: retain bounded related discovery leads"
```

### Task 2: Add zero-config maritime native query families and report them

**Files:**
- Modify: `src/research.ts`
- Modify: `src/cache.ts`
- Modify: `test/research.test.ts`
- Modify: `test/cache.test.ts`

**Interfaces:**
- Produces `SearchResult.related_leads` and `Coverage.nativeDiscovery`.
- Consumes `DiscoveryBatch.relatedLeads` and `DiscoveryBatch.sourceOutcomes`.
- Produces `suggestedVariants(query): string[]` with the existing 12-variant ceiling.

- [ ] **Step 1: Write failing query-family and evidence-isolation tests**

```ts
test("maritime research adds vessel management and noon reporting variants within the cap", async () => {
  const result = await service.search({ query: "gemi bakım yazılımı", locale: "both", depth: "deep" });
  assert.ok(result.query_variants.includes("vessel management software"));
  assert.ok(result.query_variants.includes("noon report software"));
  assert.ok(result.query_variants.length <= 12);
});

test("related leads never become research evidence", async () => {
  const result = await service.research({ query: "gemi bakım yazılımı", locale: "en" });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.related_leads.length, 1);
  assert.equal(result.status, "coverage_limited");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --test-name-pattern "vessel management|related leads never"`

Expected: FAIL because the variants and `related_leads` field are absent.

- [ ] **Step 3: Implement bounded variants and additive result mapping**

```ts
const MARITIME_NATIVE_VARIANTS = [
  "fleet management software", "vessel management software",
  "vessel-to-shore reporting software", "noon report software",
  "gemi filo yönetim yazılımı", "gemi-kıyı raporlama yazılımı",
];
```

Merge caller variants before suggested variants, deduplicate with the current Turkish normalization, and slice to twelve. Add `related_leads` to search/research output. Build `coverage.nativeDiscovery` only from actual source outcomes; never infer an attempted surface.

- [ ] **Step 4: Version the discovery cache**

Change the cache key prefix from `v4:` to `v5:` and add a test that a `v4:` entry is not read as a `v5:` result.

- [ ] **Step 5: Run focused research and cache tests**

Run: `npm test -- --test-name-pattern "maritime research|related leads|v5"`

Expected: PASS.

- [ ] **Step 6: Commit the completed task**

```bash
git add src/research.ts src/cache.ts test/research.test.ts test/cache.test.ts
git commit -m "feat: report native related leads without evidence inflation"
```

### Task 3: Preserve policy boundaries and document zero-config operation

**Files:**
- Modify: `src/catalog.ts`
- Modify: `test/catalog.test.ts`
- Modify: `test/reader.test.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces catalog source metadata identifying native discovery strategy and passive reason.
- Preserves `thread_read` rejection for passive Reddit.
- Sets package version to `0.3.0`.

- [ ] **Step 1: Write failing policy and catalog tests**

```ts
test("reddit remains passive even though a browser can render public HTML", () => {
  const reddit = getSource("reddit");
  assert.equal(reddit?.enabled, false);
  assert.equal(reddit?.disabledReason, "robots_denied");
});

test("related-lead discovery does not add Reddit to attempted sources", async () => {
  const result = await service.search({ query: "vessel management software", locale: "en" });
  assert.ok(!result.coverage.attemptedSources.includes("reddit"));
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --test-name-pattern "reddit remains|does not add Reddit"`

Expected: FAIL because the passive reason is currently `policy_or_access_review` or Reddit is not explicitly represented.

- [ ] **Step 3: Make the catalog reason explicit and keep read protection intact**

Set the English Reddit candidate to `enabled: false` with `disabledReason: "robots_denied"`. Do not alter `reader.ts` to admit passive sources. Ensure `sourcesForLocales` continues to select only enabled sources.

- [ ] **Step 4: Update README and package version**

Document the exact zero-config install path, source-native discovery boundary, `related_leads` semantics, and why Reddit is passive. State that general-search-engine coverage is intentionally unavailable without a separate service.

- [ ] **Step 5: Run policy tests, full checks, and clean runtime checks**

Run:

```bash
npm run check
node bin/serve.mjs --check
git diff --check
```

Expected: all tests pass, launcher reports `0.3.0`, and no whitespace errors.

- [ ] **Step 6: Commit the completed task**

```bash
git add src/catalog.ts test/catalog.test.ts test/reader.test.ts README.md package.json
git commit -m "docs: release zero-config native discovery"
```

### Task 4: Validate the real maritime regression and release safely

**Files:**
- Modify: `test/fixtures/` only if a stable public response must be frozen for a missing regression case.
- Modify: `.github/workflows/ci.yml` only if the existing Windows and Ubuntu matrix is missing.

**Interfaces:**
- Consumes the completed `forum_research` additive output.
- Produces a release-ready v0.3.0 branch with no external credential requirement.

- [ ] **Step 1: Run the live source-native research regression without secrets**

Run:

```bash
node --input-type=module -e "import { createForumResearchServer } from './dist/server.js'; console.log('Use MCP Inspector or a stdio client to call forum_search with locale both, depth deep, and query gemi bakım yazılımı kullanıcı deneyimleri.');"
```

Expected: no API-key lookup occurs; any accepted direct evidence is linked; adjacent candidates, if found, are marked as non-evidence; passive/blocked sources are listed.

- [ ] **Step 2: Verify the CI matrix**

Run: `Get-Content .github/workflows/ci.yml`

Expected: workflow lists both `ubuntu-latest` and `windows-latest`; add the missing matrix entry before release if absent.

- [ ] **Step 3: Inspect the final diff and branch state**

Run:

```bash
git status --short
git log --oneline main..HEAD
git diff --check main...HEAD
```

Expected: only v0.3.0 discovery, test, documentation, and fixture changes are present.

- [ ] **Step 4: Commit any final test fixture or CI-only change**

```bash
git add test/fixtures .github/workflows/ci.yml
git commit -m "test: cover zero-config native discovery regression"
```

Run this command only if those paths changed.
