# Forum Research MCP

[![CI](https://github.com/KaganTiryaki/forum-research-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KaganTiryaki/forum-research-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for researching public Turkish and English forum discussions. It discovers relevant threads through source-specific public search endpoints, reads allowlisted pages, and returns source-linked evidence to an MCP client.

This repository currently uses a clone-and-build distribution model; it is not published as an npm package.

- No API key or general-purpose search provider
- Turkish, English, automatic, or bilingual routing
- Public pages only; no login, posting, voting, or account actions
- Per-source rate limits and a strict domain allowlist
- Explicit coverage warnings for `401`, `403`, `429`, CAPTCHA, timeout, and malformed responses
- Two-stage relevance checks reject rules, privacy, account, and FAQ pages for ordinary product research
- Compact SQLite cache for discovery metadata; no full-page archive

## Requirements

- Node.js 24 or newer
- npm
- An MCP host that supports local stdio servers

## Install

```bash
git clone https://github.com/KaganTiryaki/forum-research-mcp.git
cd forum-research-mcp
npm ci
npm run build
```

No environment variables are required.

To update an existing checkout to v0.2.2:

```bash
git pull --ff-only
npm ci
npm run build
```

Restart the MCP host after rebuilding.

## Connect an MCP host

Point your MCP host at the compiled entry file with an absolute path.

### Codex

Add this to your Codex `config.toml`, replacing the paths with the location where you cloned the repository:

```toml
[mcp_servers.forum-research]
command = "node"
args = ["C:\\absolute\\path\\forum-research-mcp\\dist\\index.js"]
cwd = "C:\\absolute\\path\\forum-research-mcp"
```

On macOS or Linux, use normal absolute paths such as `/home/you/forum-research-mcp/dist/index.js`.

### JSON-based MCP hosts

Hosts such as Cursor use the same command in a JSON configuration:

```json
{
  "mcpServers": {
    "forum-research": {
      "command": "node",
      "args": ["/absolute/path/forum-research-mcp/dist/index.js"],
      "cwd": "/absolute/path/forum-research-mcp"
    }
  }
}
```

See the official MCP guide for [connecting stdio servers to real hosts](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/real-host.md).

## Tools

### `forum_search`

Discovers relevant public threads. Discovery snippets are navigation metadata and are not treated as research evidence.

```json
{
  "query": "long-term user experiences with OLED monitors",
  "locale": "both",
  "depth": "standard",
  "sources": ["technopat", "hacker-news"]
}
```

### `forum_research`

Discovers threads and reads their public pages to return a source-linked evidence package.

```json
{
  "query": "gemi bakım yazılımı kullanıcı deneyimleri",
  "locale": "tr",
  "depth": "deep",
  "query_variants": ["AMOS gemi bakım", "ShipManager planned maintenance"]
}
```

`depth` may be `quick`, `standard`, or `deep`, with discovery budgets of 6, 18, and 40 requests respectively. `locale` may be `auto`, `tr`, `en`, or `both`. Explicit Turkish or English research never switches language; only `auto` can expand. `query_variants` accepts at most 12 deduplicated variations. Maritime maintenance queries receive a bounded default set when none is supplied.

Every research result includes a `status`: `ok` needs relevant direct evidence from at least three sources, `partial` has one or two, and `coverage_limited` means the requested query/variant coverage is incomplete. `no_relevant_evidence` is returned only when every requested query and variant completed successfully on three distinct query-search sources. For maritime maintenance research, every query also needs a successful maritime query-search source; otherwise the result stays `coverage_limited`.

`coverage_complete_for_no_relevant_evidence`, `coverage.requestedQueries`, `coverage.executedQueries`, and `coverage.perQuery` make the negative-evidence decision auditable. `executedQueries` means a source actually received the query. Sources that only expose a public category or sitemap are reported separately through `coverage.locallyEvaluatedQueries`, `coverage.sampledIndexes`, and `coverage.sampledIndexSources`; local evaluation of their metadata is not represented as a remote search. `coverage.duplicateResultsRejected` separates repeated index metadata from direct-search relevance rejections. Search snippets and sitemap metadata are never evidence.

### `thread_read`

Reads one public thread from an enabled source after validating its source ID, protocol, hostname, path, redirects, response type, and size.

```json
{
  "sourceId": "hacker-news",
  "url": "https://news.ycombinator.com/item?id=8863"
}
```

### `forum_sources`

Lists every active and passive candidate, its language, read and discovery domains, strategy, policy state, and the precise reason a passive source is not requested.

## Source catalog

The catalog contains 25 Turkish and 25 English candidates. It is an auditable candidate list, not a promise that 25 sources are active. The enabled sources in v0.2.2 are:

| Language | Source | Discovery method | Read domain |
| --- | --- | --- | --- |
| Turkish | Donanım Arşivi Forum | public site search | `forum.donanimarsivi.com` |
| Turkish | DonanımHaber Forum | public `search.donanimhaber.com` service | `forum.donanimhaber.com` |
| Turkish | Technopat Sosyal | public site search | `www.technopat.net` |
| Turkish | SERGİP Forum | bounded public category index | `sergip.com` |
| English | Stack Overflow, Super User, Server Fault | Stack Exchange public API | their own domains |
| English | Hacker News | public Algolia endpoint | `news.ycombinator.com` |
| English | GitHub Discussions | public GitHub search response | `github.com` |
| English | gCaptain Professional Mariner Forum | bounded public sitemap and category JSON metadata; public Discourse topic JSON reads | `forum.gcaptain.com` |

ShiftDelete and PC Hocası sitemap adapters are present but passive until policy and public-read verification is refreshed. Reddit TR is passive after `403`, and Denizcilik Fakültesi is passive because its relevant areas require login. `forum_sources` reports these states at runtime.

gCaptain's `/search` and `/search.json` paths are robots-denied and are never requested. Its sampled sitemap/category metadata can surface older public discussions; the server then reads the selected topic's public Discourse JSON to obtain actual post text. These sampled surfaces can provide evidence, but never by themselves complete query coverage for a negative result.

Disabled candidates remain visible in the catalog for review but are never requested. This includes sources that returned an access block, moved their search endpoint, or could not produce a verified result during release testing. LinkedIn and Ekşi Sözlük are intentionally excluded. Source availability changes over time; an enabled source can still reject automated access. The server reports that gap instead of attempting to bypass it.

## Safety and responsible use

This project is a research client, not an access-control bypass. It refuses:

- non-HTTPS and off-catalog URLs
- credentials embedded in URLs
- login, account, authentication, and CAPTCHA paths
- redirects outside the selected source
- private-network addresses
- oversized or unsupported thread responses (HTML normally; public Discourse JSON only for the catalogued gCaptain adapter)
- access blocks, rate limits, and bot challenges

Users are responsible for confirming that their use complies with each source's current terms, robots policy, copyright rules, and applicable law. Keep source excerpts short and link back to the original discussion.

## Development

```bash
npm ci
npm run check
```

Useful commands:

- `npm run dev` — run the TypeScript entry during development
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled stdio server
- `npm test` — run the automated suite

The MCP Inspector can also launch the compiled server:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Do not print logs to stdout: stdio MCP uses stdout for its protocol messages.

## Türkçe kısa açıklama

Bu proje, Türkçe ve İngilizce açık forum başlıklarını araştıran yerel ve salt-okunur bir MCP sunucusudur. API anahtarı istemez; giriş yapmaz, CAPTCHA aşmaz ve içerik yayımlamaz. Kurulum için depoyu klonlayın, `npm ci` ve `npm run build` çalıştırın, ardından MCP istemcinizi `dist/index.js` dosyasına yönlendirin.

## License

[MIT](LICENSE)
