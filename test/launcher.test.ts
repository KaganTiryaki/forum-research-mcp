import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runtime launcher rebuild check reports the current repository version", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const output = execFileSync(process.execPath, ["bin/serve.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.deepEqual(JSON.parse(output), {
    name: packageJson.name,
    version: packageJson.version,
    build: "current",
  });
});
