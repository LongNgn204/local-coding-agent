// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the v5.0.0-preview.2 Local Sub-Agent Manager.
// Runs standalone (no server needed): node --test server/test-agents.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentManager,
  ROLES,
  getRole,
  generateAgentId,
  redactSecrets,
  truncateForChat,
  makeLocalReportPath,
  detectProviders,
  workspaceAgentsDir,
  buildCodexExecArgs,
  buildCodexPrompt,
  codexSandboxForMode,
  isPidAlive,
  AGENT_ID_RE
} from "./agent-manager.mjs";

async function freshManager() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-"));
  const mgr = new AgentManager({ agentsDir: dir, defaultWorkspace: dir, mode: "safe", policy: "balanced" });
  await mgr.init();
  return { mgr, dir };
}

test("generateAgentId is unique and path-safe", () => {
  const a = generateAgentId();
  const b = generateAgentId();
  assert.match(a, AGENT_ID_RE);
  assert.notEqual(a, b);
});

test("redactSecrets removes keys/tokens but keeps normal text", () => {
  const raw = [
    "normal line",
    "OPENAI key sk-proj-ABCDEF1234567890",
    "Authorization: Bearer abc.def.ghijklmnop",
    "CONTROL_PLANE_API_KEY=supersecretvalue123",
    'api_key: "hunter2hunter2hunter2"'
  ].join("\n");
  const out = redactSecrets(raw);
  assert.match(out, /normal line/);
  assert.doesNotMatch(out, /sk-proj-ABCDEF1234567890/);
  assert.doesNotMatch(out, /abc\.def\.ghijklmnop/);
  assert.doesNotMatch(out, /supersecretvalue123/);
  assert.doesNotMatch(out, /hunter2hunter2hunter2/);
});

test("truncateForChat caps long text and flags truncation", () => {
  const under = truncateForChat("short", 100);
  assert.equal(under.truncated, false);
  assert.equal(under.text, "short");
  const over = truncateForChat("x".repeat(500), 100);
  assert.equal(over.truncated, true);
  assert.equal(over.total_chars, 500);
  assert.ok(over.text.length < 500);
  assert.match(over.text, /truncated/);
});

test("getRole validates roles", () => {
  assert.equal(getRole("bug_fix").name, "bug_fix");
  assert.throws(() => getRole("nope_agent"), /Unknown role/);
  assert.equal(Object.keys(ROLES).length, 6);
});

test("makeLocalReportPath rejects bad ids", () => {
  const good = makeLocalReportPath("/tmp/x", "a_0123456789abcdef", "report");
  assert.match(path.basename(good), /^a_0123456789abcdef\.report\.md$/);
  const bad = makeLocalReportPath("/tmp/x", "../../etc/passwd", "log");
  assert.match(path.basename(bad), /^a_invalid\.log$/);
});

test("spawn -> settle produces a done agent with local files", async () => {
  const { mgr } = await freshManager();
  const spawned = await mgr.spawn({ role: "repo_setup", title: "setup check", task: "verify install" });
  assert.match(spawned.agent_id, AGENT_ID_RE);
  assert.ok(["running", "queued"].includes(spawned.status));
  const settled = await mgr.settle(spawned.agent_id);
  assert.equal(settled.status, "done");
  assert.ok(settled.report_path && existsSync(settled.report_path));
  assert.ok(settled.log_path && existsSync(settled.log_path));
});

test("invalid role rejected at spawn", async () => {
  const { mgr } = await freshManager();
  await assert.rejects(() => mgr.spawn({ role: "wizard", title: "x", task: "y" }), /Unknown role/);
});

test("missing task rejected", async () => {
  const { mgr } = await freshManager();
  await assert.rejects(() => mgr.spawn({ role: "docs_update", title: "x", task: "   " }), /task is required/);
});

test("list filters by status and limit", async () => {
  const { mgr } = await freshManager();
  const a = await mgr.spawn({ role: "docs_update", title: "a", task: "t1" });
  const b = await mgr.spawn({ role: "release_prep", title: "b", task: "t2" });
  await mgr.settle(a.agent_id);
  await mgr.settle(b.agent_id);
  const all = mgr.list({ limit: 10 });
  assert.equal(all.length, 2);
  const done = mgr.list({ status: "done" });
  assert.equal(done.length, 2);
  const cancelled = mgr.list({ status: "cancelled" });
  assert.equal(cancelled.length, 0);
});

test("get returns metadata; unknown returns null", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "bug_fix", title: "bug", task: "npe" });
  await mgr.settle(s.agent_id);
  assert.equal(mgr.get(s.agent_id).role, "bug_fix");
  assert.equal(mgr.get("a_0000000000000000"), null);
});

test("result truncates and reads the local report", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "network_check", title: "net", task: "diagnose office network" });
  await mgr.settle(s.agent_id);
  const full = await mgr.result(s.agent_id, 100000);
  assert.equal(full.source, "report");
  assert.equal(full.truncated, false);
  const tiny = await mgr.result(s.agent_id, 50);
  assert.equal(tiny.truncated, true);
  assert.ok(tiny.total_chars > 50);
  await assert.rejects(() => mgr.result("a_0000000000000000"), /No agent/);
});

test("reports redact secrets embedded in the task", async () => {
  const { mgr } = await freshManager();
  const secret = "sk-proj-DEADBEEF1234567890";
  const s = await mgr.spawn({ role: "bug_fix", title: "leak", task: `error mentions key ${secret}` });
  const settled = await mgr.settle(s.agent_id);
  const report = await readFile(settled.report_path, "utf8");
  assert.doesNotMatch(report, /DEADBEEF1234567890/);
  assert.match(report, /sk-proj-<redacted>/);
});

test("cancel right after spawn yields cancelled with no files", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "release_prep", title: "rel", task: "prep release" });
  const res = await mgr.cancel(s.agent_id);
  assert.equal(res.status, "cancelled");
  const meta = mgr.get(s.agent_id);
  assert.equal(meta.status, "cancelled");
  assert.equal(meta.report_path, null);
  // result on a cancelled (no-file) agent must not throw
  const r = await mgr.result(s.agent_id);
  assert.equal(r.source, "none");
  assert.equal(r.content, "");
});

test("cancel on unknown throws; cancel on terminal is idempotent", async () => {
  const { mgr } = await freshManager();
  await assert.rejects(() => mgr.cancel("a_0000000000000000"), /No agent/);
  const s = await mgr.spawn({ role: "docs_update", title: "d", task: "docs" });
  await mgr.settle(s.agent_id);
  const again = await mgr.cancel(s.agent_id);
  assert.equal(again.status, "done");
  assert.match(again.message, /already/);
});

test("readArtifact paginates report and log; handles missing", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "release_prep", title: "big", task: "prep release" });
  await mgr.settle(s.agent_id);
  const p1 = await mgr.readArtifact(s.agent_id, "report", { offset: 0, limit: 3 });
  assert.equal(p1.exists, true);
  assert.equal(p1.kind, "report");
  assert.equal(p1.offset, 0);
  assert.ok(p1.returned_lines <= 3);
  assert.equal(p1.has_more, p1.total_lines > 3);
  const p2 = await mgr.readArtifact(s.agent_id, "report", { offset: 3, limit: 3 });
  assert.equal(p2.offset, 3);
  const logView = await mgr.readArtifact(s.agent_id, "log", { offset: 0, limit: 100 });
  assert.equal(logView.kind, "log");
  assert.equal(logView.exists, true);
  // cancelled agent has no files -> exists false, no throw
  const c = await mgr.spawn({ role: "docs_update", title: "c", task: "x" });
  await mgr.cancel(c.agent_id);
  const none = await mgr.readArtifact(c.agent_id, "report");
  assert.equal(none.exists, false);
  await assert.rejects(() => mgr.readArtifact("a_0000000000000000", "report"), /No agent/);
});

test("dry_run validates without executing", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "safety_review", title: "sec", task: "review", dry_run: true });
  assert.equal(s.status, "done");
  assert.equal(mgr.get(s.agent_id).report_path, null);
  const r = await mgr.result(s.agent_id);
  assert.equal(r.source, "none");
});

test("clean removes old terminal agents", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "docs_update", title: "old", task: "t" });
  await mgr.settle(s.agent_id);
  // Force it to look old.
  mgr.get(s.agent_id);
  mgr.agents.get(s.agent_id).updated_at = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const removed = await mgr.clean({ olderThanMs: 7 * 24 * 3600 * 1000 });
  assert.equal(removed, 1);
  assert.equal(mgr.get(s.agent_id), null);
});

test("detectProviders reports script_runner available", () => {
  const provs = detectProviders({ PATH: "" });
  const script = provs.find((p) => p.name === "script_runner");
  assert.equal(script.available, true);
  assert.ok(provs.some((p) => p.name === "claude_cli"));
  assert.ok(provs.some((p) => p.name === "openai_api"));
});

test("workspaceAgentsDir is deterministic and workspace-scoped", () => {
  const a = workspaceAgentsDir("/data", "/repo/one");
  const b = workspaceAgentsDir("/data", "/repo/one");
  const c = workspaceAgentsDir("/data", "/repo/two");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// preview.4: provider selection, timeout, cancel, codex arg-builder
// ---------------------------------------------------------------------------

/** A fake provider that resolves quickly and tags its report with its name. */
function fakeProvider(name) {
  return {
    name,
    available: () => true,
    async run(meta) {
      await new Promise((r) => setImmediate(r));
      return { ok: true, summary: `${name} ran`, report: `# ${name}\n${meta.task}`, log: `ran by ${name}` };
    }
  };
}

/**
 * A fake provider that waits until aborted (via ctx.signal), recording whether
 * the signal ever fired. Never resolves on its own -> exercises timeout/cancel.
 */
function blockingProvider(name, state) {
  return {
    name,
    available: () => true,
    async run(meta, ctx = {}) {
      state.sawSignal = Boolean(ctx.signal);
      await new Promise((resolve) => {
        const onAbort = () => {
          state.aborted = true;
          resolve();
        };
        if (ctx.signal) {
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      return { ok: false, summary: "stopped", report: "partial", log: "partial log", error: "cancelled" };
    }
  };
}

async function managerWith(providers) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-p-"));
  const mgr = new AgentManager({ agentsDir: dir, defaultWorkspace: dir, mode: "safe", policy: "balanced", providers });
  await mgr.init();
  return { mgr, dir };
}

test("spawn respects the provider param and records it", async () => {
  const { mgr } = await managerWith({ script_runner: fakeProvider("script_runner"), other: fakeProvider("other") });
  const s = await mgr.spawn({ role: "docs_update", title: "t", task: "hello", provider: "other" });
  const settled = await mgr.settle(s.agent_id);
  assert.equal(settled.status, "done");
  assert.equal(settled.provider, "other");
  assert.equal(mgr.get(s.agent_id).provider, "other");
  const report = await readFile(settled.report_path, "utf8");
  assert.match(report, /# other/);
});

test("spawn rejects an unknown provider", async () => {
  const { mgr } = await managerWith({ script_runner: fakeProvider("script_runner") });
  await assert.rejects(
    () => mgr.spawn({ role: "docs_update", title: "t", task: "hello", provider: "nope" }),
    /Unknown provider/
  );
});

test("runtime timeout fails the agent and mentions timeout (via ctx.signal)", async () => {
  const state = {};
  const { mgr } = await managerWith({ script_runner: blockingProvider("script_runner", state) });
  const s = await mgr.spawn({ role: "bug_fix", title: "t", task: "hang", max_runtime_ms: 1000 });
  const settled = await mgr.settle(s.agent_id);
  assert.equal(settled.status, "failed");
  assert.match(settled.error, /timed out/i);
  assert.equal(state.sawSignal, true);
  assert.equal(state.aborted, true);
});

test("cancel aborts a long-running provider and fires ctx.signal", async () => {
  const state = {};
  const { mgr } = await managerWith({ script_runner: blockingProvider("script_runner", state) });
  const s = await mgr.spawn({ role: "bug_fix", title: "t", task: "hang" });
  // Let the provider start and attach its abort listener.
  await new Promise((r) => setTimeout(r, 20));
  const res = await mgr.cancel(s.agent_id);
  assert.equal(res.status, "cancelled");
  assert.equal(mgr.get(s.agent_id).status, "cancelled");
  assert.equal(state.sawSignal, true);
  assert.equal(state.aborted, true);
});

test("codexSandboxForMode maps mode to sandbox policy", () => {
  assert.equal(codexSandboxForMode("safe"), "read-only");
  assert.equal(codexSandboxForMode("full"), "workspace-write");
  assert.equal(codexSandboxForMode(null), "read-only");
});

test("buildCodexExecArgs sets sandbox, cwd, non-interactive flags, stdin prompt", () => {
  const safe = buildCodexExecArgs({ mode: "safe", workspace_root: "/ws" });
  assert.equal(safe[0], "exec");
  const sIdx = safe.indexOf("--sandbox");
  assert.ok(sIdx >= 0);
  assert.equal(safe[sIdx + 1], "read-only");
  const cIdx = safe.indexOf("--cd");
  assert.ok(cIdx >= 0);
  assert.equal(safe[cIdx + 1], "/ws");
  assert.ok(safe.includes("--skip-git-repo-check"));
  // codex exec is already non-interactive: no --ask-for-approval flag exists on it.
  assert.ok(!safe.includes("--ask-for-approval"));
  assert.ok(safe.includes("--color"));
  // prompt is read from stdin, so args end with "-"
  assert.equal(safe[safe.length - 1], "-");

  const full = buildCodexExecArgs({ mode: "full", workspace_root: "/ws" }, { outputFile: "/tmp/last.txt" });
  const fIdx = full.indexOf("--sandbox");
  assert.equal(full[fIdx + 1], "workspace-write");
  const oIdx = full.indexOf("--output-last-message");
  assert.ok(oIdx >= 0);
  assert.equal(full[oIdx + 1], "/tmp/last.txt");
});

test("buildCodexExecArgs passes distinct writable roots through --add-dir", () => {
  const working = path.resolve("/workspace");
  const extraA = path.resolve("/shared-a");
  const extraB = path.resolve("/shared-b");
  const args = buildCodexExecArgs({
    sandbox_mode: "workspace-write",
    workspace_root: working,
    writable_roots: [working, extraA, extraB, extraA]
  });
  const addDirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-dir") addDirs.push(args[i + 1]);
  }
  assert.deepEqual(addDirs, [extraA, extraB]);
  const readOnly = buildCodexExecArgs({
    sandbox_mode: "read-only",
    workspace_root: working,
    writable_roots: [extraA]
  });
  assert.equal(readOnly.includes("--add-dir"), false);
});

test("buildCodexPrompt includes the role and the task", () => {
  const p = buildCodexPrompt({
    role: "docs_update",
    task: "update the readme",
    permission_profile: "mono",
    permission_roots: [{ path: "/workspace", preset: "develop", filesystem: "write", commands: "safe" }]
  });
  assert.match(p, /docs_update/);
  assert.match(p, /update the readme/);
  assert.match(p, /summary/i);
  assert.match(p, /Permission profile: mono/);
  assert.match(p, /preset|develop/i);
});

test("detectProviders marks codex_cli implemented and honors PATH", () => {
  const provs = detectProviders({ PATH: "" });
  const cx = provs.find((p) => p.name === "codex_cli");
  assert.ok(cx);
  assert.equal(cx.available, false); // empty PATH -> not found
  assert.match(cx.note, /implemented/i);
});

// ---------------------------------------------------------------------------
// preview.5: shared-store cross-manager safety + timeout/cancel never hang
// ---------------------------------------------------------------------------

/**
 * A provider that stays "running" until the test signals it, WITHOUT resolving
 * on any child close. It reports whether ctx.signal was seen and, when aborted,
 * resolves only via the controllable `release` so we can assert "still running".
 */
function heldProvider(state) {
  return {
    name: "held",
    available: () => true,
    async run(meta, ctx = {}) {
      state.started = true;
      state.sawSignal = Boolean(ctx.signal);
      await new Promise((resolve) => {
        state.release = () => resolve();
        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => { state.aborted = true; }, { once: true });
        }
      });
      return { ok: true, summary: "released", report: "done", log: "held then released" };
    }
  };
}

/**
 * Simulates the codex grace-race with an UNKILLABLE child: it registers a child
 * pid via ctx.onChild, but its own "child close" NEVER fires. It honors
 * ctx.killGraceMs exactly like the real codex provider, so on abort/timeout it
 * resolves within grace with ok:false and a clear error (even though the child
 * never closed). No real process is spawned.
 */
function unkillableChildProvider(reasonError) {
  return {
    name: "unkillable",
    available: () => true,
    async run(meta, ctx = {}) {
      // Pretend we spawned a child with this pid; it will never actually close.
      ctx.onChild?.({ pid: 424242, exitCode: null, signalCode: null, kill() {} });
      const graceMs = Number.isFinite(ctx.killGraceMs) ? ctx.killGraceMs : 5000;
      await new Promise((resolve) => {
        const onKillRequest = () => {
          // Start the grace fallback; the "child close" never comes, so this is
          // the only thing that resolves the run -> no hang.
          setTimeout(resolve, graceMs).unref?.();
        };
        if (ctx.signal) {
          if (ctx.signal.aborted) onKillRequest();
          else ctx.signal.addEventListener("abort", onKillRequest, { once: true });
        }
      });
      return {
        ok: false,
        summary: reasonError,
        report: "partial",
        log: "partial log (child never closed)",
        error: `${reasonError} (child pid 424242 may still be running; kill it manually)`
      };
    }
  };
}

test("isPidAlive: own pid alive, impossible pid dead, bad input dead", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive("nope"), false);
});

test("cross-manager: manager B init() does not clobber A's live running task", async () => {
  const state = {};
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-shared-"));
  const mgrA = new AgentManager({
    agentsDir: dir,
    defaultWorkspace: dir,
    mode: "safe",
    providers: { script_runner: heldProvider(state) }
  });
  await mgrA.init();
  const s = await mgrA.spawn({ role: "bug_fix", title: "held", task: "stay running" });
  // Let the provider start.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mgrA.get(s.agent_id).status, "running");
  assert.equal(mgrA.get(s.agent_id).owner_pid, process.pid);
  assert.equal(state.started, true);

  // A SECOND live manager inits over the SAME store. The owning pid (this
  // process) is alive, so it must leave A's running task untouched.
  const mgrB = new AgentManager({
    agentsDir: dir,
    defaultWorkspace: dir,
    mode: "safe",
    providers: { script_runner: heldProvider({}) }
  });
  await mgrB.init();
  assert.equal(mgrB.get(s.agent_id).status, "running", "B must not clobber A's live task");

  // Release A's task so it completes cleanly and the test does not leak a timer.
  state.release();
  const settled = await mgrA.settle(s.agent_id);
  assert.equal(settled.status, "done");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("cross-manager: a dead owner_pid IS marked interrupted on init", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-dead-"));
  // Write an index with a running task owned by a definitely-dead pid.
  const now = new Date().toISOString();
  const rec = {
    agent_id: "a_00000000deadbeef",
    role: "bug_fix",
    title: "orphan",
    task: "was running under a dead owner",
    provider: "script_runner",
    status: "running",
    owner_pid: 999999,
    child_pid: null,
    created_at: now,
    updated_at: now
  };
  await writeFile(path.join(dir, "index.json"), `${JSON.stringify([rec], null, 2)}\n`, "utf8");
  const fresh = new AgentManager({ agentsDir: dir, defaultWorkspace: dir, mode: "safe" });
  await fresh.init();
  const meta = fresh.get("a_00000000deadbeef");
  assert.equal(meta.status, "failed");
  assert.match(meta.error, /interrupted/i);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("timeout-no-hang: unkillable child still settles to failed within grace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-nohang-"));
  const mgr = new AgentManager({
    agentsDir: dir,
    defaultWorkspace: dir,
    mode: "safe",
    killGraceMs: 40, // tiny grace so the test is fast, not the real 5000ms
    providers: { script_runner: unkillableChildProvider("timed out after 50ms") }
  });
  await mgr.init();
  const started = Date.now();
  const s = await mgr.spawn({ role: "bug_fix", title: "t", task: "hang", max_runtime_ms: 50 });
  const settled = await mgr.settle(s.agent_id); // MUST return (no hang)
  assert.equal(settled.status, "failed");
  assert.match(settled.error, /timed out/i);
  assert.ok(Date.now() - started < 3000, "settle returned quickly, no unbounded wait");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("cancel-no-hang: unkillable child settles to cancelled within grace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-agents-nohang-c-"));
  const mgr = new AgentManager({
    agentsDir: dir,
    defaultWorkspace: dir,
    mode: "safe",
    killGraceMs: 40,
    providers: { script_runner: unkillableChildProvider("cancelled") }
  });
  await mgr.init();
  const s = await mgr.spawn({ role: "bug_fix", title: "t", task: "hang" });
  await new Promise((r) => setTimeout(r, 20)); // let the provider attach its abort listener
  const started = Date.now();
  const res = await mgr.cancel(s.agent_id); // MUST return (no hang)
  assert.equal(res.status, "cancelled");
  assert.equal(mgr.get(s.agent_id).status, "cancelled");
  assert.ok(Date.now() - started < 3000, "cancel returned quickly, no unbounded wait");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test.after(async () => {
  // best-effort temp cleanup handled by OS; nothing persistent to remove here.
});
