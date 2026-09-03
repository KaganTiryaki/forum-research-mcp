#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const compiler = require.resolve("typescript/lib/tsc.js");
const build = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (build.error || build.status !== 0) {
  process.stderr.write(build.stderr || build.error?.message || "Forum Research MCP build failed.\n");
  process.exit(build.status ?? 1);
}

if (process.argv[2] === "--check") {
  process.stdout.write(`${JSON.stringify({ name: packageJson.name, version: packageJson.version, build: "current" })}\n`);
  process.exit(0);
}

const server = spawn(process.execPath, [resolve(root, "dist", "index.js"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

server.once("error", (error) => {
  process.stderr.write(`Forum Research MCP could not start: ${error.message}\n`);
  process.exit(1);
});
server.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
