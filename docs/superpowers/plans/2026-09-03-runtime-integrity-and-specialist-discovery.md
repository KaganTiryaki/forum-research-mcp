# Runtime Integrity and Specialist Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent stale compiled MCP servers from producing obsolete research output, and ensure specialist sampled indexes begin while slower generic discovery requests are still running.

**Architecture:** Keep the public MCP surface read-only. Start query-search tasks and bounded sampled-index tasks concurrently while retaining the existing per-source limiter. Add a source-aware Node launcher that compiles silently before handing stdio to `dist/index.js`; this avoids stale ignored build artifacts without sending non-protocol text to MCP stdout.

**Tech Stack:** Node.js 24, TypeScript, MCP SDK, Node child processes, node:test.

**Spec:** User-requested research integrity correction, 2026-09-03.

## Global Constraints

- Only public, allowlisted, read-only forum access remains permitted.
- The launcher must emit no stdout before the MCP child process starts.
- A direct `dist/index.js` configuration is unsupported because `dist/` is intentionally untracked.
- Existing query and sampled-index safety limits remain in force.

---

### Task 1: Start specialist sampled discovery concurrently

**Files:**
- Modify: `src/discovery.ts`
- Test: `test/discovery.test.ts`

- [x] Write a fixture test that holds a direct-search response open and asserts the gCaptain sampled task begins first.
- [x] Run the test and observe the expected failure from serial discovery execution.
- [x] Start query-task and sampled-task promise groups together, then join both before result assembly.
- [x] Re-run the targeted test and TypeScript build.

### Task 2: Make runtime/source mismatch observable and self-healing

**Files:**
- Create: `bin/serve.mjs`
- Modify: `package.json`, `package-lock.json`, `src/server.ts`, `README.md`
- Test: `test/launcher.test.ts`

- [x] Write a launcher integration test for a `--check` invocation that reports the current package version after compilation.
- [x] Run it and observe the expected missing-launcher failure.
- [x] Implement a quiet launcher that resolves the installed TypeScript compiler, builds to `dist`, then inherits stdio only for the MCP child.
- [x] Add runtime version metadata to `forum_sources` and document `bin/serve.mjs` as the required MCP command.
- [x] Re-run the launcher test and verify `node bin/serve.mjs --check` reports `build: current`.

### Task 3: Verify the real maritime regression and publish

**Files:**
- Verify: `test/**/*.test.ts`, `README.md`, `bin/serve.mjs`

- [x] Run the exact 13-variant bilingual maritime request through a clean v0.2.2 checkout; record its direct gCaptain PMS evidence and `partial` status.
- [ ] Run the v0.2.3 full quality gate, stdio smoke test, dependency audit, and GitHub Windows/Ubuntu CI.
- [ ] Publish the verified version and update the local checkout to use the source-aware launcher.
