// Local Coding Agent Tray — process supervisor.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owns the two child processes (Node MCP server + OpenAI tunnel client),
// health-gated startup, tunnel recovery, and live status snapshots. Plain Node
// so it can be integration-tested without Electron.

import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { httpGetJson, killTree, oneLine, sleep } from "./util.mjs";
import { parseTunnelStatus, tunnelFailureSummary } from "./tunnel-status.mjs";

export class Supervisor {
  constructor(opts = {}) {
    this.config = opts.config;
    this.secrets = opts.secrets || { getSecret: () => null };
    this.onLog = typeof opts.onLog === "function" ? opts.onLog : () => {};
    this.onStatus = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 25000;
    this.pollMs = opts.pollMs ?? 2000;
    this.serverHealthFailureThreshold = opts.serverHealthFailureThreshold ?? 3;
    this.tunnelRestartBaseMs = opts.tunnelRestartBaseMs ?? 1500;
    this.tunnelRestartMaxMs = opts.tunnelRestartMaxMs ?? 30000;
    this.tunnelRestartMaxAttempts = opts.tunnelRestartMaxAttempts ?? 5;

    this.serverChild = null;
    this.tunnelChild = null;
    this.serverState = "offline";
    this.tunnelState = "stopped";
    this.lastHealth = null;
    this.lastTunnelRuntime = null;
    this.lastTunnelError = "";
    this.starting = false;
    this._pollTimer = null;
    this._serverHealthFailures = 0;
    this._tunnelStopRequested = false;
    this._tunnelRestartTimer = null;
    this._tunnelRestartAttempts = 0;
    this._disposed = false;
  }

  log(line) {
    this.onLog(line);
  }

  // ---- Snapshot -------------------------------------------------------------

  snapshot() {
    const health = this.lastHealth || {};
    const roots = Array.isArray(health.roots) ? health.roots.length : 0;
    const tunnel = this.tunnelSnapshot();
    return {
      server: {
        state: this.serverState,
        version: health.version || "",
        mode: health.mode || "",
        policy: health.policy || "",
        permissionProfile: health.permission_profile || "",
        workspace: health.workspace || "",
        roots,
        pid: health.pid || null,
        v5Enabled: Boolean(health.v5_enabled)
      },
      tunnel: {
        state: tunnel.state,
        reason: tunnel.reason,
        suffix: tunnelIdFingerprintSafe(this.config.get().tunnelId),
        mismatch: Boolean(tunnel.mismatch)
      },
      mcpUrl: this.config.mcpUrl(this.config.get()),
      dashboardUrl: this.config.dashboardUrl(this.config.get())
    };
  }

  tunnelSnapshot() {
    const cfg = this.config.get();
    const tunnelConfigured = Boolean(cfg.tunnelId && cfg.tunnelBin && existsSync(cfg.tunnelBin));
    if (this.tunnelState === "starting" || this.tunnelState === "connected" || this.tunnelState === "reconnecting" || this.tunnelState === "error") {
      const t = this.lastTunnelRuntime || {};
      return {
        state: this.tunnelState,
        reason: this.lastTunnelError || tunnelFailureSummary(t),
        mismatch: Boolean(t.tunnelIdMismatch)
      };
    }
    if (this.tunnelState === "stopped") {
      return {
        state: tunnelConfigured ? "stopped" : "not_configured",
        reason: tunnelConfigured ? "stopped" : "not configured",
        mismatch: false
      };
    }
    return { state: this.tunnelState, reason: "", mismatch: false };
  }

  emit() {
    this.onStatus(this.snapshot());
  }

  // ---- Server ---------------------------------------------------------------

  async resolveNode(configured) {
    if (configured && configured !== "node" && configured !== "node.exe") return configured;
    const candidates = [];
    if (process.platform === "win32") {
      const root = process.env.ProgramFiles || "C:\\Program Files";
      candidates.push("node", path.join(root, "nodejs", "node.exe"));
    } else {
      candidates.push("node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node", "/usr/bin/node");
    }
    for (const candidate of candidates) {
      if (path.dirname(candidate) === ".") continue; // plain "node": only used as last resort via PATH
      try {
        await fsAccess(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
    // Packaged Electron includes a compatible Node runtime. This keeps the
    // release usable even when Node is not installed globally.
    if (process.versions?.electron) return process.execPath;
    return "node";
  }

  async ensurePermissionStore(cfg) {
    const workspace = path.resolve(cfg.workspace);
    const profileName = cfg.permissionProfileName || "default";
    const existing = this.config.getPermissionStore();
    const active = existing?.profiles?.[existing.active_profile || profileName];
    const primaryRoot = active?.roots?.[0]?.path;
    if (primaryRoot && path.resolve(primaryRoot) === workspace) return; // already in sync
    const store = {
      version: 1,
      active_profile: profileName,
      profiles: {
        [profileName]: {
          version: 1,
          name: profileName,
          description: "Local Coding Agent v5 multi-root profile",
          working_directory: workspace,
          roots: [
            { label: "Primary workspace", path: workspace, preset: cfg.mode === "full" ? "full_control" : "develop" }
          ]
        }
      }
    };
    try {
      this.config.setPermissionStore(store);
      this.log(`[supervisor] wrote permission profile (root=${workspace})`);
    } catch (error) {
      this.log(`[supervisor] permission profile update skipped: ${error.message}`);
    }
  }

  async startServer() {
    const cfg = this.config.get();
    const entry = path.join(cfg.mcpAppDir || "", cfg.serverScript || "server.mjs");
    if (!existsSync(entry)) {
      throw new Error(`MCP app folder does not exist: ${cfg.mcpAppDir}`);
    }

    // Always re-derive the active permission profile from current settings so a
    // stale on-disk store can never restrict the configured workspace.
    if (cfg.workspace) {
      await this.ensurePermissionStore(cfg);
    }

    const expectedConfigId = this.config.configId(cfg);
    const existing = await this.readHealth();
    if (existing?.status === "ok" && existing.pid) {
      const legacyMatches =
        !existing.config_id &&
        existing.workspace === cfg.workspace &&
        existing.mode === cfg.mode &&
        existing.policy === cfg.policy;
      if (existing.config_id === expectedConfigId || legacyMatches) {
        // Never bounce a healthy compatible server just because the tray was
        // reopened or Start was pressed again. Existing MCP sessions depend on
        // this PID remaining stable.
        this.serverState = "online";
        this.lastHealth = existing;
        this._serverHealthFailures = 0;
        this.log(`[supervisor] reusing healthy MCP server pid=${existing.pid}`);
        this.emit();
        return existing;
      }
      throw new Error(
        `MCP server pid=${existing.pid} is already healthy with a different configuration. ` +
          "Stop it explicitly before applying settings that require a restart."
      );
    }

    // A child may still exist while its HTTP health endpoint is gone. Only a
    // process this Supervisor actually owns may be terminated automatically.
    if (this.serverChild && this.serverChild.exitCode === null) {
      await killTree(this.serverChild);
      this.serverChild = null;
      await sleep(400);
    }

    const nodePath = await this.resolveNode(cfg.node);
    const env = {
      ...process.env,
      PORT: String(cfg.port),
      DASHBOARD_PORT: String(cfg.dashboardPort),
      AGENT_HOST: "127.0.0.1",
      AGENT_WORKSPACE: cfg.workspace || "",
      AGENT_MODE: cfg.mode,
      AGENT_POLICY: cfg.policy,
      AGENT_EXTRA_ROOTS: cfg.extraRoots || "",
      AGENT_PERMISSION_PROFILE_FILE: cfg.permissionProfileFile || "",
      AGENT_PERMISSION_PROFILE_NAME: cfg.permissionProfileName || "",
      AGENT_DATA_DIR: path.join(this.config.dir, "server-data"),
      AGENT_CONFIG_ID: this.config.configId(cfg),
      AGENT_V5_PREVIEW: cfg.v5Preview ? "1" : "0",
      AGENT_ALLOW_SYSTEM_SHUTDOWN: cfg.allowSystemShutdown ? "1" : "0",
      AGENT_ALLOW_DANGEROUS: cfg.allowDangerous ? "1" : "0"
    };
    if (process.versions?.electron && nodePath === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const authToken = this.secrets.getSecret("authToken") || cfg.authToken || "";
    if (authToken) env.MCP_AUTH_TOKEN = authToken;

    this.serverState = "starting";
    this.lastHealth = null;
    this.emit();
    this.log(`[supervisor] starting node ${cfg.serverScript} (PORT=${cfg.port}, mode=${cfg.mode}, policy=${cfg.policy})`);

    this.serverChild = spawn(nodePath, [cfg.serverScript], {
      cwd: cfg.mcpAppDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.serverChild.stdout.setEncoding("utf8");
    this.serverChild.stderr.setEncoding("utf8");
    this.serverChild.stdout.on("data", (chunk) => this.log(`[server] ${chunk.trimEnd()}`));
    this.serverChild.stderr.on("data", (chunk) => this.log(`[server] ${chunk.trimEnd()}`));
    this.serverChild.on("exit", (code) => {
      this.log(`[server] process exited (code=${code})`);
      if (this.serverState !== "stopping") {
        this.serverState = this.lastHealth ? "error" : "offline";
        this.emit();
      }
    });
    this.serverChild.on("error", (error) => {
      this.log(`[server] spawn error: ${error.message}`);
      this.serverState = "error";
      this.emit();
    });
  }

  async waitHealthy() {
    const deadline = Date.now() + this.healthTimeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      const health = await this.readHealth();
      if (health && health.status === "ok") {
        this.serverState = "online";
        this.lastHealth = health;
        this._serverHealthFailures = 0;
        this.emit();
        return health;
      }
      if (health) lastError = health.reason || "";
      await sleep(500);
    }
    this.serverState = "error";
    this.emit();
    throw new Error(lastError ? `MCP server did not become healthy: ${oneLine(lastError)}` : "MCP server did not respond. Check Logs/Config for server output.");
  }

  async readHealth() {
    const cfg = this.config.get();
    try {
      const res = await httpGetJson(this.config.healthUrl(cfg), 2000);
      if (res.json && res.json.status === "ok") {
        this.lastHealth = res.json;
        return res.json;
      }
      return res.json || null;
    } catch {
      return null;
    }
  }

  async stopServer() {
    if (this.serverChild && this.serverChild.exitCode === null) {
      this.serverState = "stopping";
      this.emit();
      await killTree(this.serverChild);
      this.serverChild = null;
      this.log("[supervisor] stopped owned server");
    } else {
      const external = await this.readHealth();
      if (external?.pid) {
        this.log(`[supervisor] leaving externally managed MCP server pid=${external.pid} running`);
      }
    }
    this.serverState = "offline";
    this.lastHealth = null;
    this._serverHealthFailures = 0;
    this.emit();
  }

  async killStrayServer(knownHealth = null) {
    const health = knownHealth || (await this.readHealth());
    const pid = health?.pid;
    if (!pid) return false;
    if (this.serverChild && this.serverChild.exitCode === null && this.serverChild.pid === pid) {
      return true; // our own child; stopServer already handled it
    }
    if (!(await this.verifyServerPid(pid))) return false;
    this.log(`[supervisor] stopping external MCP server pid=${pid}`);
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      return false;
    }
    await sleep(700);
    const still = await this.readHealth();
    if (still?.pid) {
      try {
        process.kill(still.pid, "SIGKILL");
      } catch {
        /* gone already */
      }
      await sleep(400);
    }
    this.lastHealth = null;
    return true;
  }

  verifyServerPid(pid) {
    if (process.platform === "win32") return Promise.resolve(true);
    return new Promise((resolve) => {
      execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
        const line = stdout?.trim() || "";
        resolve(!error && line.includes("server.mjs"));
      });
    });
  }

  // ---- Tunnel ---------------------------------------------------------------

  tunnelReadyToStart() {
    const cfg = this.config.get();
    if (!cfg.tunnelBin || !existsSync(cfg.tunnelBin)) return "tunnel executable not found: " + (cfg.tunnelBin || "(empty)");
    if (!cfg.tunnelId || !String(cfg.tunnelId).trim()) return "Tunnel ID is empty. Paste the tunnel_... ID first.";
    if (!this.secrets.getSecret("runtimeKey")) return "Save the Runtime API key before connecting the tunnel.";
    return "";
  }

  async readTunnelRuntime() {
    const cfg = this.config.get();
    const port = String(cfg.tunnelHealthPort || "8788");
    try {
      const res = await httpGetJson(`http://127.0.0.1:${port}/api/status`, 2000);
      if (!res.json) return null;
      return parseTunnelStatus(res.json, cfg.tunnelId);
    } catch {
      return null;
    }
  }

  cancelTunnelRestart() {
    if (this._tunnelRestartTimer) {
      clearTimeout(this._tunnelRestartTimer);
      this._tunnelRestartTimer = null;
    }
  }

  scheduleTunnelRestart(reason = "tunnel stopped unexpectedly") {
    if (this._disposed || this._tunnelStopRequested || this._tunnelRestartTimer) return;
    if (this._tunnelRestartAttempts >= this.tunnelRestartMaxAttempts) {
      this.tunnelState = "error";
      this.lastTunnelError = `${reason}; automatic recovery exhausted after ${this._tunnelRestartAttempts} attempts`;
      this.emit();
      return;
    }
    const attempt = ++this._tunnelRestartAttempts;
    const delay = Math.min(this.tunnelRestartBaseMs * 2 ** (attempt - 1), this.tunnelRestartMaxMs);
    this.tunnelState = "reconnecting";
    this.lastTunnelError = `${reason}; retry ${attempt}/${this.tunnelRestartMaxAttempts} in ${delay}ms`;
    this.log(`[supervisor] tunnel recovery scheduled attempt=${attempt} delay=${delay}ms`);
    this.emit();
    this._tunnelRestartTimer = setTimeout(async () => {
      this._tunnelRestartTimer = null;
      if (this._disposed || this._tunnelStopRequested) return;
      if (this.serverState !== "online") {
        this.scheduleTunnelRestart("MCP server is not online yet");
        return;
      }
      try {
        await this.startTunnel({ recovery: true });
      } catch (error) {
        this.lastTunnelError = error.message;
        this.log(`[supervisor] tunnel recovery attempt failed: ${error.message}`);
        this.scheduleTunnelRestart(error.message);
      }
    }, delay);
    if (typeof this._tunnelRestartTimer.unref === "function") this._tunnelRestartTimer.unref();
  }

  async startTunnel({ recovery = false } = {}) {
    const cfg = this.config.get();
    const problem = this.tunnelReadyToStart();
    if (problem) throw new Error(problem);

    if (!recovery) {
      this.cancelTunnelRestart();
      this._tunnelRestartAttempts = 0;
    }

    if (this.tunnelChild && this.tunnelChild.exitCode === null) {
      this.log("[supervisor] tunnel already running");
      return;
    }

    const existing = await this.readTunnelRuntime();
    if (existing?.ready) {
      this.lastTunnelRuntime = existing;
      this.lastTunnelError = "";
      this.tunnelState = "connected";
      this._tunnelRestartAttempts = 0;
      this.log("[supervisor] reusing healthy tunnel runtime");
      this.emit();
      return;
    }

    let profileFile = "";
    try {
      profileFile = this.config.writeTunnelProfile(cfg);
    } catch (error) {
      this.tunnelState = "error";
      this.lastTunnelError = error.message;
      this.emit();
      throw error;
    }

    const env = {
      ...process.env,
      CONTROL_PLANE_API_KEY: this.secrets.getSecret("runtimeKey") || "",
      CONTROL_PLANE_TUNNEL_ID: String(cfg.tunnelId).trim()
    };
    const authToken = this.secrets.getSecret("authToken") || cfg.authToken || "";
    if (authToken) {
      env.MCP_AUTH_HEADER = `Bearer ${authToken}`;
      env.MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER";
    }

    const args = ["run", "--profile", cfg.profile || "local-coding-agent", "--profile-dir", cfg.profileDir];
    if (cfg.openWebUi) args.push("--open-web-ui");

    this.tunnelState = "starting";
    this.lastTunnelError = "";
    this.emit();
    this.log(`[supervisor] starting tunnel (profile=${cfg.profile})`);

    const child = spawn(cfg.tunnelBin, args, {
      cwd: path.dirname(cfg.tunnelBin),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.tunnelChild = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.log(`[tunnel] ${chunk.trimEnd()}`));
    child.stderr.on("data", (chunk) => this.log(`[tunnel] ${chunk.trimEnd()}`));
    child.on("exit", (code) => {
      this.log(`[tunnel] process exited (code=${code})`);
      if (this.tunnelChild === child) this.tunnelChild = null;
      const intentional =
        this._disposed || this._tunnelStopRequested || this.tunnelState === "stopped" || this.tunnelState === "reconnecting";
      if (!intentional) {
        const reason = `tunnel process exited unexpectedly (code=${code})`;
        this.tunnelState = "error";
        this.lastTunnelError = reason;
        this.emit();
        this.scheduleTunnelRestart(reason);
      }
    });
    child.on("error", (error) => {
      this.log(`[tunnel] spawn error: ${error.message}`);
      if (this.tunnelChild === child) this.tunnelChild = null;
      this.tunnelState = "error";
      this.lastTunnelError = error.message;
      this.emit();
      if (!this._tunnelStopRequested) this.scheduleTunnelRestart(error.message);
    });
    this.log(`[supervisor] wrote tunnel profile ${profileFile}`);
  }

  async stopTunnel() {
    this._tunnelStopRequested = true;
    this.cancelTunnelRestart();
    this.tunnelState = "stopped";
    this.emit();
    try {
      if (this.tunnelChild && this.tunnelChild.exitCode === null) {
        await killTree(this.tunnelChild);
      } else {
        const external = await this.readTunnelRuntime();
        if (external?.ready) this.log("[supervisor] leaving externally managed tunnel runtime running");
      }
      this.tunnelChild = null;
      this.lastTunnelRuntime = null;
      this._tunnelRestartAttempts = 0;
      this.log("[supervisor] stopped owned tunnel");
    } finally {
      this._tunnelStopRequested = false;
    }
  }

  async killStrayTunnel() {
    const pids = await this.findTunnelPids();
    if (!pids.length) return false;
    for (const pid of pids) {
      if (this.tunnelChild && this.tunnelChild.exitCode === null && this.tunnelChild.pid === pid) {
        continue; // our own child; already handled above
      }
      this.log(`[supervisor] stopping external tunnel-client pid=${pid}`);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone already */
      }
    }
    await sleep(700);
    const still = await this.findTunnelPids();
    for (const pid of still) {
      if (this.tunnelChild && this.tunnelChild.exitCode === null && this.tunnelChild.pid === pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone already */
      }
    }
    this.lastTunnelRuntime = null;
    return pids.length > 0;
  }

  findTunnelPids() {
    if (process.platform === "win32") return Promise.resolve([]); // Windows uses taskkill; stray tunnel handled by tray-app
    return new Promise((resolve) => {
      execFile("ps", ["-axo", "pid=,command="], (error, stdout) => {
        if (error) return resolve([]);
        const pids = [];
        for (const line of String(stdout).split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(.+)$/);
          if (!m) continue;
          if (m[2].includes("tunnel-client") && m[2].includes(" run ")) pids.push(Number(m[1]));
        }
        resolve(pids);
      });
    });
  }

  async reconnectTunnel() {
    if (this.serverState !== "online") {
      throw new Error("Server is not online. Start it first.");
    }
    this.cancelTunnelRestart();
    this._tunnelRestartAttempts = 0;
    this._tunnelStopRequested = true;
    this.tunnelState = "reconnecting";
    this.lastTunnelError = "";
    this.emit();
    this.log("[supervisor] reconnecting tunnel…");
    try {
      if (this.tunnelChild && this.tunnelChild.exitCode === null) {
        await killTree(this.tunnelChild);
      }
      // Reconnect is an explicit operator action, so it may replace a matching
      // stray tunnel left by an older tray instance.
      await this.killStrayTunnel();
      this.tunnelChild = null;
      this.lastTunnelRuntime = null;
    } finally {
      this._tunnelStopRequested = false;
    }
    const problem = this.tunnelReadyToStart();
    if (problem) {
      this.tunnelState = "stopped";
      this.emit();
      throw new Error(problem);
    }
    await this.startTunnel();
  }

  // ---- Combined start / stop --------------------------------------------------

  async start({ tunnel } = {}) {
    if (this.starting) throw new Error("Already starting. Wait for the current start to finish.");
    this.starting = true;
    try {
      await this.startServer();
      await this.waitHealthy();
      this.log(`[supervisor] server ONLINE v${this.lastHealth?.version || "?"}`);
      if (tunnel) {
        try {
          await this.startTunnel();
        } catch (error) {
          throw new Error(`Server started but tunnel failed: ${error.message}`);
        }
      }
      return this.snapshot();
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    await this.stopTunnel();
    await this.stopServer();
    this.log("[supervisor] stopped everything");
  }

  // ---- Polling ---------------------------------------------------------------

  startPolling() {
    if (this._pollTimer) return;
    const tick = async () => {
      try {
        await this.refreshStatus();
      } catch {
        /* keep polling */
      }
    };
    tick();
    this._pollTimer = setInterval(tick, this.pollMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async refreshStatus() {
    const cfg = this.config.get();

    if (this.serverState !== "stopping") {
      const health = await this.readHealth();
      if (health && health.status === "ok") {
        this.serverState = "online";
        this.lastHealth = health;
        this._serverHealthFailures = 0;
      } else if (this.serverState === "online") {
        this._serverHealthFailures += 1;
        if (this._serverHealthFailures >= this.serverHealthFailureThreshold) {
          this.serverState = "error";
        }
      } else if (this.serverState === "starting") {
        // waitHealthy is driving startup; stay in starting.
      }
    }

    if (this.tunnelState !== "stopped") {
      const parsed = await this.readTunnelRuntime();
      if (parsed) {
        this.lastTunnelRuntime = parsed;
        if (parsed.ready) {
          this.tunnelState = "connected";
          this.lastTunnelError = "";
          this._tunnelRestartAttempts = 0;
        } else if (this.tunnelState === "starting" || this.tunnelState === "reconnecting") {
          // still probing; keep current state
        } else {
          this.tunnelState = "error";
          this.lastTunnelError = tunnelFailureSummary(parsed);
        }
      } else if (!this.tunnelChild && this.tunnelState === "connected") {
        const reason = "tunnel health endpoint disappeared";
        this.tunnelState = "error";
        this.lastTunnelError = reason;
        this.scheduleTunnelRestart(reason);
      }
    }

    this.emit();
  }

  async dispose() {
    this._disposed = true;
    this.cancelTunnelRestart();
    this.stopPolling();
    await this.stop();
  }
}

function tunnelIdFingerprintSafe(tunnelId) {
  const value = String(tunnelId || "").trim();
  if (!value) return "not configured";
  return `...${value.slice(-8)}`;
}
