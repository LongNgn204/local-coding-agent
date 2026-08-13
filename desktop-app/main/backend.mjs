// Local Codex Studio — main-process backend
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// StudioBackend is the whole main-process wiring, extracted into a plain module
// so it can be integration-tested WITHOUT launching Electron. It:
//   1. spawns THIS repo's server/server.mjs as a child (loopback only),
//   2. waits for GET /healthz to return ok,
//   3. connects an MCP client (StreamableHTTPClientTransport) to /mcp,
//   4. exposes async methods the Electron IPC layer forwards to the renderer.
//
// Mutations (create/cancel) and status go through the MCP client. Paginated
// report/log artifacts go through the loopback dashboard JSON endpoint
// (/api/agent?id=&source=&offset=&limit=) because the MCP result tool does not
// expose offset/limit line pagination. Both surfaces are already tested in-repo;
// no new server endpoints are added.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// desktop-app/main -> repo root is two levels up.
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const SERVER_DIR = path.join(REPO_ROOT, "server");
export const SERVER_ENTRY = path.join(SERVER_DIR, "server.mjs");

// Load the MCP client SDK from the server's node_modules (already installed).
const serverRequire = createRequire(path.join(SERVER_DIR, "package.json"));

async function loadMcpSdk() {
  const clientPath = serverRequire.resolve("@modelcontextprotocol/sdk/client/index.js");
  const transportPath = serverRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { Client } = await import(pathToFileURL(clientPath).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(transportPath).href);
  return { Client, StreamableHTTPClientTransport };
}

// Ask the OS for a free loopback TCP port by binding to 0 and reading it back.
export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
        } catch (e) {
          reject(new Error(`bad JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${url}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Extract the JSON payload our tools return. reg() wraps objects as a single
// text content block containing JSON; parse it back into an object.
function parseToolResult(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const block = Array.isArray(result.content) ? result.content.find((c) => c.type === "text") : null;
  if (!block) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return { text: block.text };
  }
}

export class StudioBackend {
  /**
   * @param {object} opts
   * @param {string}  [opts.workspace]   Workspace root the agent may read/write.
   * @param {"safe"|"full"} [opts.mode]  Command mode (default safe).
   * @param {string}  [opts.host]        Loopback host (default 127.0.0.1).
   * @param {number}  [opts.port]        MCP port (default: find a free one).
   * @param {number}  [opts.dashboardPort]
   * @param {string}  [opts.nodePath]    node executable (default process.execPath).
   * @param {number}  [opts.healthTimeoutMs] health poll budget (default 15000).
   * @param {(line:string)=>void} [opts.onLog] server stdout/stderr sink.
   */
  constructor(opts = {}) {
    this.host = opts.host || "127.0.0.1";
    this.mode = opts.mode === "full" ? "full" : "safe";
    this.workspace = opts.workspace ? path.resolve(opts.workspace) : REPO_ROOT;
    this.permissionProfileFile = opts.permissionProfileFile ? path.resolve(opts.permissionProfileFile) : "";
    this.permissionProfileName = String(opts.permissionProfileName || "");
    this.requestedPort = opts.port || null;
    this.requestedDashboardPort = opts.dashboardPort || null;
    this.nodePath = opts.nodePath || process.execPath;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 15000;
    this.onLog = typeof opts.onLog === "function" ? opts.onLog : () => {};

    this.port = null;
    this.dashboardPort = null;
    this.child = null;
    this.client = null;
    this.transport = null;
    this._starting = null;
    this._lastHealth = null;
  }

  get running() {
    return Boolean(this.child && this.client);
  }

  baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  dashboardBaseUrl() {
    return `http://${this.host}:${this.dashboardPort}`;
  }

  // Idempotent start: spawn server child, wait for health, connect MCP client.
  async start(overrides = {}) {
    if (this.running) return this.health();
    if (this._starting) return this._starting;
    this._starting = this._doStart(overrides).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _doStart(overrides) {
    if (overrides.workspace) this.workspace = path.resolve(overrides.workspace);
    if (overrides.mode) this.mode = overrides.mode === "full" ? "full" : "safe";
    if (overrides.permissionProfileFile) this.permissionProfileFile = path.resolve(overrides.permissionProfileFile);
    if (overrides.permissionProfileName) this.permissionProfileName = String(overrides.permissionProfileName);

    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(`server entry not found: ${SERVER_ENTRY}`);
    }
    if (!existsSync(path.join(SERVER_DIR, "node_modules"))) {
      throw new Error(`server dependencies missing: run npm install in ${SERVER_DIR}`);
    }

    this.port = this.requestedPort || (await findFreePort(this.host));
    this.dashboardPort = this.requestedDashboardPort || (await findFreePort(this.host));

    const env = {
      ...process.env,
      AGENT_V5_PREVIEW: "1",
      PORT: String(this.port),
      DASHBOARD_PORT: String(this.dashboardPort),
      AGENT_WORKSPACE: this.workspace,
      AGENT_MODE: this.mode,
      AGENT_PERMISSION_PROFILE_FILE: this.permissionProfileFile,
      AGENT_PERMISSION_PROFILE_NAME: this.permissionProfileName,
      AGENT_HOST: this.host
    };

    // When running inside Electron, process.execPath is electron.exe. Setting
    // ELECTRON_RUN_AS_NODE makes it behave as a plain Node interpreter so the
    // server script runs as Node rather than launching a second Electron app.
    // (No effect when nodePath is a real node binary, e.g. in tests.)
    if (process.versions?.electron && this.nodePath === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }

    this.child = spawn(this.nodePath, [SERVER_ENTRY], {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (d) => this.onLog(String(d).replace(/\s+$/, "")));
    this.child.stderr?.on("data", (d) => this.onLog(String(d).replace(/\s+$/, "")));

    let exitedEarly = null;
    const onExit = (code, signal) => {
      exitedEarly = { code, signal };
      this.child = null;
    };
    this.child.once("exit", onExit);
    this.child.once("error", (err) => {
      exitedEarly = { error: err.message };
    });

    // Poll /healthz until ok or timeout.
    const deadline = Date.now() + this.healthTimeoutMs;
    let health = null;
    while (Date.now() < deadline) {
      if (exitedEarly) {
        throw new Error(`server exited during startup: ${JSON.stringify(exitedEarly)}`);
      }
      try {
        const { status, json } = await httpGetJson(`${this.baseUrl()}/healthz`, 2000);
        if (status === 200 && json && json.status === "ok") {
          health = json;
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    if (!health) {
      await this.stop();
      throw new Error(`server did not become healthy within ${this.healthTimeoutMs}ms on ${this.baseUrl()}`);
    }
    this._lastHealth = health;
    this.child.removeListener("exit", onExit);
    this.child.once("exit", (code, signal) => {
      this.onLog(`[server exited code=${code} signal=${signal}]`);
      this.child = null;
    });

    // Connect the MCP client.
    const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
    this.transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl()}/mcp`));
    this.client = new Client({ name: "local-codex-studio", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(this.transport);

    return this.health();
  }

  async _callTool(name, args) {
    if (!this.client) throw new Error("MCP client not connected — call start() first.");
    const result = await this.client.callTool({ name, arguments: args || {} });
    if (result?.isError) {
      const payload = parseToolResult(result);
      const msg = payload?.error || payload?.text || `tool ${name} failed`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return parseToolResult(result);
  }

  // Live health straight from /healthz (with legacy preview aliases retained).
  async health() {
    if (!this.port) return { ok: false, reason: "not_started" };
    try {
      const { status, json } = await httpGetJson(`${this.baseUrl()}/healthz`, 3000);
      const ok = status === 200 && json?.status === "ok";
      if (ok) this._lastHealth = json;
      return {
        ok,
        status: json?.status || null,
        version: json?.version || null,
        preview_version: json?.preview_version || null,
        preview_enabled: Boolean(json?.preview_enabled),
        mode: json?.mode || this.mode,
        workspace: json?.workspace || this.workspace,
        roots: json?.roots || [],
        permission_profile: json?.permission_profile || this.permissionProfileName || null,
        pid: json?.pid || this.child?.pid || null,
        port: this.port,
        dashboard_port: this.dashboardPort ?? json?.dashboard_port ?? null,
        mcp_endpoint: json?.mcp_endpoint || `${this.baseUrl()}/mcp`
      };
    } catch (e) {
      return { ok: false, reason: e.message, port: this.port };
    }
  }

  async createTask({ role, task, engine, title, workspaceRoot, maxRuntimeMs, dryRun } = {}) {
    if (!role) throw new Error("role is required");
    if (!task || !String(task).trim()) throw new Error("task text is required");
    const args = { role, task, engine: engine || "codex_cli" };
    if (title) args.title = title;
    if (workspaceRoot) args.workspace_root = workspaceRoot;
    if (typeof maxRuntimeMs === "number") args.max_runtime_ms = maxRuntimeMs;
    if (dryRun) args.dry_run = true;
    return this._callTool("create_local_task", args);
  }

  async listTasks({ status, limit } = {}) {
    const args = {};
    if (status && status !== "all") args.status = status;
    if (typeof limit === "number") args.limit = limit;
    const out = await this._callTool("list_local_tasks", args);
    return out || { count: 0, tasks: [] };
  }

  async getTask(id) {
    if (!id) throw new Error("task id is required");
    return this._callTool("get_local_task_status", { task_id: id });
  }

  // Compact result (summary + truncated slice) via MCP.
  async getResult(id, maxChars) {
    if (!id) throw new Error("task id is required");
    const args = { task_id: id };
    if (typeof maxChars === "number") args.max_chars = maxChars;
    return this._callTool("get_local_task_result", args);
  }

  // Paginated report/log viewer via the loopback dashboard endpoint.
  async getArtifact(id, source = "report", offset = 0, limit = 200) {
    if (!id) throw new Error("task id is required");
    const src = source === "log" ? "log" : "report";
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const url = `${this.dashboardBaseUrl()}/api/agent?id=${encodeURIComponent(id)}&source=${src}&offset=${off}&limit=${lim}`;
    const { status, json } = await httpGetJson(url, 5000);
    if (status !== 200) {
      throw new Error(`getArtifact failed (${status}): ${json?.error || "unknown"}`);
    }
    return json;
  }

  async cancelTask(id) {
    if (!id) throw new Error("task id is required");
    return this._callTool("cancel_local_task", { task_id: id });
  }

  // Loopback dashboard URL the renderer can open in the default browser.
  dashboardUrl() {
    return this.dashboardPort ? `${this.dashboardBaseUrl()}/ui#v5` : null;
  }

  async stop() {
    // Close MCP client first so it stops talking to a dying server.
    try {
      if (this.client) await this.client.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.transport) await this.transport.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;

    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode) return;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);

      if (process.platform === "win32" && child.pid) {
        // Tree-kill on Windows so the whole process group dies.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        });
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000).unref?.();
      }
      // Safety timeout: never hang stop() forever.
      setTimeout(finish, 6000).unref?.();
    });
  }
}

export default StudioBackend;
