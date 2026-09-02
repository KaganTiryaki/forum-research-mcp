import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResearchCache } from "./cache.js";
import { discoverThreads } from "./discovery.js";
import { readThread } from "./reader.js";
import { ForumResearchService } from "./research.js";

export const toolNames = ["forum_research", "forum_search", "thread_read"] as const;

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
    discover: ({ query, sources }) => discoverThreads({ query, sources, fetcher }),
    read: (input) => readThread(input, fetcher),
  });
  const server = new McpServer({ name: "forum-research-mcp", version: "0.1.0" });

  server.registerTool("forum_search", {
    title: "Forum search",
    description: "Find relevant public forum threads. Discovery results are not evidence until read with forum_research or thread_read.",
    inputSchema: {
      query: z.string().trim().min(2).max(500),
      locale: z.enum(["auto", "tr", "en", "both"]).default("auto"),
      sources: z.array(z.string().min(1)).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      return textResult(await research.search(input));
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
      sources: z.array(z.string().min(1)).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    try {
      return textResult(await research.research(input));
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

  return server;
}
