#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const SERVER_SCRIPT = "server.mjs";
const CONFIG_PATH = process.env.LCA_CONFIG_PATH || defaultConfigPath();
const PID_PATH = join(dirname(CONFIG_PATH), "processes.json");
const LOG_PATH = join(dirname(CONFIG_PATH), "launcher.log");

const DEFAULTS = {
  node: process.env.NODE || "node",
  workspace: process.env.AGENT_WORKSPACE || "",
  extraRoots: process.env.AGENT_EXTRA_ROOTS || "",
  mode: process.env.AGENT_MODE || "safe",
  policy: process.env.AGENT_POLICY || "balanced",
  port: process.env.PORT || "8787",
  dashboardPort: process.env.DASHBOARD_PORT || "8790",
  authToken: process.env.MCP_AUTH_TOKEN || "",
  tunnelBin:
    process.env.TUNNEL_BIN ||
    join(REPO_ROOT, "tools", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client"),
  profile: process.env.TUNNEL_PROFILE || "local-coding-agent",
  profileDir: process.env.TUNNEL_PROFILE_DIR || join(REPO_ROOT, "tools", "profiles"),
  tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID || process.env.TUNNEL_ID || "",
  organizationId: process.env.OPENAI_ORGANIZATION || process.env.OPENAI_ORG_ID || "",
  runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
  runtimeKey: "",
  tunnelHealthPort: process.env.TUNNEL_HEALTH_PORT || "8788",
  openWebUi: process.env.OPEN_TUNNEL_WEB_UI !== "0",
  noTunnel: false
};

function defaultConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "LocalCodingAgent", "cli-config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LocalCodingAgent", "cli-config.json");
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "LocalCodingAgent", "cli-config.json");
}

function usage() {
  console.log(`Local Coding Agent universal CLI

Usage:
  node scripts/local-coding-agent.mjs setup [options]
  node scripts/local-coding-agent.mjs install
  node scripts/local-coding-agent.mjs start [options]
  node scripts/local-coding-agent.mjs stop
  node scripts/local-coding-agent.mjs status
  node scripts/local-coding-agent.mjs doctor
  node scripts/local-coding-agent.mjs profile [options]
  node scripts/local-coding-agent.mjs url
  node scripts/local-coding-agent.mjs open
  node scripts/local-coding-agent.mjs logs
  node scripts/local-coding-agent.mjs config show|path|set <key> <value>|unset <key>
  node scripts/local-coding-agent.mjs key set|clear

Common options:
  --workspace <path>          Workspace root the agent may access
  --extra-roots <paths>       Extra roots, semicolon-separated
  --mode <safe|full>          Command guardrail mode
  --policy <strict|balanced|full>
  --port <port>               MCP server port
  --dashboard-port <port>     Dashboard port
  --auth-token <token>        Optional MCP bearer token
  --node <path>               Node executable
  --background                Keep server/tunnel running after this command exits

Tunnel options:
  --no-tunnel                 Start only the local MCP server
  --tunnel-bin <path>         Path to tunnel-client(.exe)
  --tunnel-id <id>            OpenAI tunnel ID, e.g. tunnel_...
  --organization-id <id>      Optional OpenAI organization ID/header
  --profile <name>            Tunnel profile name
  --profile-dir <path>        Tunnel profile directory
  --runtime-key-env <name>    Env var containing Runtime API key
  --runtime-key <key>         Runtime API key for this process
  --save                      With setup, save provided options to config
  --no-open-web-ui            Do not pass --open-web-ui to tunnel-client

Fast path:
  scripts\\lca.cmd setup       # Windows
  bash scripts/lca setup       # macOS/Linux
  node scripts/local-coding-agent.mjs setup

One-shot examples:
  node scripts/local-coding-agent.mjs start --workspace "C:\\path\\repo" --no-tunnel
  CONTROL_PLANE_API_KEY=sk-proj-... node scripts/local-coding-agent.mjs start --workspace /path/repo --tunnel-id tunnel_...
`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", rest: [], flags: { help: true } };
  }
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      if (i + 1 >= rest.length) throw new Error(`Missing value for ${arg}`);
      return rest[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--workspace":
        flags.workspace = next();
        break;
      case "--extra-roots":
        flags.extraRoots = next();
        break;
      case "--mode":
        flags.mode = next();
        break;
      case "--policy":
        flags.policy = next();
        break;
      case "--port":
        flags.port = next();
        break;
      case "--dashboard-port":
        flags.dashboardPort = next();
        break;
      case "--auth-token":
        flags.authToken = next();
        break;
      case "--node":
        flags.node = next();
        break;
      case "--background":
      case "--daemon":
        flags.background = true;
        break;
      case "--no-tunnel":
        flags.noTunnel = true;
        break;
      case "--tunnel-bin":
        flags.tunnelBin = next();
        break;
      case "--tunnel-id":
        flags.tunnelId = next();
        break;
      case "--organization-id":
        flags.organizationId = next();
        break;
      case "--profile":
        flags.profile = next();
        break;
      case "--profile-dir":
        flags.profileDir = next();
        break;
      case "--runtime-key-env":
        flags.runtimeKeyEnv = next();
        break;
      case "--runtime-key":
        flags.runtimeKey = next();
        break;
      case "--save":
        flags.save = true;
        break;
      case "--no-open-web-ui":
        flags.openWebUi = false;
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
        positional.push(arg);
        break;
    }
  }
  return { command, rest: positional, flags };
}

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return { ...DEFAULTS, ...readJsonFile(CONFIG_PATH, {}) };
}

async function saveConfig(cfg) {
  ensureConfigDir();
  await writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try { await chmod(CONFIG_PATH, 0o600); } catch { /* Windows may ignore POSIX mode. */ }
}

function effectiveOptions(flags = {}) {
  const cfg = loadConfig();
  return normalize({ ...DEFAULTS, ...cfg, ...flags });
}

function normalize(opts) {
  const out = { ...opts };
  out.port = String(out.port || "8787");
  out.dashboardPort = String(out.dashboardPort || "8790");
  out.tunnelHealthPort = String(out.tunnelHealthPort || "8788");
  out.mode = out.mode || "safe";
  out.policy = out.policy || "balanced";
  out.runtimeKeyEnv = out.runtimeKeyEnv || "CONTROL_PLANE_API_KEY";
  out.profile = out.profile || "local-coding-agent";
  out.profileDir = out.profileDir || join(REPO_ROOT, "tools", "profiles");
  out.tunnelBin = out.tunnelBin || DEFAULTS.tunnelBin;
  out.node = out.node || "node";
  out.noTunnel = toBool(out.noTunnel);
  out.openWebUi = toBool(out.openWebUi, true);
  return out;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function validate(opts, { requireWorkspace = false, requireTunnel = false } = {}) {
  if (!["safe", "full"].includes(opts.mode)) throw new Error("--mode must be safe or full.");
  if (!["strict", "balanced", "full"].includes(opts.policy)) throw new Error("--policy must be strict, balanced, or full.");
  for (const [name, value] of [["port", opts.port], ["dashboard-port", opts.dashboardPort]]) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a TCP port.`);
  }
  if (requireWorkspace) {
    if (!opts.workspace) throw new Error("Missing workspace. Run `setup` or pass --workspace.");
    if (!existsSync(opts.workspace)) throw new Error(`Workspace does not exist: ${opts.workspace}`);
  }
  if (requireTunnel && !opts.noTunnel) {
    if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
    if (!existsSync(opts.tunnelBin)) throw new Error(`Tunnel client not found: ${opts.tunnelBin}`);
  }
}

function yamlEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function configId(opts) {
  const material = JSON.stringify({
    workspace: resolve(opts.workspace || ""),
    mode: opts.mode,
    policy: opts.policy,
    extraRoots: opts.extraRoots || "",
    authEnabled: Boolean(opts.authToken),
    port: String(opts.port),
    dashboardPort: String(opts.dashboardPort)
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

async function readJson(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function appendLog(line) {
  ensureConfigDir();
  const stamp = new Date().toISOString();
  writeFileSync(LOG_PATH, `[${stamp}] ${line}\n`, { encoding: "utf8", flag: "a" });
}

function spawnLogged(label, command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  console.log(`[${label}] ${printable}`);
  appendLog(`[${label}] ${printable}`);
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    detached: Boolean(options.detached),
    shell: false,
    windowsHide: true
  });
  child.on("exit", (code, signal) => {
    appendLog(`[${label}] exited code=${code} signal=${signal || ""}`);
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`[${label}] exited code=${code} signal=${signal || ""}`);
    }
  });
  return child;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
  } catch {
    // Best-effort only.
  }
}

function readPidState() {
  return readJsonFile(PID_PATH, {});
}

async function writePidState(state) {
  ensureConfigDir();
  await writeFile(PID_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function waitForHealth(port, attempts = 40) {
  const url = `http://127.0.0.1:${port}/healthz`;
  for (let i = 0; i < attempts; i++) {
    const health = await readJson(url);
    if (health?.status === "ok") return health;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function writeTunnelProfile(opts) {
  if (!opts.tunnelId) throw new Error("Missing tunnel ID. Run `setup` or pass --tunnel-id.");
  mkdirSync(opts.profileDir, { recursive: true });
  const fileName = opts.profile.endsWith(".yaml") ? opts.profile : `${opts.profile}.yaml`;
  const profilePath = join(opts.profileDir, fileName);
  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${yamlEscape(opts.tunnelId.trim())}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"'
  ];
  if (opts.organizationId) {
    lines.push("  extra_headers:");
    lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId.trim())}"`);
  }
  lines.push(
    "health:",
    `  listen_addr: "127.0.0.1:${opts.tunnelHealthPort}"`,
    "admin_ui:",
    `  open_browser: ${opts.openWebUi ? "true" : "false"}`,
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "http://127.0.0.1:${opts.port}/mcp"`
  );
  writeFileSync(profilePath, `${lines.join("\n")}\n`, "utf8");
  return profilePath;
}

async function promptLine(rl, label, current = "") {
  const suffix = current ? ` [${current}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function promptYesNo(rl, label, current = false) {
  const suffix = current ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return Boolean(current);
  return ["y", "yes", "1", "true"].includes(answer);
}

async function promptSecretUpdate(rl, label, current = "") {
  const suffix = current ? " [saved, leave blank to keep]" : " [optional]";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || current;
}

async function setup(flags) {
  const cfg = effectiveOptions(flags);
  const rl = createInterface({ input, output });
  try {
    console.log(`Config file: ${CONFIG_PATH}`);
    cfg.node = await promptLine(rl, "Node executable", cfg.node);
    cfg.workspace = await promptLine(rl, "Workspace root", cfg.workspace);
    cfg.extraRoots = await promptLine(rl, "Extra roots (; separated, optional)", cfg.extraRoots);
    cfg.mode = await promptLine(rl, "Mode (safe/full)", cfg.mode);
    cfg.policy = await promptLine(rl, "Policy (strict/balanced/full)", cfg.policy);
    cfg.port = await promptLine(rl, "MCP port", cfg.port);
    cfg.dashboardPort = await promptLine(rl, "Dashboard port", cfg.dashboardPort);
    cfg.authToken = await promptSecretUpdate(rl, "MCP auth token", cfg.authToken);
    cfg.noTunnel = await promptYesNo(rl, "Server only, no tunnel", cfg.noTunnel);
    if (!cfg.noTunnel) {
      cfg.tunnelBin = await promptLine(rl, "tunnel-client path", cfg.tunnelBin);
      cfg.profileDir = await promptLine(rl, "Tunnel profile dir", cfg.profileDir);
      cfg.profile = await promptLine(rl, "Tunnel profile name", cfg.profile);
      cfg.tunnelId = await promptLine(rl, "Tunnel ID", cfg.tunnelId);
      cfg.organizationId = await promptLine(rl, "Organization ID (optional)", cfg.organizationId);
      cfg.runtimeKeyEnv = await promptLine(rl, "Runtime API key env var", cfg.runtimeKeyEnv);
      const saveKey = await promptYesNo(rl, "Save runtime key in local CLI config? It is not DPAPI-encrypted", Boolean(cfg.runtimeKey));
      if (saveKey) {
        cfg.runtimeKey = await promptSecretUpdate(rl, "Runtime API key", cfg.runtimeKey);
      } else {
        cfg.runtimeKey = "";
      }
    }
    validate(cfg);
    await saveConfig(stripRuntimeFields(cfg));
    console.log("Saved.");
    console.log(`MCP URL: http://127.0.0.1:${cfg.port}/mcp`);
    console.log(`Dashboard: http://127.0.0.1:${cfg.dashboardPort}/ui`);
  } finally {
    rl.close();
  }
}

function stripRuntimeFields(cfg) {
  const out = { ...cfg };
  delete out.command;
  delete out.rest;
  delete out.flags;
  delete out.help;
  delete out.save;
  delete out.background;
  delete out.json;
  return out;
}

async function installDeps(opts) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawnLogged("install", npm, ["install"], { cwd: SERVER_DIR });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) throw new Error(`npm install failed with exit code ${code}`);
  console.log("Install complete.");
}

async function start(flags) {
  const opts = effectiveOptions(flags);
  validate(opts, { requireWorkspace: true, requireTunnel: true });
  if (!existsSync(join(SERVER_DIR, SERVER_SCRIPT))) throw new Error(`Missing ${SERVER_SCRIPT} in ${SERVER_DIR}`);
  if (!existsSync(join(SERVER_DIR, "node_modules"))) {
    throw new Error("server/node_modules is missing. Run `node scripts/local-coding-agent.mjs install` first.");
  }
  if (flags.save) await saveConfig(stripRuntimeFields(opts));

  const id = configId(opts);
  const healthUrl = `http://127.0.0.1:${opts.port}/healthz`;
  let health = await readJson(healthUrl);
  if (health?.status === "ok" && health.config_id !== id) {
    console.log(`[server] existing server config differs; stopping PID ${health.pid}`);
    killPid(health.pid);
    await new Promise((r) => setTimeout(r, 1200));
    health = null;
  }

  const state = readPidState();
  let serverChild = null;
  if (!health) {
    const env = {
      ...process.env,
      PORT: String(opts.port),
      DASHBOARD_PORT: String(opts.dashboardPort),
      AGENT_HOST: "127.0.0.1",
      AGENT_WORKSPACE: opts.workspace,
      AGENT_MODE: opts.mode,
      AGENT_POLICY: opts.policy,
      AGENT_CONFIG_ID: id,
      AGENT_EXTRA_ROOTS: opts.extraRoots || "",
      MCP_AUTH_TOKEN: opts.authToken || ""
    };
    const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
    serverChild = spawnLogged("server", opts.node, [SERVER_SCRIPT], {
      cwd: SERVER_DIR,
      env,
      detached: Boolean(flags.background),
      stdio
    });
    if (flags.background) serverChild.unref();
    health = await waitForHealth(opts.port);
    if (!health) throw new Error(`MCP server did not respond at ${healthUrl}`);
    state.serverPid = health.pid || serverChild.pid;
  } else {
    state.serverPid = health.pid;
  }

  console.log(`[server] MCP OK:    http://127.0.0.1:${opts.port}/mcp`);
  if (String(opts.dashboardPort) !== "0") console.log(`[server] Dashboard: http://127.0.0.1:${opts.dashboardPort}/ui`);
  console.log(`[server] Version:   ${health.version || "unknown"} ${health.tier ? `(${health.tier})` : ""}`);

  let tunnelChild = null;
  if (!opts.noTunnel) {
    const runtimeKey = flags.runtimeKey || process.env[opts.runtimeKeyEnv] || opts.runtimeKey;
    if (!runtimeKey) {
      throw new Error(`Missing Runtime API key. Set ${opts.runtimeKeyEnv}, pass --runtime-key, or run key set.`);
    }
    const profilePath = writeTunnelProfile(opts);
    console.log(`[tunnel] Profile: ${profilePath}`);
    const env = {
      ...process.env,
      CONTROL_PLANE_API_KEY: runtimeKey,
      CONTROL_PLANE_TUNNEL_ID: opts.tunnelId
    };
    if (opts.authToken) {
      env.MCP_AUTH_HEADER = `Bearer ${opts.authToken}`;
      env.MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER";
    }
    const args = ["run", "--profile", opts.profile, "--profile-dir", opts.profileDir, "--control-plane.tunnel-id", opts.tunnelId];
    if (opts.openWebUi) args.push("--open-web-ui");
    const stdio = flags.background ? ["ignore", "ignore", "ignore"] : "inherit";
    tunnelChild = spawnLogged("tunnel", opts.tunnelBin, args, {
      cwd: dirname(opts.tunnelBin),
      env,
      detached: Boolean(flags.background),
      stdio
    });
    if (flags.background) tunnelChild.unref();
    state.tunnelPid = tunnelChild.pid;
  } else {
    delete state.tunnelPid;
  }
  state.updatedAt = new Date().toISOString();
  state.configId = id;
  state.port = opts.port;
  state.dashboardPort = opts.dashboardPort;
  await writePidState(state);

  if (flags.background) {
    console.log("Running in background.");
    return;
  }

  const stopChildren = () => {
    if (tunnelChild && !tunnelChild.killed) tunnelChild.kill("SIGTERM");
    if (serverChild && !serverChild.killed) serverChild.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    stopChildren();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopChildren();
    process.exit(143);
  });

  if (tunnelChild) {
    await new Promise((resolveExit) => tunnelChild.on("exit", resolveExit));
  } else if (serverChild) {
    await new Promise((resolveExit) => serverChild.on("exit", resolveExit));
  }
}

async function stop(flags) {
  const opts = effectiveOptions(flags);
  const state = readPidState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  if (state.tunnelPid && isPidAlive(state.tunnelPid)) {
    console.log(`[tunnel] stopping PID ${state.tunnelPid}`);
    killPid(state.tunnelPid);
  }
  const serverPid = health?.pid || state.serverPid;
  if (serverPid && isPidAlive(serverPid)) {
    console.log(`[server] stopping PID ${serverPid}`);
    killPid(serverPid);
  }
  try { rmSync(PID_PATH, { force: true }); } catch { /* ignore */ }
  console.log("Stopped.");
}

async function status(flags) {
  const opts = effectiveOptions(flags);
  const state = readPidState();
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  const metrics = await readJson(`http://127.0.0.1:${opts.dashboardPort}/metrics`);
  const data = {
    config_path: CONFIG_PATH,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
    mcp_url: `http://127.0.0.1:${opts.port}/mcp`,
    dashboard_url: `http://127.0.0.1:${opts.dashboardPort}/ui`,
    server: health || null,
    dashboard: metrics ? { version: metrics.version, tier: metrics.tier, health_score: metrics.health_score } : null,
    pids: {
      server: state.serverPid || null,
      server_alive: isPidAlive(state.serverPid),
      tunnel: state.tunnelPid || null,
      tunnel_alive: isPidAlive(state.tunnelPid)
    }
  };
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(`Config:    ${data.config_path}`);
    console.log(`MCP URL:   ${data.mcp_url}`);
    console.log(`Dashboard: ${data.dashboard_url}`);
    console.log(`Server:    ${health ? `ONLINE ${health.version || ""} (${health.mode || "mode?"}/${health.policy || "policy?"}) pid=${health.pid || "?"}` : "offline"}`);
    console.log(`Tunnel:    ${data.pids.tunnel_alive ? `running pid=${data.pids.tunnel}` : "unknown/offline"}`);
  }
}

async function doctor(flags) {
  const opts = effectiveOptions(flags);
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  add("server directory", existsSync(SERVER_DIR), SERVER_DIR);
  add("server.mjs", existsSync(join(SERVER_DIR, SERVER_SCRIPT)), join(SERVER_DIR, SERVER_SCRIPT));
  add("server node_modules", existsSync(join(SERVER_DIR, "node_modules")), join(SERVER_DIR, "node_modules"));
  add("workspace", Boolean(opts.workspace && existsSync(opts.workspace)), opts.workspace || "(not set)");
  add("tunnel-client", opts.noTunnel || existsSync(opts.tunnelBin), opts.noTunnel ? "disabled" : opts.tunnelBin);
  add("runtime key", opts.noTunnel || Boolean(process.env[opts.runtimeKeyEnv] || opts.runtimeKey), opts.noTunnel ? "disabled" : opts.runtimeKeyEnv);
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
  add("server health", Boolean(health), health ? `${health.version} pid=${health.pid || "?"}` : "offline");
  for (const check of checks) {
    console.log(`${check.ok ? "OK " : "ERR"} ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) process.exitCode = 1;
}

async function configCommand(rest) {
  const [sub, key, ...valueParts] = rest;
  const cfg = loadConfig();
  if (!sub || sub === "show") {
    const visible = { ...cfg };
    if (visible.runtimeKey) visible.runtimeKey = "<saved>";
    if (visible.authToken) visible.authToken = "<saved>";
    console.log(JSON.stringify(visible, null, 2));
    return;
  }
  if (sub === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (sub === "set") {
    if (!key || valueParts.length === 0) throw new Error("Usage: config set <key> <value>");
    cfg[key] = valueParts.join(" ");
    await saveConfig(cfg);
    console.log(`Set ${key}.`);
    return;
  }
  if (sub === "unset") {
    if (!key) throw new Error("Usage: config unset <key>");
    delete cfg[key];
    await saveConfig(cfg);
    console.log(`Unset ${key}.`);
    return;
  }
  throw new Error(`Unknown config command: ${sub}`);
}

async function keyCommand(rest) {
  const [sub] = rest;
  const cfg = loadConfig();
  if (sub === "clear") {
    cfg.runtimeKey = "";
    await saveConfig(cfg);
    console.log("Cleared saved runtime key.");
    return;
  }
  if (sub === "set") {
    const rl = createInterface({ input, output });
    try {
      console.log("Warning: the universal CLI stores this key in a local config file, not DPAPI.");
      cfg.runtimeKey = await promptSecretUpdate(rl, "Runtime API key", cfg.runtimeKey);
      await saveConfig(cfg);
      console.log("Saved runtime key.");
    } finally {
      rl.close();
    }
    return;
  }
  throw new Error("Usage: key set|clear");
}

function openUrl(url) {
  const command =
    process.platform === "win32" ? "cmd" :
      process.platform === "darwin" ? "open" :
        "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] :
      [url];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === "help") return usage();
  if (command === "setup" || command === "init") return setup(flags);
  if (command === "install") return installDeps(effectiveOptions(flags));
  if (command === "start") return start(flags);
  if (command === "stop") return stop(flags);
  if (command === "status") return status(flags);
  if (command === "doctor") return doctor(flags);
  if (command === "profile") {
    const opts = effectiveOptions(flags);
    validate(opts);
    console.log(writeTunnelProfile(opts));
    return;
  }
  if (command === "url") {
    const opts = effectiveOptions(flags);
    console.log(`http://127.0.0.1:${opts.port}/mcp`);
    return;
  }
  if (command === "open") {
    const opts = effectiveOptions(flags);
    openUrl(`http://127.0.0.1:${opts.dashboardPort}/ui`);
    return;
  }
  if (command === "logs") {
    console.log(LOG_PATH);
    if (existsSync(LOG_PATH)) console.log(await readFile(LOG_PATH, "utf8"));
    return;
  }
  if (command === "config") return configCommand(rest);
  if (command === "key") return keyCommand(rest);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message || error}`);
  process.exit(1);
});
