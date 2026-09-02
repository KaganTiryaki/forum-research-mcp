import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResearchCache } from "./cache.js";
import { catalog } from "./catalog.js";
import { discoverThreads } from "./discovery.js";
import { readThread } from "./reader.js";
import { ForumResearchService } from "./research.js";

export const toolNames = ["forum_research", "forum_search", "thread_read", "forum_sources"] as const;

export interface ServerOptions {
  cache?: ResearchCache;
  fetcher?: typeof fetch;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected forum research error";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createForumResearchServer(options: ServerOptions = {}): McpServer {
  const fetcher = options.fetcher ?? fetch;
  const cache = options.cache ?? new ResearchCache();
  const research = new ForumResearchService({
    cache,
    discover: ({ query, sources, queryVariants, maxRequests }) => discoverThreads({ query, sources, queryVariants, maxRequests, fetcher }),
    read: (input) => readThread(input, fetcher),
  });
  const server = new McpServer({ name: "forum-research-mcp", version: "0.2.1" });

  server.registerTool("forum_search", {
    title: "Forum search",
    description: "Find relevant public forum threads. Discovery results are not evidence until read with forum_research or thread_read.",
    inputSchema: {
      query: z.string().trim().min(2).max(500),
      locale: z.enum(["auto", "tr", "en", "both"]).default("auto"),
      depth: z.enum(["quick", "standard", "deep"]).default("standard"),
      query_variants: z.array(z.string().trim().min(2).max(500)).max(12).optional(),
      sources: z.array(z.string().min(1)).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      return textResult(await research.search({ ...input, queryVariants: input.query_variants }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("forum_research", {
    title: "Forum research",
    description: "Build a source-linked, read-only evidence pack from public forum threads.",
    inputSchema: {
      query: z.string().trim().min(2).max(500),
      locale: z.enum(["auto", "tr", "en", "both"]).default("auto"),
      depth: z.enum(["quick", "standard", "deep"]).default("standard"),
      query_variants: z.array(z.string().trim().min(2).max(500)).max(12).optional(),
      sources: z.array(z.string().min(1)).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      return textResult(await research.research({ ...input, queryVariants: input.query_variants }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("thread_read", {
    title: "Read an allowlisted forum thread",
    description: "Read a single public thread from an enabled catalog source; login, blocked and off-catalog URLs are rejected.",
    inputSchema: {
      sourceId: z.string().min(1),
      url: z.string().url(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      return textResult(await readThread(input, fetcher));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("forum_sources", {
    title: "Forum source catalog",
    description: "List enabled and passive catalog sources, their discovery strategy, and any current coverage limitation.",
    inputSchema: {
      locale: z.enum(["tr", "en", "both"]).default("both"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ locale }) => textResult({
    sources: catalog
      .filter((source) => locale === "both" || source.locale === locale)
      .map((source) => ({
        id: source.id,
        locale: source.locale,
        displayName: source.displayName,
        enabled: source.enabled,
        readDomains: source.domains,
        discoveryDomains: source.discoveryDomains ?? source.domains,
        discoveryStrategy: source.discoveryStrategy,
        searchCapability: source.searchCapability,
        domainTags: source.domainTags,
        categories: source.categories,
        rateLimitMs: source.rateLimitMs,
        disabledReason: source.disabledReason,
        policyStatus: source.policyStatus,
        robotsStatus: source.robotsStatus,
        termsStatus: source.termsStatus,
      })),
  }));

  return server;
}
