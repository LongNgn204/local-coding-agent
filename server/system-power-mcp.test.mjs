// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SHUTDOWN_CONFIRMATION } from "./system-power.mjs";

const SERVER = path.resolve("server.mjs");

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text || "";
  return { isError: Boolean(result.isError), text, json: result.isError ? null : JSON.parse(text) };
}

test("MCP shutdown executes immediately after opt-in and explicit prompt confirmation", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lca-system-power-"));
  const workspace = path.join(scratch, "workspace");
  const approvals = path.join(scratch, "approvals");
  const port = 19120;
  const dashboardPort = 19121;
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "full",
      AGENT_POLICY: "full",
      AGENT_V5_PREVIEW: "1",
      AGENT_ALLOW_SYSTEM_SHUTDOWN: "1",
      // Mandatory test isolation: schedule/cancel return planned results and
      // never spawn shutdown.exe.
      AGENT_SYSTEM_POWER_TEST_MODE: "1",
      AGENT_APPROVALS_DIR: approvals,
      AGENT_EXTRA_ROOTS_JSON: "[]"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();

  let client;
  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
      throw new Error(`${error.message}\n${stderr}`);
    });
    client = new Client({ name: "system-power-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    const registry = await client.listTools();
    for (const name of ["system_power_status", "schedule_system_shutdown", "cancel_system_shutdown"]) {
      assert.ok(registry.tools.some((tool) => tool.name === name), `${name} should be registered`);
    }

    const status = await call(client, "system_power_status");
    assert.equal(status.json.enabled, true);
    assert.equal(status.json.approval_required, false);
    assert.equal(status.json.delay_seconds.default, 0);

    const rawShutdown = await call(client, "run_command", { command: "shutdown /s /t 60" });
    assert.equal(rawShutdown.isError, true);
    assert.match(rawShutdown.text, /catastrophic system operation/i);

    const args = {
      delay_seconds: 0,
      reason: "integration checks completed",
      confirmation: SHUTDOWN_CONFIRMATION
    };
    const scheduled = await call(client, "schedule_system_shutdown", args);
    assert.equal(scheduled.isError, false);
    assert.equal(scheduled.json.scheduled, true);
    assert.equal(scheduled.json.test_mode, true);

    const replay = await call(client, "schedule_system_shutdown", args);
    assert.equal(replay.isError, false);
    assert.equal(replay.json.delay_seconds, 0);

    const cancelled = await call(client, "cancel_system_shutdown");
    assert.equal(cancelled.json.cancelled, true);
    assert.equal(cancelled.json.test_mode, true);
  } finally {
    await client?.close().catch(() => {});
    await stopServer(child);
    await rm(scratch, { recursive: true, force: true });
  }
});
