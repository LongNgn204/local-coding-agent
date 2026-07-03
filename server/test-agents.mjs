// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the v5.0.0-preview.2 Local Sub-Agent Manager.
// Runs standalone (no server needed): node --test server/test-agents.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  assert.equal(getRole("bug_fix_agent").name, "bug_fix_agent");
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
  const spawned = await mgr.spawn({ role: "repo_setup_agent", title: "setup check", task: "verify install" });
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
  await assert.rejects(() => mgr.spawn({ role: "readme_agent", title: "x", task: "   " }), /task is required/);
});

test("list filters by status and limit", async () => {
  const { mgr } = await freshManager();
  const a = await mgr.spawn({ role: "readme_agent", title: "a", task: "t1" });
  const b = await mgr.spawn({ role: "release_agent", title: "b", task: "t2" });
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
  const s = await mgr.spawn({ role: "bug_fix_agent", title: "bug", task: "npe" });
  await mgr.settle(s.agent_id);
  assert.equal(mgr.get(s.agent_id).role, "bug_fix_agent");
  assert.equal(mgr.get("a_0000000000000000"), null);
});

test("result truncates and reads the local report", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "network_doctor_agent", title: "net", task: "diagnose office network" });
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
  const s = await mgr.spawn({ role: "bug_fix_agent", title: "leak", task: `error mentions key ${secret}` });
  const settled = await mgr.settle(s.agent_id);
  const report = await readFile(settled.report_path, "utf8");
  assert.doesNotMatch(report, /DEADBEEF1234567890/);
  assert.match(report, /sk-proj-<redacted>/);
});

test("cancel right after spawn yields cancelled with no files", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "release_agent", title: "rel", task: "prep release" });
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
  const s = await mgr.spawn({ role: "readme_agent", title: "d", task: "docs" });
  await mgr.settle(s.agent_id);
  const again = await mgr.cancel(s.agent_id);
  assert.equal(again.status, "done");
  assert.match(again.message, /already/);
});

test("readArtifact paginates report and log; handles missing", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "release_agent", title: "big", task: "prep release" });
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
  const c = await mgr.spawn({ role: "readme_agent", title: "c", task: "x" });
  await mgr.cancel(c.agent_id);
  const none = await mgr.readArtifact(c.agent_id, "report");
  assert.equal(none.exists, false);
  await assert.rejects(() => mgr.readArtifact("a_0000000000000000", "report"), /No agent/);
});

test("dry_run validates without executing", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "security_review_agent", title: "sec", task: "review", dry_run: true });
  assert.equal(s.status, "done");
  assert.equal(mgr.get(s.agent_id).report_path, null);
  const r = await mgr.result(s.agent_id);
  assert.equal(r.source, "none");
});

test("clean removes old terminal agents", async () => {
  const { mgr } = await freshManager();
  const s = await mgr.spawn({ role: "readme_agent", title: "old", task: "t" });
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

test.after(async () => {
  // best-effort temp cleanup handled by OS; nothing persistent to remove here.
});
