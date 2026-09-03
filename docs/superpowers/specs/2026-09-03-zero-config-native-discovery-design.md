# Zero-Configuration Native Forum Discovery Design

## Goal

Deliver a local, read-only MCP which works after cloning, `npm ci`, and `npm run build`, without an API key, user account, browser session, or general web-search provider. It must discover as much as it can from each approved forum's own public surfaces and state the remaining coverage boundary truthfully.

## Non-goals and hard boundary

The server must not scrape Google, Bing, DuckDuckGo, or other search-result pages; use Tavily or another hosted search API; sign in; solve CAPTCHAs; or crawl a robots-disallowed source. A global search engine's historical index cannot be reproduced under those conditions. A source that denies robots access remains passive, including Reddit, even if its ordinary HTML page happens to be visible in an interactive browser.

## User-visible behavior

`forum_search` and `forum_research` retain their input schema. Maritime maintenance research gains a bounded native query family when the caller does not supply variants: product names plus `fleet management software`, `vessel management software`, `vessel-to-shore reporting software`, `noon report software`, and Turkish equivalents. The complete normalized family remains capped at twelve variants plus the primary query.

Discovery returns two distinct collections:

- `threads`: candidates that passed the relevance gate and may be directly read.
- `related_leads`: at most twelve source-linked public candidates that are topically adjacent but fail the user-experience relevance gate. Each lead includes `sourceId`, title, URL, date if available, and a machine-readable exclusion reason. They are navigation aids, never evidence and never eligible for direct reading in `forum_research`.

The DonanımHaber ship-engineering topic is not product-experience evidence and is rejected unless its title and content independently meet the selected research intent. Result copy must explicitly say that zero evidence does not mean that related leads are absent.

Coverage adds `nativeDiscovery` with the public source surfaces actually attempted, the number of candidates found, accepted, and retained as related leads. An issue with code `source_search_missed` identifies a source-native search that succeeded but produced no relevant candidate. Existing `coverage_limited`, access-block, and robots reporting remain unchanged.

## Native discovery architecture

`src/catalog.ts` is the sole policy registry. A source may declare one or more approved `nativeDiscoveryIndexes` in addition to its direct search endpoint. Each index is an HTTPS URL under an explicit discovery allowlist and has a strategy (`html_index`, `sitemap`, or `discourse_category_json`) plus a bounded request count. Only enabled sources with assessed read policy and robots status may declare an index.

`src/discovery.ts` schedules direct query searches first, then uses spare budget to sample native indexes. Index parsing produces only title, canonical source URL, and date metadata. It never saves page bodies. Every candidate is classified by `src/relevance.ts` as `accepted`, `related`, or `rejected`:

- Accepted candidates retain today's strict product/user-experience gate.
- Related candidates must have maritime context, an explicit software product signal, and a named operations workflow (for example vessel management or vessel-to-shore reporting). Rules, login, privacy, recruitment, official notices, news, and unrelated engineering discussions are rejected. Related candidates are capped and returned only as `related_leads`.
- Rejected candidates are counted only in coverage.

`src/research.ts` reads accepted threads only. It merges and deduplicates related leads across locales but never uses them for evidence, status, source diversity, or negative-evidence completeness. It applies a final user-narrative gate, rejecting job ads, official notices, and news even when their wording matches. Its cache namespace changes to `v11:` because discovery payload structure and final candidate classification change.

## Catalog policy

Reddit remains passive because its robots policy disallows automated crawling. Its current HTML availability does not override that policy. `thread_read` must continue to reject it. No source is enabled merely because a browser or an external search engine can render one page.

DonanımHaber remains enabled for its documented public search service and direct public thread reads. Its native search result URLs must be canonicalized to readable forum-thread URLs before becoming accepted threads or related leads.

Additional native indexes are enabled only with a fixture, a robots/policy review, a canonical-URL allowlist check, and a public direct-read check. This release may ship no additional enabled forum until those four conditions hold; zero-config reliability is more important than inflating the source count.

## Safety, storage, and compatibility

All existing HTTPS-only, hostname allowlist, redirect revalidation, private-DNS rejection, rate limiting, body-size, login-path, CAPTCHA, and no-retry rules apply unchanged to native indexes. Index metadata is the only cacheable discovery data. Full pages and forum archives remain out of scope.

Existing clients continue to receive `threads`, `coverage`, `warnings`, `issues`, and evidence fields. `related_leads` and `coverage.nativeDiscovery` are additive. Search snippets and related leads are not evidence.

## Verification requirements

- A fixture representing the DonanımHaber ship-engineering page becomes a related lead, not evidence.
- A maritime query family includes vessel-management and noon-reporting phrases while staying inside the twelve-variant cap.
- Rules, login pages, recruitment posts, and generic engineering/career posts cannot become related leads.
- A native index candidate on another host, a malformed index, blocked response, oversized response, or CAPTCHA is rejected and reported without a retry.
- A source-native search that returns no accepted or related candidate is reported as `source_search_missed`, not as evidence absence.
- Reddit is absent from all attempted source sets and remains rejected by `thread_read`.
- `npm run check`, a clean install, `node bin/serve.mjs --check`, and stdio MCP smoke testing pass on Windows and Ubuntu CI before release.
