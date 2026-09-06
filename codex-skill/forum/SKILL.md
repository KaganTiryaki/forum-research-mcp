---
name: forum
description: Read-only research across the configured Turkish and English forum MCP sources.
---

# Forum Research

When the user invokes `/forum`, use the MCP tool `forum_research` for a research answer.

- Use the user's text after `/forum` as `query`.
- Default to `locale: "auto"` and `depth: "standard"` unless requested otherwise.
- For broad questions, use `depth: "deep"`.
- Preserve source URLs, dates, excerpts, coverage status, and warnings.
- Never post, log in, react, or modify forum content.
