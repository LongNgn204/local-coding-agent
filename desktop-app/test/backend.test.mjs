// Local Codex Studio — backend integration test.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the entire main-process wiring WITHOUT launching Electron and WITHOUT
// spending any Codex quota (engine = script_runner). It spawns THIS repo's
// server as a child on a temp workspace + free ports, connects the MCP client,
// runs a task end to end, exercises the cancel path, then asserts the server
// child is gone after stop().
//
// Run: node --test desktop-app/test/backend.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioBackend, findFreePort } from "../main/backend.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A process is "alive" if signalling 0 does not throw ESRCH.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not signallable
  }
}

test("StudioBackend end-to-end wiring (script_runner, no codex quota)", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-studio-ws-"));
  const port = await findFreePort();
  const dashboardPort = await findFreePort();
  const logs = [];

  const backend = new StudioBackend({
    workspace,
    mode: "safe",
    port,
    dashboardPort,
    healthTimeoutMs: 20000,
    onLog: (l) => logs.push(l)
  });

  let serverPid = null;

  t.after(async () => {
    await backend.stop().catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  await t.test("start() brings server up and MCP client connects", async () => {
    const h = await backend.start();
    assert.equal(h.ok, true, `health not ok: ${JSON.stringify(h)}`);
    assert.ok(h.preview_version, "preview_version should be present (AGENT_V5_PREVIEW=1)");
    assert.equal(h.preview_enabled, true, "preview must be enabled");
    assert.equal(h.mode, "safe");
    assert.equal(backend.running, true);
    serverPid = h.pid;
    assert.ok(serverPid && pidAlive(serverPid), "server child pid should be alive");
  });

  await t.test("health() reports the running server", async () => {
    const h = await backend.health();
    assert.equal(h.ok, true);
    assert.equal(String(h.port), String(port));
  });

  let taskId = null;
  await t.test("createTask(script_runner) then poll to completion", async () => {
    const created = await backend.createTask({
      role: "docs_update",
      task: "Reply OK",
      engine: "script_runner",
      title: "smoke docs"
    });
    assert.ok(created.task_id, "should return a task_id");
    assert.notEqual(created.status, "failed");
    taskId = created.task_id;

    // Poll getTask until it leaves queued/running.
    let detail = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      detail = await backend.getTask(taskId);
      if (detail.status !== "queued" && detail.status !== "running") break;
      await sleep(300);
    }
    assert.ok(detail, "should have a detail");
    assert.equal(detail.status, "done", `expected done, got ${detail.status} (${detail.error || ""})`);
    assert.equal(detail.provider, "script_runner", "must have used script_runner (no codex quota)");
  });

  await t.test("listTasks includes the task", async () => {
    const list = await backend.listTasks({});
    assert.ok(list.count >= 1, "at least one task");
    assert.ok(list.tasks.some((x) => x.agent_id === taskId), "list should include our task");
  });

  await t.test("getArtifact returns the paginated report", async () => {
    const art = await backend.getArtifact(taskId, "report", 0, 200);
    assert.ok(art.view, "artifact view present");
    assert.equal(art.view.kind, "report");
    assert.equal(art.view.exists, true, "report file should exist");
    assert.ok(art.view.total_lines > 0, "report should have content");
    assert.equal(typeof art.view.content, "string");
  });

  await t.test("cancelTask path on a fresh task", async () => {
    const fresh = await backend.createTask({
      role: "bug_fix",
      task: "This task will be cancelled",
      engine: "script_runner",
      title: "cancel target"
    });
    assert.ok(fresh.task_id);
    const res = await backend.cancelTask(fresh.task_id);
    assert.ok(res.task_id, "cancel returns the id");
    // After cancel it is either cancelled, or already finished (fast planner);
    // both are valid terminal outcomes for the cancel path.
    assert.ok(
      ["cancelled", "done", "failed"].includes(res.status),
      `unexpected status after cancel: ${res.status}`
    );
  });

  await t.test("stop() tears down the MCP client and kills the server child", async () => {
    assert.ok(serverPid, "need a server pid to verify");
    await backend.stop();
    assert.equal(backend.running, false, "backend should report not running");
    // Give taskkill a moment to fully reap on Windows.
    for (let i = 0; i < 20 && pidAlive(serverPid); i++) await sleep(200);
    assert.equal(pidAlive(serverPid), false, `server child pid ${serverPid} should be gone after stop()`);
  });
});
