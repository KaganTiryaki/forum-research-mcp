import assert from "node:assert/strict";
import test from "node:test";

test("MCP surface exposes only the four read-only research tools", async () => {
  const module = await import("../src/server.js").catch(() => ({}));
  const toolNames = (module as { toolNames?: string[] }).toolNames ?? [];

  assert.deepEqual(toolNames, ["forum_research", "forum_search", "thread_read", "forum_sources"]);
});
