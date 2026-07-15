#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const SETUP_WIZARD_REPORT = join(REPO_ROOT, "setup-wizard-report.txt");
const REPO_URL = "https://github.com/LongNgn204/local-coding-agent";
const RELEASE_VERSION = "4.4.3-prodev";

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
  node scripts/local-coding-agent.mjs update
  node scripts/local-coding-agent.mjs support
  node scripts/local-coding-agent.mjs setup-wizard [options]
  node scripts/local-coding-agent.mjs prompt setup|update|diagnose
  node scripts/local-coding-agent.mjs skills list|json|validate|doctor

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
  --force                     With update, continue even when local changes exist
  --no-open-web-ui            Do not pass --open-web-ui to tunnel-client

Fast path:
  scripts\\lca.cmd setup       # Windows
  bash scripts/lca setup       # macOS/Linux
  node scripts/local-coding-agent.mjs setup
  node scripts/local-coding-agent.mjs setup-wizard --workspace "C:\\path\\repo"
  node scripts/local-coding-agent.mjs prompt setup

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
      case "--force":
        flags.force = true;
        break;
      case "--no-open-web-ui":
        flags.openWebUi = false;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--role":
        flags.role = next();
        break;
      case "--task":
        flags.task = next();
        break;
      case "--engine":
        flags.engine = next();
        break;
      case "--status":
        flags.status = next();
        break;
      case "--days":
        flags.days = next();
        break;
      case "--dry-run":
        flags.dryRun = true;
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
  delete out.force;
  return out;
}

async function installDeps(opts) {
  const npm = npmCommand(["install"]);
  const child = spawnLogged("install", npm.command, npm.args, { cwd: SERVER_DIR });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) throw new Error(`npm install failed with exit code ${code}`);
  console.log("Install complete.");
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function npmCommand(args) {
  if (process.platform !== "win32") return { command: "npm", args };
  return { command: "cmd.exe", args: ["/d", "/s", "/c", ["npm", ...args].map(quoteCmdArg).join(" ")] };
}

async function runChecked(label, command, args, options = {}) {
  const child = spawnLogged(label, command, args, options);
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function capture(command, args, options = {}) {
  return new Promise((resolveCapture) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolveCapture({ code: -1, signal: null, stdout, stderr: error?.message || String(error) });
      return;
    }
    child.on("error", (error) => resolveCapture({ code: -1, signal: null, stdout, stderr: error?.message || String(error) }));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code, signal) => resolveCapture({ code, signal, stdout, stderr }));
  });
}

async function updateSelf(flags) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const before = await capture(git, ["status", "--short", "--branch"], { cwd: REPO_ROOT });
  if (before.code !== 0) throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  console.log(before.stdout.trim() || "working tree clean");
  const dirtyLines = before.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith("##"));
  if (dirtyLines.length && !flags.force) {
    throw new Error("Local changes detected. Review them first, then rerun with --force only if you want to proceed.");
  }
  await runChecked("git", git, ["fetch", "origin", "main", "--tags"], { cwd: REPO_ROOT });
  const incoming = await capture(git, ["log", "--oneline", "--decorate", "--max-count=10", "HEAD..origin/main"], { cwd: REPO_ROOT });
  if (incoming.stdout.trim()) {
    console.log("\nIncoming changes:");
    console.log(incoming.stdout.trim());
  } else {
    console.log("\nAlready up to date with origin/main.");
  }
  await runChecked("git", git, ["pull", "--ff-only", "origin", "main"], { cwd: REPO_ROOT });
  await installDeps(effectiveOptions(flags));
  await runChecked("check", process.execPath, ["--check", join(SCRIPT_DIR, "local-coding-agent.mjs")], { cwd: REPO_ROOT });
  await runChecked("check", process.execPath, ["--check", join(SCRIPT_DIR, "network-doctor.mjs")], { cwd: REPO_ROOT });
  await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
  await doctor(flags);
  console.log("\nUpdate complete.");
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

function customerPrompt(kind, opts = {}) {
  const workspace = opts.workspace || "<ask the user for the workspace path>";
  const dashboard = `http://127.0.0.1:${opts.dashboardPort || "8790"}/ui`;
  const mcp = `http://127.0.0.1:${opts.port || "8787"}/mcp`;
  const commonRules = [
    "- Read AGENTS.md first and follow it exactly.",
    "- Do not install system dependencies without asking me first.",
    "- Do not download, commit, or redistribute tunnel-client; I will provide it if needed.",
    "- Do not commit secrets, API keys, tunnel IDs, local config, generated profiles, reports, or server/data.",
    "- Default to AGENT_MODE=safe and AGENT_POLICY=balanced.",
    "- Prefer the universal CLI before manual commands.",
    "- If output is long, summarize it and save/report the file path instead of pasting everything.",
    "- Do not paste full logs, diffs, base64, image/icon inventories, or generated reports into chat; use line ranges, globs, max_chars/max_output_chars, and local report files."
  ].join("\n");

  if (kind === "setup") {
    return `Please install and verify Local Coding Agent for me.

Repository:
${REPO_URL}

Target workspace:
${workspace}

Rules:
${commonRules}

Steps:
1. Clone the repo if it is not already cloned.
2. Enter the repo and read AGENTS.md.
3. Check Node.js >= 18 with: node -v
4. Install repo dependencies:
   - Windows: scripts\\lca.cmd install
   - macOS/Linux: bash scripts/lca install
5. Run the setup wizard/report:
   node scripts/local-coding-agent.mjs setup-wizard --workspace "${workspace}"
6. If the report says dependencies/config are missing, fix only the missing items and explain them to me first.
7. Start local server only for verification:
   node scripts/local-coding-agent.mjs start --workspace "${workspace}" --no-tunnel
8. Verify:
   - ${mcp}
   - ${dashboard}
   - http://127.0.0.1:${opts.port || "8787"}/healthz returns status ok
   - npm --prefix server run test:agent
9. Tell me the MCP URL, dashboard URL, workspace path, mode, policy, release version, and any failed check.
10. Keep the final answer concise and include exact next commands.`;
  }

  if (kind === "update") {
    return `Please update my existing Local Coding Agent clone safely.

Repository:
${REPO_URL}

Rules:
${commonRules}

Steps:
1. Enter the existing local-coding-agent repo.
2. Read AGENTS.md and inspect git status first.
3. Preserve my local config, tunnel-client, tools/profiles, .env files, reports, and server/data.
4. Fetch the latest main/tags.
5. If there are local changes, summarize them and ask before overwriting anything.
6. Run the guarded update flow:
   node scripts/local-coding-agent.mjs update
7. Run:
   node scripts/local-coding-agent.mjs skills validate
   node scripts/local-coding-agent.mjs skills doctor
   node scripts/local-coding-agent.mjs setup-wizard
8. Verify healthz reports version ${RELEASE_VERSION} or newer.
9. Explain what changed, what passed, what failed, and the exact next command to fix failures.`;
  }

  if (kind === "diagnose") {
    return `Please diagnose this Local Coding Agent install and produce a safe support report.

Repository:
${REPO_URL}

Rules:
${commonRules}

Steps:
1. Enter the local-coding-agent repo and read AGENTS.md.
2. Do not paste secrets, full tokens, tunnel IDs, API keys, or private customer data.
3. Run:
   node scripts/local-coding-agent.mjs status
   node scripts/local-coding-agent.mjs doctor
   node scripts/local-coding-agent.mjs skills doctor
   node scripts/local-coding-agent.mjs setup-wizard
   node scripts/local-coding-agent.mjs support
4. If the issue is network/tunnel related, also run:
   node scripts/network-doctor.mjs
5. Send me only:
   - short diagnosis
   - likely root cause
   - exact failed checks
   - paths to generated report files
   - next commands to fix it
6. Keep raw logs local unless I explicitly ask for a small excerpt.`;
  }

  throw new Error("Usage: prompt setup|update|diagnose");
}

function printPrompt(kind, flags = {}) {
  const opts = effectiveOptions(flags);
  console.log(customerPrompt(kind, opts));
}

function skillDoctorRows() {
  const skills = new Map(listRepoSkills().map((s) => [s.name, s]));
  const row = (symptom, skillName, command, why) => ({
    symptom,
    skill: skillName,
    available: skills.has(skillName),
    command,
    why
  });
  return [
    row("Fresh install, Node/npm/setup confusion", "setup-assistant", "node scripts/local-coding-agent.mjs prompt setup", "Guides install, safe defaults, health checks, and dashboard verification."),
    row("Existing clone needs safe update", "update-local-coding-agent", "node scripts/local-coding-agent.mjs prompt update", "Preserves config, tunnel-client, secrets, and local customer files."),
    row("Customer reports broken install", "customer-doctor", "node scripts/local-coding-agent.mjs prompt diagnose", "Collects redacted diagnostics and support files customers can send back."),
    row("Tunnel, proxy, DNS, TLS, or office network blocked", "debug-tunnel-network", "node scripts/network-doctor.mjs", "Focuses on tunnel/network phases and avoids leaking runtime keys."),
    row("ChatGPT Web lag, repeated tool calls, large_payloads, base64/icon inventory output", "repo-support", "node scripts/local-coding-agent.mjs prompt diagnose", "Switches to targeted ranges/globs and local reports instead of long pasted output."),
    row("Need quick repo understanding with less ChatGPT lag", "repo-support", "node scripts/local-coding-agent.mjs skills list", "Uses snapshot/search/read_many/report workflow instead of long pasted output."),
    row("Preparing a release build", "release-helper", "node scripts/local-coding-agent.mjs skills doctor", "Checks versions, changelog, CI, release notes, and release gates."),
    row("Security-sensitive code or permission change", "security-hardening-review", "npm --prefix server run test:hardening", "Reviews file access, commands, approvals, token redaction, and tunnel exposure."),
    row("Need to create or improve a project skill", "skill-creator", "node scripts/validate-skills.mjs", "Keeps skill frontmatter, trigger conditions, and validation clean."),
    row("Review current code diff before finishing", "code-review", "git diff --stat", "Prioritizes bugs, security issues, regressions, and missing tests.")
  ];
}

function printSkillsDoctor(flags = {}) {
  const rows = skillDoctorRows();
  if (flags.json) {
    console.log(JSON.stringify({ release_version: RELEASE_VERSION, rows }, null, 2));
    return;
  }
  console.log(`Local Coding Agent Skills Doctor (${RELEASE_VERSION})`);
  console.log("Pick the row that matches the customer's symptom, then load/read that skill in the AI agent.\n");
  for (const r of rows) {
    const status = r.available ? "OK " : "MISS";
    console.log(`${status} ${r.symptom}`);
    console.log(`    skill:   ${r.skill}`);
    console.log(`    command: ${r.command}`);
    console.log(`    why:     ${r.why}`);
  }
}

async function setupWizard(flags) {
  const opts = effectiveOptions(flags);
  const checks = [];
  const add = (name, ok, detail = "", fix = "") => checks.push({ name, ok, detail, fix });
  const nodeMajor = Number(String(process.versions.node || "0").split(".")[0]);
  const gitBin = process.platform === "win32" ? "git.exe" : "git";
  const npmCmd = npmCommand(["--version"]);
  const npm = await capture(npmCmd.command, npmCmd.args, { cwd: REPO_ROOT });
  const git = await capture(gitBin, ["--version"], { cwd: REPO_ROOT });
  const skills = await capture(process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
  const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);

  add("Node.js >= 18", nodeMajor >= 18, process.version, "Install Node.js LTS from https://nodejs.org then rerun install.");
  add("npm available", npm.code === 0, (npm.stdout || npm.stderr).trim(), "Install Node.js LTS; npm ships with Node.");
  add("git available", git.code === 0, (git.stdout || git.stderr).trim(), "Install Git and reopen the terminal.");
  add("repo root", existsSync(join(REPO_ROOT, "AGENTS.md")), REPO_ROOT, "Run this command from the local-coding-agent repo.");
  add("server package", existsSync(join(SERVER_DIR, "package.json")), join(SERVER_DIR, "package.json"), "Restore the repo or reclone it.");
  add("server dependencies", existsSync(join(SERVER_DIR, "node_modules")), join(SERVER_DIR, "node_modules"), "Run: node scripts/local-coding-agent.mjs install");
  add("workspace configured", Boolean(opts.workspace), opts.workspace || "(not set)", "Pass --workspace <path> or run setup.");
  add("workspace exists", Boolean(opts.workspace && existsSync(opts.workspace)), opts.workspace || "(not set)", "Create the workspace folder or choose an existing repo.");
  add("policy valid", ["strict", "balanced", "full"].includes(opts.policy), opts.policy, "Use --policy balanced for customers.");
  add("mode valid", ["safe", "full"].includes(opts.mode), opts.mode, "Use --mode safe for customers.");
  add("tunnel-client", opts.noTunnel || existsSync(opts.tunnelBin), opts.noTunnel ? "disabled by --no-tunnel/config" : opts.tunnelBin, "Place proprietary tunnel-client in tools/ or pass --tunnel-bin.");
  add("runtime key", opts.noTunnel || Boolean(process.env[opts.runtimeKeyEnv] || opts.runtimeKey), opts.noTunnel ? "disabled by --no-tunnel/config" : opts.runtimeKeyEnv, "Set the runtime key env var only when starting the tunnel.");
  add("skills validate", skills.code === 0, skills.code === 0 ? "12 skills checked" : (skills.stdout + skills.stderr).trim().slice(0, 800), "Run: node scripts/validate-skills.mjs and fix reported skill files.");
  add("server health", Boolean(health), health ? `${health.version} pid=${health.pid || "?"}` : "offline", `Start: node scripts/local-coding-agent.mjs start --workspace "${opts.workspace || "<path>"}" --no-tunnel`);

  const failed = checks.filter((c) => !c.ok);
  const lines = [
    `Local Coding Agent setup wizard report`,
    `Generated: ${new Date().toISOString()}`,
    `Release target: ${RELEASE_VERSION}`,
    `Repo: ${REPO_ROOT}`,
    `Config: ${CONFIG_PATH}`,
    `MCP URL: http://127.0.0.1:${opts.port}/mcp`,
    `Dashboard: http://127.0.0.1:${opts.dashboardPort}/ui`,
    `Workspace: ${opts.workspace || "(not set)"}`,
    `Mode/policy: ${opts.mode}/${opts.policy}`,
    "",
    "Checks:"
  ];
  for (const c of checks) {
    lines.push(`${c.ok ? "OK " : "ERR"} ${c.name}: ${c.detail || ""}`);
    if (!c.ok && c.fix) lines.push(`    fix: ${c.fix}`);
  }
  lines.push("");
  lines.push(failed.length ? `Result: ${failed.length} issue(s) need attention.` : "Result: ready for local verification.");
  lines.push("");
  lines.push("Recommended AI prompt:");
  lines.push(customerPrompt(failed.length ? "diagnose" : "setup", opts));
  const report = `${lines.join("\n")}\n`;
  writeFileSync(SETUP_WIZARD_REPORT, report, "utf8");
  console.log(report);
  console.log(`Report written: ${SETUP_WIZARD_REPORT}`);
  if (failed.length) process.exitCode = 1;
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

function parseSkillMeta(text, fallbackName) {
  const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
  let name = fallbackName;
  let description = "";
  if (fm) {
    const block = fm[1];
    name = (block.match(/^\s*name\s*:\s*(.+?)\s*$/im)?.[1] || fallbackName).replace(/^["']|["']$/g, "").trim();
    description = (block.match(/^\s*description\s*:\s*(.+?)\s*$/im)?.[1] || "").replace(/^["']|["']$/g, "").trim();
  }
  return { name, description };
}

function readSkillManifest(dir) {
  // Optional skill.json manifest alongside SKILL.md.
  const file = join(dir, "skill.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { error: "invalid skill.json" };
  }
}

function listRepoSkills() {
  const skillsDir = join(REPO_ROOT, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(skillsDir, entry.name);
      const file = join(dir, "SKILL.md");
      const manifest = readSkillManifest(dir);
      if (!existsSync(file)) return { folder: entry.name, name: entry.name, description: "(missing SKILL.md)", manifest };
      const meta = parseSkillMeta(readFileSync(file, "utf8"), entry.name);
      return { folder: entry.name, ...meta, manifest };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function skillsCommand(rest, flags = {}) {
  const [sub = "list"] = rest;
  if (sub === "list") {
    for (const skill of listRepoSkills()) {
      const ver = skill.manifest && skill.manifest.version ? ` [v${skill.manifest.version}]` : "";
      console.log(`${skill.name}${ver} - ${skill.description}`);
    }
    return;
  }
  if (sub === "json") {
    // Machine-readable manifest dump for AI setup/update tooling.
    const skills = listRepoSkills().map((s) => ({
      name: s.name,
      folder: s.folder,
      description: s.description,
      manifest: s.manifest || null
    }));
    console.log(JSON.stringify({ count: skills.length, skills }, null, 2));
    return;
  }
  if (sub === "validate") {
    await runChecked("skills", process.execPath, [join(SCRIPT_DIR, "validate-skills.mjs")], { cwd: REPO_ROOT });
    return;
  }
  if (sub === "doctor") {
    printSkillsDoctor(flags);
    return;
  }
  throw new Error("Usage: skills list|json|validate|doctor");
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
  if (command === "setup-wizard" || command === "wizard") return setupWizard(flags);
  if (command === "prompt" || command === "prompts") {
    const [kind = "setup"] = rest;
    return printPrompt(kind, flags);
  }
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
  if (command === "update") return updateSelf(flags);
  if (command === "support" || command === "report") {
    const opts = effectiveOptions(flags);
    const args = ["--port", String(opts.port), "--dashboard-port", String(opts.dashboardPort)];
    return runChecked("support", process.execPath, [join(SCRIPT_DIR, "support-report.mjs"), ...args], { cwd: REPO_ROOT });
  }
  if (command === "network" || command === "netdoctor") {
    return runChecked("network", process.execPath, [join(SCRIPT_DIR, "network-doctor.mjs"), ...rest], { cwd: REPO_ROOT });
  }
  if (command === "skills") return skillsCommand(rest, flags);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message || error}`);
  process.exit(1);
});
