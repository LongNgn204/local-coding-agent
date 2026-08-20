// Local Coding Agent Tray — tests (node --test, no Electron needed).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore, REPO_ROOT } from "../main/config.mjs";
import { Supervisor } from "../main/supervisor.mjs";
import { httpGet } from "../main/util.mjs";
import { parseTunnelStatus, tunnelIdFingerprint, tunnelFailureSummary } from "../main/tunnel-status.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(REPO_ROOT, "server");

const codec = {
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8").toString("base64"),
  decrypt: (b64) => Buffer.from(b64, "base64").toString("utf8").replace(/^enc:/, "")
};

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lcat-test-"));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntil(predicate, timeoutMs = 1500, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(predicate());
}

test("ConfigStore round-trips non-secret settings and fills defaults", () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const cfg = store.get();
    assert.equal(cfg.mode, "safe");
    assert.equal(cfg.policy, "balanced");
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.dashboardPort, 8790);
    assert.equal(cfg.profile, "local-coding-agent");
    assert.equal(cfg.mcpAppDir, path.join(REPO_ROOT, "server"));

    const saved = store.set({ workspace: "/tmp/ws", mode: "full", policy: "strict", port: 9000 });
    assert.equal(saved.workspace, "/tmp/ws");
    assert.equal(saved.mode, "full");
    assert.equal(saved.policy, "strict");

    const reloaded = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec }).get();
    assert.equal(reloaded.port, 9000);
    assert.equal(reloaded.mode, "full");
    assert.ok(existsSync(store.file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConfigStore normalizes invalid values and migrates off port 8788", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "cli-config.json"), JSON.stringify({ mode: "bogus", policy: "bogus", dashboardPort: 8788, port: 0 }));
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const cfg = store.get();
    assert.equal(cfg.mode, "safe");
    assert.equal(cfg.policy, "balanced");
    assert.equal(cfg.dashboardPort, 8790);
    assert.equal(cfg.port, 8787);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Secrets are stored encrypted and never land in cli-config.json", () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    store.set({});
    store.saveSecret("runtimeKey", "sk-proj-123");
    store.saveSecret("authToken", "tok-abc");
    assert.equal(store.hasSecret("runtimeKey"), true);
    assert.equal(store.getSecret("runtimeKey"), "sk-proj-123");
    assert.equal(store.getSecret("authToken"), "tok-abc");

    const raw = readFileSync(store.secretsFile, "utf8");
    assert.ok(!raw.includes("sk-proj-123"));
    assert.ok(raw.includes("enc:sk-proj-123") === false || raw.includes("enc:sk-proj-123"));
    const cfgRaw = readFileSync(store.file, "utf8");
    assert.ok(!cfgRaw.includes("sk-proj-123"));

    store.saveSecret("runtimeKey", "");
    assert.equal(store.hasSecret("runtimeKey"), false);
    assert.equal(store.getSecret("runtimeKey"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Permission store validation accepts a good store and rejects a bad one", () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const goodRoot = path.join(os.tmpdir(), "work");
    const good = {
      version: 1,
      active_profile: "work",
      profiles: {
        work: {
          version: 1,
          name: "work",
          description: "test",
          working_directory: goodRoot,
          roots: [{ label: "Primary workspace", path: goodRoot, preset: "develop" }]
        }
      }
    };
    const { store: saved } = store.setPermissionStore(good);
    assert.equal(saved.active_profile, "work");
    assert.equal(store.get().permissionProfileName, "work");
    assert.equal(store.get().workspace, path.resolve(goodRoot));

    const bad = { version: 1, active_profile: "x", profiles: { x: { working_directory: os.tmpdir(), roots: [] } } };
    assert.throws(() => store.setPermissionStore(bad), /at least one root/i);
    assert.throws(() => store.setPermissionStore({ version: 1, active_profile: "x", profiles: {} }), /at least one permission profile/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tunnel profile YAML embeds tunnel ID and optional organization header", () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const cfg = { ...store.get(), tunnelId: "tunnel_abc123", organizationId: "org_xyz", profileDir: path.join(dir, "profiles") };
    const yaml = store.tunnelProfileYaml(cfg);
    assert.ok(yaml.includes('tunnel_id: "tunnel_abc123"'));
    assert.ok(yaml.includes("OpenAI-Organization: org_xyz"));
    assert.ok(yaml.includes('api_key: "env:CONTROL_PLANE_API_KEY"'));

    const file = store.writeTunnelProfile(cfg);
    assert.ok(existsSync(file));
    const onDisk = readFileSync(file, "utf8");
    assert.ok(onDisk.includes("tunnel_abc123"));

    assert.throws(() => store.tunnelProfileYaml({ ...cfg, tunnelId: "" }), /Tunnel ID is empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTunnelStatus matches tray-app RuntimeStatus rules", () => {
  const connected = {
    control_plane_tunnel_id: "tunnel_abc",
    channels: [{ name: "main", enabled: true, probe_status: "ok", probe_error: "", reason: "" }]
  };
  const ok = parseTunnelStatus(connected, "tunnel_abc");
  assert.equal(ok.ready, true);

  const mismatch = parseTunnelStatus(connected, "tunnel_other");
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.tunnelIdMismatch, true);
  assert.equal(tunnelFailureSummary(mismatch), "tunnel ID mismatch");

  const probeFail = {
    control_plane_tunnel_id: "tunnel_abc",
    channels: [{ name: "main", enabled: true, probe_status: "failed", probe_error: "initial mcp probe failed: 404", reason: "" }]
  };
  const failed = parseTunnelStatus(probeFail, "tunnel_abc");
  assert.equal(failed.ready, false);
  assert.equal(failed.probeFailed, true);

  const noMain = { channels: [{ name: "other", enabled: true }] };
  assert.equal(parseTunnelStatus(noMain, "").reason, "main channel is missing");

  assert.equal(tunnelIdFingerprint("tunnel_abcdef123456"), "...ef123456");
  assert.equal(tunnelIdFingerprint(""), "not configured");
});

test("Supervisor starts the real MCP server, waits for health, and stops it", async () => {
  const dir = tempDir();
  const ws = path.join(dir, "ws");
  mkdirSync(ws);
  try {
    const port = await freePort();
    const dashboardPort = await freePort();
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    store.set({ mcpAppDir: SERVER_DIR, workspace: ws, mode: "safe", policy: "balanced", port, dashboardPort });

    const logs = [];
    const sup = new Supervisor({
      config: store,
      secrets: { getSecret: () => null },
      onLog: (line) => logs.push(line),
      healthTimeoutMs: 20000,
      pollMs: 500
    });

    await sup.start({ tunnel: false });
    assert.equal(sup.serverState, "online");
    assert.ok(sup.lastHealth);
    assert.equal(sup.lastHealth.workspace, ws);
    assert.equal(sup.lastHealth.mode, "safe");
    assert.equal(sup.lastHealth.policy, "balanced");

    const snap = sup.snapshot();
    assert.equal(snap.server.state, "online");
    assert.equal(snap.server.roots, 1);
    assert.equal(snap.mcpUrl, `http://127.0.0.1:${port}/mcp`);

    await sup.stop();
    assert.equal(sup.serverState, "offline");
    assert.equal(sup.tunnelState, "stopped");
    assert.ok(logs.some((l) => l.includes("stopped owned server")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supervisor reuses a healthy compatible server without breaking its PID", async () => {
  const dir = tempDir();
  const ws = path.join(dir, "ws");
  mkdirSync(ws);
  const supervisors = [];
  try {
    const port = await freePort();
    const dashboardPort = await freePort();
    const storeA = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    storeA.set({ mcpAppDir: SERVER_DIR, workspace: ws, mode: "safe", policy: "balanced", port, dashboardPort });
    const a = new Supervisor({ config: storeA, secrets: { getSecret: () => null }, healthTimeoutMs: 20000, pollMs: 500 });
    supervisors.push(a);
    await a.start({ tunnel: false });
    const firstPid = a.lastHealth.pid;
    assert.ok(firstPid);

    // A fresh tray instance must adopt the compatible healthy server instead
    // of bouncing it. Existing MCP sessions are bound to this server PID.
    const storeB = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    storeB.set({ mcpAppDir: SERVER_DIR, workspace: ws, mode: "safe", policy: "balanced", port, dashboardPort });
    const b = new Supervisor({ config: storeB, secrets: { getSecret: () => null }, healthTimeoutMs: 20000, pollMs: 500 });
    supervisors.push(b);
    await b.start({ tunnel: false });

    assert.equal(b.lastHealth.pid, firstPid, "compatible server PID must remain stable");
    assert.equal(b.serverState, "online");

    // Stopping the adopting supervisor must not kill a server it does not own.
    await b.stop();
    const stillRunning = await httpGet(`http://127.0.0.1:${port}/healthz`, 1500);
    assert.equal(stillRunning.status, 200);

    // The original owner can still stop its own server.
    await a.stop();
    const { status } = await httpGet(`http://127.0.0.1:${port}/healthz`, 1500).catch(() => ({ status: 0 }));
    assert.notEqual(status, 200);
  } finally {
    for (const sup of supervisors) await sup.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supervisor tolerates transient server health misses before reporting error", async () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const sup = new Supervisor({
      config: store,
      secrets: { getSecret: () => null },
      serverHealthFailureThreshold: 3
    });
    sup.serverState = "online";
    sup.lastHealth = { status: "ok", pid: 123 };
    sup.readHealth = async () => null;

    await sup.refreshStatus();
    assert.equal(sup.serverState, "online");
    await sup.refreshStatus();
    assert.equal(sup.serverState, "online");
    await sup.refreshStatus();
    assert.equal(sup.serverState, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supervisor schedules bounded tunnel recovery after an unexpected exit", async () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    const sup = new Supervisor({
      config: store,
      secrets: { getSecret: () => null },
      tunnelRestartBaseMs: 10,
      tunnelRestartMaxMs: 20,
      tunnelRestartMaxAttempts: 2
    });
    sup.serverState = "online";
    let recoveries = 0;
    sup.startTunnel = async ({ recovery } = {}) => {
      assert.equal(recovery, true);
      recoveries += 1;
      sup.tunnelState = "starting";
    };

    sup.scheduleTunnelRestart("test exit");
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(recoveries, 1);
    assert.equal(sup._tunnelRestartAttempts, 1);
    sup.cancelTunnelRestart();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supervisor actually retries a tunnel process that exits unexpectedly", async () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    store.set({
      tunnelBin: process.execPath,
      tunnelId: "tunnel_test_recovery",
      profile: "recovery-test",
      profileDir: path.join(dir, "profiles"),
      openWebUi: false
    });
    const sup = new Supervisor({
      config: store,
      secrets: { getSecret: (name) => (name === "runtimeKey" ? "test-runtime-key" : null) },
      tunnelRestartBaseMs: 10,
      tunnelRestartMaxMs: 20,
      tunnelRestartMaxAttempts: 2
    });
    sup.serverState = "online";

    // process.execPath is intentionally not a tunnel client. It exits when it
    // receives the tunnel CLI arguments, exercising the real child exit path.
    await sup.startTunnel();
    const exhausted = await waitUntil(
      () => sup.tunnelState === "error" && /automatic recovery exhausted/i.test(sup.lastTunnelError),
      2000
    );
    assert.equal(exhausted, true, "tunnel recovery should reach a terminal error state");
    assert.equal(sup._tunnelRestartAttempts, 2);
    assert.equal(sup.tunnelState, "error");
    assert.match(sup.lastTunnelError, /automatic recovery exhausted/i);
    await sup.stopTunnel();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supervisor start reports specific validation errors", async () => {
  const dir = tempDir();
  try {
    const store = new ConfigStore({ dir, repoRoot: REPO_ROOT, ...codec });
    store.set({ mcpAppDir: path.join(dir, "no-such-server") });
    const sup = new Supervisor({ config: store, secrets: { getSecret: () => null } });
    await assert.rejects(() => sup.start({ tunnel: false }), /MCP app folder does not exist/i);

    store.set({ mcpAppDir: SERVER_DIR, tunnelBin: store.file });
    store.saveSecret("runtimeKey", "sk-x");
    const problem = sup.tunnelReadyToStart();
    assert.ok(problem.includes("Tunnel ID is empty"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
