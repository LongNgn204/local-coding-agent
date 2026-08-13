#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = join(REPO_ROOT, "network-doctor-report.txt");
const DEFAULT_HOSTS = [
  "api.openai.com",
  "chatgpt.com",
  "auth.openai.com",
  "cdn.openai.com"
];

function usage() {
  console.log(`Local Coding Agent network doctor

Usage:
  node scripts/network-doctor.mjs [options]

Options:
  --out <file>                Report path (default: network-doctor-report.txt)
  --host <hostname>           Extra hostname to test; can be repeated
  --mcp-url <url>             Local MCP URL to test (default: http://127.0.0.1:8787/mcp)
  --health-url <url>          Local health URL (default: http://127.0.0.1:8787/healthz)
  --dashboard-url <url>       Local dashboard URL (default: http://127.0.0.1:8790/ui)
  --tunnel-bin <path>         Optional tunnel-client(.exe) path
  --tunnel-id <id>            Optional tunnel ID for a short tunnel smoke test
  --organization-id <id>      Optional OpenAI organization ID/header
  --runtime-key-env <name>    Env var containing Runtime API key (default: CONTROL_PLANE_API_KEY)
  --runtime-key <key>         Runtime key for this run only; redacted from report
  --duration <seconds>        Tunnel smoke duration (default: 20)
  --no-tunnel-smoke           Skip tunnel-client smoke test

Examples:
  node scripts/network-doctor.mjs
  node scripts/network-doctor.mjs --tunnel-bin tools\\tunnel-client.exe --tunnel-id tunnel_abc123
  $env:CONTROL_PLANE_API_KEY="sk-proj-..."
  node scripts/network-doctor.mjs --tunnel-bin tools\\tunnel-client.exe --tunnel-id tunnel_abc123 --duration 30
`);
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    hosts: [...DEFAULT_HOSTS],
    healthUrl: "http://127.0.0.1:8787/healthz",
    dashboardUrl: "http://127.0.0.1:8790/ui",
    mcpUrl: "http://127.0.0.1:8787/mcp",
    tunnelBin: "",
    tunnelId: "",
    organizationId: "",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    runtimeKey: "",
    duration: 20,
    tunnelSmoke: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--out":
        opts.out = next();
        break;
      case "--host":
        opts.hosts.push(next());
        break;
      case "--mcp-url":
        opts.mcpUrl = next();
        break;
      case "--health-url":
        opts.healthUrl = next();
        break;
      case "--dashboard-url":
        opts.dashboardUrl = next();
        break;
      case "--tunnel-bin":
        opts.tunnelBin = next();
        break;
      case "--tunnel-id":
        opts.tunnelId = next();
        break;
      case "--organization-id":
        opts.organizationId = next();
        break;
      case "--runtime-key-env":
        opts.runtimeKeyEnv = next();
        break;
      case "--runtime-key":
        opts.runtimeKey = next();
        break;
      case "--duration":
        opts.duration = Number(next());
        break;
      case "--no-tunnel-smoke":
        opts.tunnelSmoke = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.hosts = [...new Set(opts.hosts.map((h) => h.trim()).filter(Boolean))];
  if (!Number.isFinite(opts.duration) || opts.duration < 5 || opts.duration > 120) opts.duration = 20;
  return opts;
}

function redact(value) {
  let text = String(value ?? "");
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  text = text.replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-<redacted>");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>");
  text = text.replace(/CONTROL_PLANE_API_KEY=([^\s"]+)/g, "CONTROL_PLANE_API_KEY=<redacted>");
  text = text.replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"<redacted>"');
  text = text.replace(/api_key:\s*"[^"]+"/g, 'api_key: "<redacted>"');
  text = text.replace(/(authorization:\s*)[^\r\n]+/gi, "$1<redacted>");
  text = text.replace(/(runtime[-_ ]?api[-_ ]?key[:=]\s*)[^\s"]+/gi, "$1<redacted>");
  return text;
}

function now() {
  return new Date().toISOString();
}

async function timed(name, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - start, ...value };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      error: error?.code || error?.name || "ERROR",
      message: error?.message || String(error)
    };
  }
}

async function dnsTest(host) {
  return timed(`dns:${host}`, async () => {
    const records = await dns.lookup(host, { all: true });
    return { addresses: records.map((r) => `${r.address}/${r.family}`).slice(0, 12) };
  });
}

async function tcpTest(host, port = 443) {
  return timed(`tcp:${host}:${port}`, () => new Promise((resolveTest, rejectTest) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    socket.once("connect", () => {
      socket.destroy();
      resolveTest({ remote: `${host}:${port}` });
    });
    socket.once("timeout", () => {
      socket.destroy();
      rejectTest(new Error("TCP timeout"));
    });
    socket.once("error", rejectTest);
  }));
}

async function tlsTest(host, port = 443) {
  return timed(`tls:${host}:${port}`, () => new Promise((resolveTest, rejectTest) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      ALPNProtocols: ["h2", "http/1.1"],
      timeout: 7000
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const protocol = socket.alpnProtocol || "none";
      socket.destroy();
      resolveTest({
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || "",
        alpn: protocol,
        certificate: {
          subject: cert?.subject?.CN || "",
          issuer: cert?.issuer?.CN || cert?.issuer?.O || "",
          valid_to: cert?.valid_to || ""
        }
      });
    });
    socket.once("timeout", () => {
      socket.destroy();
      rejectTest(new Error("TLS timeout"));
    });
    socket.once("error", rejectTest);
  }));
}

async function requestTest(url, { method = "GET", headers = {}, timeout = 8000 } = {}) {
  return timed(`http:${method}:${url}`, () => new Promise((resolveTest, rejectTest) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method, headers, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 2000) body += chunk;
      });
      res.on("end", () => {
        resolveTest({
          status: res.statusCode,
          statusMessage: res.statusMessage,
          headers: pickHeaders(res.headers),
          body_sample: redact(body.slice(0, 500))
        });
      });
    });
    req.once("timeout", () => {
      req.destroy(new Error("HTTP timeout"));
    });
    req.once("error", rejectTest);
    req.end();
  }));
}

function pickHeaders(headers) {
  const names = ["content-type", "server", "date", "cf-ray", "openai-processing-ms", "x-request-id"];
  const out = {};
  for (const name of names) {
    if (headers[name]) out[name] = headers[name];
  }
  return out;
}

function writeTunnelProfile(opts, dir) {
  mkdirSync(dir, { recursive: true });
  const profile = "network-doctor";
  const profilePath = join(dir, `${profile}.yaml`);
  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${yamlEscape(opts.tunnelId)}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"'
  ];
  if (opts.organizationId) {
    lines.push("  extra_headers:");
    lines.push(`    - "OpenAI-Organization: ${yamlEscape(opts.organizationId)}"`);
  }
  lines.push(
    "health:",
    `  listen_addr: "127.0.0.1:${randomPort()}"`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: debug",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "${yamlEscape(opts.mcpUrl)}"`
  );
  writeFileSync(profilePath, `${lines.join("\n")}\n`, "utf8");
  return { profile, profilePath };
}

function yamlEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function randomPort() {
  return 18000 + Math.floor(Math.random() * 30000);
}

async function tunnelSmoke(opts) {
  if (!opts.tunnelSmoke) return { skipped: true, reason: "--no-tunnel-smoke" };
  if (!opts.tunnelBin || !opts.tunnelId) return { skipped: true, reason: "missing --tunnel-bin or --tunnel-id" };
  if (!existsSync(opts.tunnelBin)) return { skipped: true, reason: `tunnel binary not found: ${opts.tunnelBin}` };
  const runtimeKey = opts.runtimeKey || process.env[opts.runtimeKeyEnv];
  if (!runtimeKey) return { skipped: true, reason: `missing runtime key env ${opts.runtimeKeyEnv}` };

  const tempDir = join(os.tmpdir(), `lca-network-doctor-${randomUUID()}`);
  const { profile } = writeTunnelProfile(opts, tempDir);
  const args = [
    "run",
    "--profile",
    profile,
    "--profile-dir",
    tempDir,
    "--control-plane.tunnel-id",
    opts.tunnelId
  ];
  const env = {
    ...process.env,
    CONTROL_PLANE_API_KEY: runtimeKey,
    CONTROL_PLANE_TUNNEL_ID: opts.tunnelId
  };
  return timed("tunnel-smoke", () => new Promise((resolveTest) => {
    let stdout = "";
    let stderr = "";
    let terminatedByDoctor = false;
    const child = spawn(opts.tunnelBin, args, {
      cwd: dirname(resolve(opts.tunnelBin)),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const collect = (stream, setter) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        setter(chunk);
      });
    };
    collect(child.stdout, (chunk) => { stdout += chunk; stdout = stdout.slice(-12000); });
    collect(child.stderr, (chunk) => { stderr += chunk; stderr = stderr.slice(-12000); });

    const timer = setTimeout(() => {
      terminatedByDoctor = true;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          child.kill("SIGTERM");
        }
      } catch { /* ignore */ }
    }, opts.duration * 1000);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      const raw = `${stdout}\n${stderr}`;
      const status = summarizeTunnelLog(raw);
      resolveTest({
        exit_code: code,
        signal: signal || "",
        duration_seconds: opts.duration,
        terminated_by_doctor: terminatedByDoctor,
        ...status,
        diagnosis_hints: diagnoseTunnelLog(raw),
        log_tail: redact(raw).split(/\r?\n/).filter(Boolean).slice(-80)
      });
    });
  }));
}

function diagnoseTunnelLog(raw) {
  const text = raw.toLowerCase();
  const hints = [];
  if (text.includes("forcibly closed") || text.includes("econnreset") || text.includes("connection reset")) {
    hints.push("Connection reset/forcibly closed: likely firewall, proxy, TLS inspection, or remote policy closing long-lived tunnel traffic.");
  }
  if (text.includes("poll failed") || text.includes("backing off")) {
    hints.push("Tunnel polling failed and backed off: network path to the control plane is unstable or blocked.");
  }
  if (/\b503\b/.test(text) && (text.includes("upstream connect error") || text.includes("reset before headers") || text.includes("connection termination"))) {
    hints.push("Control plane returned HTTP 503 before response headers. The tunnel is already retrying; one isolated event is usually transient upstream, while repeated events indicate an unstable or filtered network path.");
  }
  if (text.includes("tunnel_active_organization_required")) {
    hints.push("Organization header is required. Provide --organization-id for the OpenAI organization that owns the tunnel.");
  }
  if (text.includes("certificate") || text.includes("unable to verify") || text.includes("self signed")) {
    hints.push("Certificate/TLS verification issue: corporate SSL inspection or custom CA may be interfering.");
  }
  if (/\b(?:proxyconnect|proxy error|proxy authentication|proxy required|using proxy|http_proxy|https_proxy)\b|\b407\b/.test(text)) {
    hints.push("An explicit proxy setting or proxy error was detected. Check HTTP_PROXY/HTTPS_PROXY and corporate proxy policy.");
  }
  if (text.includes("enotfound") || text.includes("getaddrinfo")) {
    hints.push("DNS lookup failure: corporate DNS may block or misresolve the endpoint.");
  }
  if (/\b401\b|\bunauthorized\b/.test(text)) {
    hints.push("Authentication failed: check Runtime API key, not Admin key.");
  }
  if (/\b403\b|\bforbidden\b/.test(text)) {
    hints.push("Forbidden: check organization/project access or network policy.");
  }
  return hints;
}

function summarizeTunnelLog(raw) {
  const text = raw.toLowerCase();
  const mcpInitialized = text.includes("mcp session initialized");
  const metadataFetched = text.includes("tunnel metadata fetched");
  const pollSucceeded = text.includes("poll cycle complete");
  const pollFailed = text.includes("poll failed") || text.includes("backing off");
  let smokeStatus = "started";
  if (pollSucceeded && mcpInitialized) smokeStatus = "connected";
  else if (metadataFetched || pollSucceeded) smokeStatus = "control-plane-reachable";
  else if (pollFailed) smokeStatus = "blocked";
  else if (mcpInitialized) smokeStatus = "local-mcp-only";

  return {
    smoke_status: smokeStatus,
    mcp_initialized: mcpInitialized,
    control_plane_reachable: metadataFetched || pollSucceeded,
    metadata_fetched: metadataFetched,
    poll_succeeded: pollSucceeded,
    poll_failed: pollFailed
  };
}

function envSummary(opts) {
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const proxies = {};
  for (const key of proxyKeys) {
    if (process.env[key]) proxies[key] = redact(process.env[key]);
  }
  return {
    timestamp: now(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: process.version,
    cwd: process.cwd(),
    repo_root: REPO_ROOT,
    runtime_key_env: opts.runtimeKeyEnv,
    runtime_key_present: Boolean(opts.runtimeKey || process.env[opts.runtimeKeyEnv]),
    proxy_env: proxies
  };
}

function renderReport(report) {
  const lines = [];
  lines.push("# Local Coding Agent Network Doctor Report");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Generated: ${report.env.timestamp}`);
  lines.push(`- Platform: ${report.env.platform} ${report.env.arch} ${report.env.release}`);
  lines.push(`- Node: ${report.env.node}`);
  lines.push(`- Runtime key present: ${report.env.runtime_key_present ? "yes" : "no"}`);
  lines.push(`- Proxy env present: ${Object.keys(report.env.proxy_env).length ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Quick Diagnosis");
  lines.push("");
  for (const item of report.quickDiagnosis) lines.push(`- ${item}`);
  if (!report.quickDiagnosis.length) lines.push("- No obvious blocker detected from these checks.");
  lines.push("");
  lines.push("## Results JSON");
  lines.push("");
  lines.push("```json");
  lines.push(redact(JSON.stringify(report, null, 2)));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function quickDiagnosis(results) {
  const hints = [];
  const network = Array.isArray(results.network) ? results.network : [];
  const httpResults = Array.isArray(results.http) ? results.http : [];
  const local = Array.isArray(results.local) ? results.local : [];
  const failedDns = network.filter((r) => r.name.startsWith("dns:") && !r.ok);
  const failedTcp = network.filter((r) => r.name.startsWith("tcp:") && !r.ok);
  const failedTls = network.filter((r) => r.name.startsWith("tls:") && !r.ok);
  const openaiHttp = httpResults.find((r) => r.name.includes("https://api.openai.com/v1/models"));
  const localHealth = local.find((r) => r.name.includes("/healthz"));
  const tunnelConnected = ["connected", "control-plane-reachable"].includes(results.tunnel?.smoke_status);
  const nodeTrustFailure = failedTls.length > 0 && failedTls.every((r) =>
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(r.error)
  );
  if (failedDns.length) hints.push(`DNS failures: ${failedDns.map((r) => r.name.replace("dns:", "")).join(", ")}.`);
  if (failedTcp.length) hints.push(`TCP 443 failures: ${failedTcp.map((r) => r.name.replace("tcp:", "")).join(", ")}.`);
  if (nodeTrustFailure && tunnelConnected) {
    hints.push("Tunnel connected successfully, but Node.js could not validate the local certificate issuer. The tunnel client and Node.js are using different CA trust stores.");
  } else if (failedTls.length) {
    hints.push(`TLS handshake failures: ${failedTls.map((r) => r.name.replace("tls:", "")).join(", ")}.`);
  }
  if (openaiHttp && !openaiHttp.ok && !(nodeTrustFailure && tunnelConnected)) {
    hints.push(`HTTPS request to OpenAI API failed: ${openaiHttp.error || ""} ${openaiHttp.message || ""}`.trim());
  }
  if (openaiHttp?.ok && [401, 403].includes(openaiHttp.status)) {
    hints.push(`OpenAI API was reachable but returned HTTP ${openaiHttp.status}; network path works, credentials/org may still need checking.`);
  } else if (openaiHttp?.ok && openaiHttp.status && openaiHttp.status < 500) {
    hints.push(`OpenAI API was reachable with HTTP ${openaiHttp.status}.`);
  }
  if (localHealth && !localHealth.ok) hints.push("Local MCP health endpoint is not reachable. Start the local server before testing tunnel end-to-end.");
  if (results.tunnel?.smoke_status === "connected") {
    hints.push("Tunnel smoke test connected: local MCP initialized, control-plane metadata loaded, and polling completed.");
  }
  const tunnelHints = results.tunnel?.diagnosis_hints || [];
  hints.push(...tunnelHints);
  return [...new Set(hints)];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const report = {
    env: envSummary(opts),
    options: {
      out: opts.out,
      hosts: opts.hosts,
      healthUrl: opts.healthUrl,
      dashboardUrl: opts.dashboardUrl,
      mcpUrl: opts.mcpUrl,
      tunnelBin: opts.tunnelBin || "",
      tunnelBinExists: opts.tunnelBin ? existsSync(opts.tunnelBin) : false,
      tunnelIdPresent: Boolean(opts.tunnelId),
      organizationIdPresent: Boolean(opts.organizationId),
      tunnelSmoke: opts.tunnelSmoke,
      duration: opts.duration
    },
    network: [],
    http: [],
    local: [],
    tunnel: null,
    quickDiagnosis: []
  };

  for (const host of opts.hosts) {
    report.network.push(await dnsTest(host));
    report.network.push(await tcpTest(host, 443));
    report.network.push(await tlsTest(host, 443));
  }

  const auth = opts.runtimeKey || process.env[opts.runtimeKeyEnv];
  const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
  report.http.push(await requestTest("https://api.openai.com/v1/models", { headers }));
  report.http.push(await requestTest("https://chatgpt.com/", { method: "HEAD" }));
  report.local.push(await requestTest(opts.healthUrl));
  report.local.push(await requestTest(opts.dashboardUrl, { method: "HEAD" }));
  report.tunnel = await tunnelSmoke(opts);
  report.quickDiagnosis = quickDiagnosis(report);

  const output = renderReport(report);
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, output, "utf8");
  console.log(`Network doctor report written to: ${resolve(opts.out)}`);
  for (const line of report.quickDiagnosis) console.log(`- ${line}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}

export { diagnoseTunnelLog, quickDiagnosis, summarizeTunnelLog };
