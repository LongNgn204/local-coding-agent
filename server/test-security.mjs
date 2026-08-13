// Local Coding Agent security regression tests
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.TEST_ENDPOINT;
if (!ENDPOINT) throw new Error("Refusing destructive security test without explicit TEST_ENDPOINT.");
const client = new Client({ name: "agent-security-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

let pass = 0;
let fail = 0;

function ok(condition, name, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { result, text };
}

const info = JSON.parse((await call("workspace_info", {})).text);
const root = info.primary_root;

function assertIsolatedTestWorkspace(workspace) {
  const tempRoot = realpathSync.native(os.tmpdir());
  const workspaceRoot = realpathSync.native(workspace);
  const relative = path.relative(tempRoot, workspaceRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing destructive security test outside the system temp directory: ${workspaceRoot}`);
  }
}

assertIsolatedTestWorkspace(root);

// Default macOS volumes are commonly case-insensitive. A differently-cased
// absolute path to the same root must remain inside the root after canonicalization.
if (process.platform === "darwin") {
  const variant = root.replace(/[A-Za-z]/, (ch) => ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
  if (variant !== root && existsSync(variant)) {
    const caseVariant = await call("stat_path", { path: variant });
    ok(!caseVariant.result.isError, "case-insensitive macOS root path is accepted", caseVariant.text);
  }
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// 1) Symlink/junction escape must be blocked.
const outside = path.join(os.tmpdir(), `lca-security-outside-${Date.now()}`);
await rm(outside, { recursive: true, force: true });
await mkdir(outside, { recursive: true });
await writeFile(path.join(outside, "secret.txt"), "outside-secret\n", "utf8");
const linkPath = path.join(root, "escape-link");
try {
  await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
} catch (err) {
  console.log(`[SKIP] symlink/junction setup failed: ${err?.message || err}`);
}
if (existsSync(linkPath)) {
  const escaped = await call("read_file", { path: "escape-link/secret.txt" });
  ok(Boolean(escaped.result.isError), "symlink/junction escape is blocked", escaped.text);
}

// 2) Non-git helper behavior should be structured and compact.
const nongit = path.join(root, "nongit");
await mkdir(nongit, { recursive: true });
const status = JSON.parse((await call("git_status", { cwd: "nongit" })).text);
ok(status.is_git_repo === false && status.clean === null, "git_status reports non-git repo correctly", JSON.stringify(status));
const diff = JSON.parse((await call("git_diff", { cwd: "nongit" })).text);
ok(diff.is_git_repo === false && typeof diff.error === "string" && diff.error.length < 200, "git_diff reports non-git repo compactly", JSON.stringify(diff).slice(0, 500));

// 3) Raw git must not allow read-only subcommands to write outside the root.
spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
spawnSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore" });
spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
await writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
const outsideDiff = path.join(path.dirname(root), "outside.diff");
await rm(outsideDiff, { force: true });
const gitOutput = await call("git", { args: ["diff", `--output=${outsideDiff}`] });
ok(Boolean(gitOutput.result.isError), "git --output is blocked in safe mode", gitOutput.text);
ok(!existsSync(outsideDiff), "git --output did not create file outside root");

const restore = await call("git", { args: ["restore", "."] });
ok(Boolean(restore.result.isError), "git restore is blocked in safe mode", restore.text);

// 4) Nested audit payloads must be redacted.
const secret = `LCA_AUDIT_SECRET_${Date.now()}`;
await call("apply_patch", {
  operations: [{ op: "create", path: "audit-secret.txt", content: secret }]
});
const audit = await readFile(path.resolve("data", "audit.log"), "utf8").catch(() => "");
ok(!audit.includes(secret), "audit log redacts nested apply_patch content");

await client.close();
console.log(`\n==== SECURITY RESULT: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
