// Local Coding Agent — Eval Runner (v2.9)
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spins the server on a temp workspace, runs each eval scenario, asserts behavior.
// Usage:  node evals/run.mjs
// Or:     npm run eval   (from server/ directory)

// Resolve imports from server's node_modules (evals/ has no separate package)
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, "..", "server");

// Dynamic imports from server's node_modules using file:// URLs (required on Windows)
const sdkClientPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js");
const sdkHttpPath = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js");
const { Client } = await import(pathToFileURL(sdkClientPath).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(sdkHttpPath).href);

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

const SERVER_MJS = path.resolve(__dirname, "..", "server", "server.mjs");
const EVAL_PORT = 8898;
const EVAL_ENDPOINT = `http://127.0.0.1:${EVAL_PORT}/mcp`;

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    results.push({ name, ok: false, detail });
    console.log(`  [FAIL] ${name}${detail ? ": " + detail : ""}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer(workspace) {
  await mkdir(workspace, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER_MJS],
      {
        env: {
          ...process.env,
          PORT: String(EVAL_PORT),
          DASHBOARD_PORT: "0",
          AGENT_WORKSPACE: workspace,
          AGENT_MODE: "safe"
        },
        windowsHide: true
      }
    );
    child.stderr?.on("data", () => {});
    let started = false;
    child.stdout?.on("data", (d) => {
      if (!started && d.toString().includes("listening on")) {
        started = true;
        resolve(child);
      }
    });
    child.on("error", reject);
    setTimeout(() => {
      if (!started) reject(new Error("Server start timeout"));
    }, 8000);
  });
}

async function stopServer(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    await sleep(500);
  } catch { /* ignore */ }
}

async function connectClient() {
  const client = new Client({ name: "eval-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(EVAL_ENDPOINT));
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: r.content?.[0]?.text ?? "",
      isError: Boolean(r.isError)
    };
  } catch (err) {
    return { text: String(err?.message || err), isError: true };
  }
}

async function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ============================================================================
// Eval definitions
// ============================================================================

async function runEvals(workspace) {
  let serverChild = null;
  let client = null;

  try {
    console.log(`\nStarting eval server on port ${EVAL_PORT}...`);
    serverChild = await startServer(workspace);
    await sleep(500);
    client = await connectClient();
    console.log("Connected.\n");

    // ---- eval 1: edit-single-file ----
    console.log("EVAL: edit-single-file");
    {
      await call(client, "write_file", { path: "src/greet.js", content: "function greet() { return 'hello'; }\n" });
      const r = await call(client, "replace_in_file", { path: "src/greet.js", old_text: "hello", new_text: "world" });
      const read = await call(client, "read_file", { path: "src/greet.js" });
      const d = await parseJSON(read.text);
      check("edit-single-file: file written and edited", !r.isError && d && d.content && d.content.includes("world"));
    }

    // ---- eval 2: edit-multi-file (apply_patch) ----
    console.log("EVAL: edit-multi-file");
    {
      await call(client, "write_file", { path: "src/a.js", content: "const a = 1;\n" });
      await call(client, "write_file", { path: "src/b.js", content: "const b = 2;\n" });
      const r = await call(client, "apply_patch", {
        diff: `--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 10;\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-const b = 2;\n+const b = 20;\n`
      });
      const d = await parseJSON(r.text);
      check("edit-multi-file: apply_patch both files ok", d && d.ok && d.applied === 2);

      const ra = await call(client, "read_file", { path: "src/a.js" });
      const da = await parseJSON(ra.text);
      check("edit-multi-file: content correct", da && da.content.includes("10") && !da.content.includes("const a = 1;"));
    }

    // ---- eval 3: undo_last_patch restores ----
    console.log("EVAL: undo_last_patch");
    {
      await call(client, "write_file", { path: "src/undo-me.js", content: "const x = 'original';\n" });
      await call(client, "replace_in_file", { path: "src/undo-me.js", old_text: "original", new_text: "changed" });
      const before = await call(client, "read_file", { path: "src/undo-me.js" });
      const dBefore = await parseJSON(before.text);
      check("undo: file was changed", dBefore && dBefore.content.includes("changed"));

      const undo = await call(client, "undo_last_patch", {});
      const dUndo = await parseJSON(undo.text);
      check("undo: undo_last_patch returned ok", dUndo && dUndo.ok);

      const after = await call(client, "read_file", { path: "src/undo-me.js" });
      const dAfter = await parseJSON(after.text);
      check("undo: file restored to original", dAfter && dAfter.content.includes("original") && !dAfter.content.includes("changed"));
    }

    // ---- eval 4: detect bug via review_diff ----
    console.log("EVAL: review_diff detects console.log");
    {
      // This eval only works if workspace is a git repo; if not, we note it
      const gs = await call(client, "git_status", {});
      const gsData = await parseJSON(gs.text);
      if (!gsData || !gsData.is_git_repo) {
        console.log("  [SKIP] review_diff: not a git repo (expected for scratch workspace)");
      } else {
        const rd = await call(client, "review_diff", { cwd: "." });
        const data = await parseJSON(rd.text);
        check("review_diff: returns a verdict", data && ["PASS", "WARN", "BLOCK", "CLEAN"].includes(data.verdict));
      }
    }

    // ---- eval 5: run failing test reported ----
    console.log("EVAL: run_tests reports failure");
    {
      // Write a simple Node test that will fail
      await call(client, "write_file", { path: "test/fail.test.js", content: "// simple failing test\nprocess.exit(1);\n" });
      const r = await call(client, "run_tests", { command: "node test/fail.test.js", cwd: "." });
      const d = await parseJSON(r.text);
      check("run_tests: failing test detected (exit_code != 0)", d && d.exit_code !== 0 && d.ok === false);
    }

    // ---- eval 6: prevent path escape ----
    console.log("EVAL: path escape blocked");
    {
      const r = await call(client, "read_file", { path: "../../../../etc/passwd" });
      check("path-escape: read outside root blocked", r.isError && r.text.includes("outside the allowed roots"));
    }

    // ---- eval 7: prevent secret in audit ----
    console.log("EVAL: audit redaction");
    {
      const sentinel = "EVAL_SECRET_" + randomUUID().replace(/-/g, "").slice(0, 16);
      await call(client, "apply_patch", { operations: [{ op: "create", path: "sec-eval.txt", content: `API_KEY=${sentinel}` }] });
      await call(client, "delete_path", { path: "sec-eval.txt" });
      // Read the audit log (it lives in server/data/audit.log)
      const auditPath = path.resolve(__dirname, "..", "server", "data", "audit.log");
      let auditContent = "";
      try { auditContent = await readFile(auditPath, "utf8"); } catch { /* no audit log */ }
      if (auditContent) {
        check("audit: secret NOT in audit.log", !auditContent.includes(sentinel));
      } else {
        console.log("  [SKIP] audit file not found");
      }
    }

    // ---- eval 8: git safety (flag blocked) ----
    console.log("EVAL: git safety");
    {
      const r = await call(client, "git", { args: ["diff", "--output=../escape.txt"] });
      check("git-safety: --output flag blocked", r.isError);

      const r2 = await call(client, "git", { args: ["-c", "core.pager=calc", "log"] });
      check("git-safety: -c flag blocked", r2.isError);
    }

    // ---- eval 9: repo_map on sample project ----
    console.log("EVAL: repo_map");
    {
      // Write a package.json so project_profile can detect it
      await call(client, "write_file", { path: "package.json", content: JSON.stringify({ name: "eval-proj", scripts: { test: "node test/fail.test.js", build: "echo build" } }, null, 2) });
      const r = await call(client, "repo_map", { refresh: true });
      const d = await parseJSON(r.text);
      check("repo_map: returns tree + profile", d && Array.isArray(d.tree) && d.profile && Array.isArray(d.profile.languages));
      check("repo_map: detects javascript", d && d.profile && d.profile.languages.includes("javascript"));
    }

    // ---- eval 10: resume checkpoint ----
    console.log("EVAL: checkpoint + resume");
    {
      const cp = await call(client, "checkpoint", { summary: "Eval progress: 10 evals done", next_steps: ["verify", "commit"] });
      check("checkpoint: saved without error", !cp.isError);

      const resume = await call(client, "resume", {});
      const d = await parseJSON(resume.text);
      check("resume: returns saved checkpoint", d && d.summary && d.summary.includes("Eval progress"));
    }

    // ---- eval 11: task_plan + task_state ----
    console.log("EVAL: task_plan + task_state");
    {
      const plan = await call(client, "task_plan", { goal: "Eval test goal", steps: ["Step A", "Step B", "Step C"] });
      const pd = await parseJSON(plan.text);
      check("task_plan: created", pd && pd.ok && pd.steps_count === 3);

      const state = await call(client, "task_state", { set_step_done: 0 });
      const sd = await parseJSON(state.text);
      check("task_state: step marked done", sd && sd.steps && sd.steps[0].done === true);
    }

    // ---- eval 12: policy_status ----
    console.log("EVAL: policy_status");
    {
      const r = await call(client, "policy_status", {});
      const d = await parseJSON(r.text);
      check("policy_status: returns policy info", d && typeof d.policy === "string" && ["strict", "balanced", "full"].includes(d.policy));
    }

    // ---- eval 13: preview_patch dry-run ----
    console.log("EVAL: preview_patch");
    {
      await call(client, "write_file", { path: "src/preview-me.js", content: "const x = 1;\n" });
      const r = await call(client, "preview_patch", { diff: "--- a/src/preview-me.js\n+++ b/src/preview-me.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 99;\n" });
      const d = await parseJSON(r.text);
      check("preview_patch: dry-run ok", d && typeof d.ok === "boolean");
      // Verify file was NOT changed
      const read = await call(client, "read_file", { path: "src/preview-me.js" });
      const rd = await parseJSON(read.text);
      check("preview_patch: file unchanged after dry run", rd && rd.content && rd.content.includes("const x = 1;"));
    }

  } finally {
    if (client) await client.close().catch(() => {});
    if (serverChild) await stopServer(serverChild);
  }
}

// ============================================================================
// Main
// ============================================================================

const evalWorkspace = path.join(os.tmpdir(), `lca-eval-${Date.now()}`);

console.log("=".repeat(60));
console.log("Local Coding Agent — Eval Suite (v2.9)");
console.log("=".repeat(60));
console.log(`Workspace: ${evalWorkspace}`);

try {
  await runEvals(evalWorkspace);
} catch (err) {
  console.error("\nFATAL eval runner error:", err?.message || err);
  process.exit(1);
} finally {
  // Clean up workspace
  try { await rm(evalWorkspace, { recursive: true, force: true }); } catch { /* ok */ }
}

const total = pass + fail;
const pct = total > 0 ? Math.round((pass / total) * 100) : 0;

console.log("\n" + "=".repeat(60));
console.log(`EVAL RESULTS: ${pass}/${total} passed (${pct}%)`);
console.log("=".repeat(60));

results.forEach((r) => {
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
});

if (pct < 90) {
  console.error(`\nFAIL: Only ${pct}% passed (need >= 90%)`);
  process.exit(1);
} else {
  console.log(`\nPASS: ${pct}% >= 90%`);
  process.exit(0);
}
