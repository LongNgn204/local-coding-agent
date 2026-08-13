#!/usr/bin/env node
// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Customer support report.
// Produces a compact, REDACTED diagnostic bundle a customer can send back to
// the developer. It never requires the proprietary tunnel client and never
// prints API keys, tokens, or tunnel ids.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = join(REPO_ROOT, "support-report.txt");

function usage() {
  console.log(`Local Coding Agent support report

Usage:
  node scripts/support-report.mjs [options]

Options:
  --out <file>            Report path (default: support-report.txt)
  --port <port>           MCP server port (default: 8787)
  --dashboard-port <port> Dashboard port (default: 8790)
  --json                  Print the JSON report to stdout as well

The report is redacted: API keys, bearer tokens, and tunnel ids are removed.
`);
}

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, port: 8787, dashboardPort: 8790, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true, opts };
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--dashboard-port") opts.dashboardPort = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
  }
  return { help: false, opts };
}

// Redact secrets before anything is written or printed.
function redact(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  text = text.replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-<redacted>");
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
  text = text.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh_<redacted>");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>");
  text = text.replace(/tunnel_[A-Za-z0-9]{12,}/g, "tunnel_<redacted>");
  text = text.replace(/(CONTROL_PLANE_API_KEY\s*[:=]\s*)[^\s"]+/gi, "$1<redacted>");
  text = text.replace(/(MCP_AUTH_TOKEN\s*[:=]\s*)[^\s"]+/gi, "$1<redacted>");
  text = text.replace(/("?(?:api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*")[^"]+(")/gi, "$1<redacted>$2");
  return text;
}

function readVersions() {
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(join(REPO_ROOT, "server", "package.json"), "utf8")).version || "unknown";
  } catch { /* ignore */ }
  return { version };
}

function tunnelClientStatus() {
  const candidates = [
    join(REPO_ROOT, "tools", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client")
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { present: true, path: p };
  }
  return { present: false, path: candidates[0], note: "expected - the proprietary tunnel client is not shipped with this repo" };
}

function portStatus(port) {
  return new Promise((done) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 800 }, () => {
      sock.destroy();
      done({ port, listening: true });
    });
    sock.on("error", () => done({ port, listening: false }));
    sock.on("timeout", () => { sock.destroy(); done({ port, listening: false }); });
  });
}

function httpGet(url) {
  return new Promise((done) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; if (body.length > 8000) req.destroy(); });
      res.on("end", () => done({ ok: true, status: res.statusCode, body: body.slice(0, 8000) }));
    });
    req.on("error", (e) => done({ ok: false, error: String(e.code || e.message) }));
    req.on("timeout", () => { req.destroy(); done({ ok: false, error: "timeout" }); });
  });
}

function recentErrors() {
  try {
    const metrics = JSON.parse(readFileSync(join(REPO_ROOT, "server", "data", "metrics.json"), "utf8"));
    return (metrics.recent || [])
      .filter((r) => !r.ok)
      .slice(0, 15)
      .map((r) => ({ tool: r.tool, at: r.ts || null, error: r.error || null }));
  } catch {
    return [];
  }
}

function proxyEnv() {
  const out = {};
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

async function main() {
  const { help, opts } = parseArgs(process.argv.slice(2));
  if (help) return usage();

  const versions = readVersions();
  const [port8787, portDash, port8788] = await Promise.all([
    portStatus(opts.port),
    portStatus(opts.dashboardPort),
    portStatus(8788)
  ]);
  const health = await httpGet(`http://127.0.0.1:${opts.port}/healthz`);
  const dashboard = await httpGet(`http://127.0.0.1:${opts.dashboardPort}/metrics`);

  let healthJson = null;
  if (health.ok) { try { healthJson = JSON.parse(health.body); } catch { /* ignore */ } }

  const report = {
    tool: "local-coding-agent support-report",
    generated_at: new Date().toISOString(),
    versions: {
      version: versions.version
    },
    runtime: {
      node: process.version,
      node_ok: Number(process.versions.node.split(".")[0]) >= 18,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname()
    },
    ports: {
      mcp_8787: port8787,
      dashboard_8790: portDash,
      tunnel_8788_reserved: port8788
    },
    health: health.ok
      ? { reachable: true, status: healthJson?.status || null, version: healthJson?.version || null, mode: healthJson?.mode || null }
      : { reachable: false, error: health.error },
    dashboard: { reachable: dashboard.ok, status: dashboard.status || null },
    tunnel_client: tunnelClientStatus(),
    recent_errors: recentErrors(),
    proxy_env: proxyEnv()
  };

  // Compact human summary.
  const summary = [];
  summary.push(`Local Coding Agent support report (v${report.versions.version})`);
  summary.push(`Node: ${report.runtime.node} (${report.runtime.node_ok ? "ok" : "TOO OLD - need >= 18"})  OS: ${report.runtime.platform} ${report.runtime.arch}`);
  summary.push(`MCP 8787: ${port8787.listening ? "listening" : "not listening"}   Dashboard 8790: ${portDash.listening ? "listening" : "not listening"}`);
  summary.push(`Health: ${report.health.reachable ? report.health.status + " (mode " + report.health.mode + ")" : "unreachable (" + report.health.error + ")"}`);
  summary.push(`Tunnel client: ${report.tunnel_client.present ? "present" : "not present (expected - customer supplies it)"}`);
  summary.push(`Recent errors: ${report.recent_errors.length}`);

  const text = [
    summary.join("\n"),
    "",
    "----- machine-readable (redacted) -----",
    redact(JSON.stringify(report, null, 2)),
    ""
  ].join("\n");

  const redactedText = redact(text);
  writeFileSync(opts.out, redactedText, "utf8");

  console.log(redact(summary.join("\n")));
  console.log("");
  console.log(`Full redacted report written to: ${opts.out}`);
  console.log("Send that file to the developer - it does not contain keys or tokens.");
  if (opts.json) console.log(redact(JSON.stringify(report, null, 2)));
}

main().catch((error) => {
  console.error(`ERROR: ${error?.message || error}`);
  process.exit(1);
});
