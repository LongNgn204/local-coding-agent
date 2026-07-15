// Local Coding Agent v4.1 hardening regression suite
// SPDX-License-Identifier: AGPL-3.0-or-later

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = path.resolve("server.mjs");
let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? `\n${detail}` : ""}`);
  }
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function startServer(workspace, { port, dashboardPort = 0, policy = "strict", auth = "", approvalToken = "", maxBody = "1048576" }) {
  await mkdir(workspace, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "safe",
      AGENT_POLICY: policy,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      MCP_AUTH_TOKEN: auth,
      AGENT_APPROVAL_TOKEN: approvalToken,
      AGENT_MAX_BODY_BYTES: maxBody
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.readStdout = () => stdout;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  return child;
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function connect(port) {
  const client = new Client({ name: "hardening-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content?.[0]?.text || "" };
}

function chunkedPost(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(body.slice(0, Math.floor(body.length / 2)));
    req.end(body.slice(Math.floor(body.length / 2)));
  });
}

const base = await mkdtemp(path.join(os.tmpdir(), "lca-hardening-"));
let server;
try {
  // Strict policy + browser-origin + body limit + latency telemetry.
  console.log("\n[phase] strict policy, origin, body limit, telemetry");
  server = await startServer(path.join(base, "strict"), { port: 19001, dashboardPort: 19002, policy: "strict", maxBody: "8192" });
  let logOffset = server.readStdout().length;
  await fetch("http://127.0.0.1:19001/healthz", {
    headers: {
      "user-agent": "LocalCodingAgentTray/4.4.3",
      "x-local-coding-agent-probe": "tray"
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("tray health probe does not flood request log", !server.readStdout().slice(logOffset).includes("GET /healthz"));

  logOffset = server.readStdout().length;
  await fetch("http://127.0.0.1:19001/healthz", { headers: { "user-agent": "manual-health-check" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("manual health check remains visible in request log", server.readStdout().slice(logOffset).includes("GET /healthz ua=manual-health-check"));

  const evil = await fetch("http://127.0.0.1:19001/mcp", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  check("browser Origin is denied by default", evil.status === 403, `status=${evil.status}`);

  const client = await connect(19001);
  check("strict policy blocks write_file", (await call(client, "write_file", { path: "blocked.txt", content: "x" })).isError);
  check("strict policy blocks compact_context local writes", (await call(client, "compact_context", { goal: "test", summary: "test" })).isError);
  check("strict policy allows context_status reads", !(await call(client, "context_status")).isError);
  check("strict policy allows resume_context reads", !(await call(client, "resume_context")).isError);
  check("strict policy blocks run_command", (await call(client, "run_command", { command: "node --version" })).isError);
  check("strict policy blocks run_commands", (await call(client, "run_commands", { commands: [{ command: "node --version" }] })).isError);
  await call(client, "workspace_info");
  await client.close();

  const metrics = await (await fetch("http://127.0.0.1:19002/metrics")).json();
  check("latency telemetry exposes avg/p50/p95/p99", ["avg_latency_ms", "p50_latency_ms", "p95_latency_ms", "p99_latency_ms"].every((k) => Number.isFinite(metrics[k])));
  check("chunked payload is size-limited", (await chunkedPost(19001, JSON.stringify({ data: "x".repeat(12000) }))) === 413);
  await stopServer(server);
  server = null;

  // Balanced policy approvals are decided out of band in the local dashboard.
  console.log("\n[phase] out-of-band one-time approvals");
  server = await startServer(path.join(base, "balanced"), { port: 19006, dashboardPort: 19007, policy: "balanced" });
  const balanced = await connect(19006);
  await call(balanced, "write_file", { path: "victim.txt", content: "x" });
  const blockedDelete = await call(balanced, "delete_path", { path: "victim.txt" });
  check("balanced policy blocks delete before approval", blockedDelete.isError && blockedDelete.text.includes("Approval required"));
  const blockedRiskyBatch = await call(balanced, "run_commands", {
    commands: [{ command: "curl -o downloaded.txt https://example.invalid" }]
  });
  check("balanced policy does not let run_commands bypass risky-command approval", blockedRiskyBatch.isError && blockedRiskyBatch.text.includes("Approval required"));
  const request = JSON.parse((await call(balanced, "request_approval", { action: "delete_path:victim.txt", reason: "hardening regression" })).text);
  const dashboardDecision = await fetch(`http://127.0.0.1:19007/api/approvals/${request.id}/approve`, { method: "POST" });
  check("local dashboard approves pending action", dashboardDecision.ok);
  check("approved action executes once", !(await call(balanced, "delete_path", { path: "victim.txt" })).isError);
  await call(balanced, "write_file", { path: "victim.txt", content: "x" });
  check("consumed approval cannot be replayed", (await call(balanced, "delete_path", { path: "victim.txt" })).isError);

  await call(balanced, "write_file", { path: "batch-a.txt", content: "a" });
  await call(balanced, "write_file", { path: "batch-b.txt", content: "b" });
  const batchRequest = JSON.parse((await call(balanced, "request_approval_batch", {
    actions: ["delete_path:batch-a.txt", "delete_path:batch-b.txt"],
    reason: "hardening exact batch regression",
    expires_in_minutes: 5
  })).text);
  const batchDecision = await fetch(`http://127.0.0.1:19007/api/approvals/${batchRequest.id}/approve`, { method: "POST" });
  check("dashboard approves exact action batch", batchDecision.ok);
  check("batch approval consumes first exact action", !(await call(balanced, "delete_path", { path: "batch-a.txt" })).isError);
  check("batch approval consumes second exact action", !(await call(balanced, "delete_path", { path: "batch-b.txt" })).isError);
  check("consumed batch action cannot be replayed", (await call(balanced, "delete_path", { path: "batch-a.txt" })).isError);

  const concurrentAction = "run_command:git fetch --dry-run";
  const concurrentRequest = JSON.parse((await call(balanced, "request_approval", {
    action: concurrentAction,
    reason: "concurrent consume regression"
  })).text);
  await fetch(`http://127.0.0.1:19007/api/approvals/${concurrentRequest.id}/approve`, { method: "POST" });
  const concurrentResults = await Promise.all([
    call(balanced, "run_command", { command: "git fetch --dry-run" }),
    call(balanced, "run_command", { command: "git fetch --dry-run" })
  ]);
  check("one-time approval remains one-time under concurrent calls", concurrentResults.filter((result) => result.isError).length === 1);
  const evilDashboard = await fetch(`http://127.0.0.1:19007/api/approvals/${request.id}/deny`, { method: "POST", headers: { Origin: "https://evil.example" } });
  check("dashboard rejects cross-origin decisions", evilDashboard.status === 403);
  await balanced.close();
  await stopServer(server);
  server = null;

  // MCP-token decisions must not revive consumed/denied requests or accept path-like ids.
  console.log("\n[phase] approval replay and id validation");
  const approvalSecret = `LCA_APPROVAL_SECRET_${Date.now()}`;
  server = await startServer(path.join(base, "approval-token"), { port: 19008, policy: "balanced", approvalToken: approvalSecret });
  const tokenClient = await connect(19008);
  const tokenRequest = JSON.parse((await call(tokenClient, "request_approval", { action: "delete_path:token.txt", reason: "token replay regression" })).text);
  check("MCP operator token approves a pending request", !(await call(tokenClient, "approve_request", { id: tokenRequest.id, approval_token: approvalSecret })).isError);
  check("MCP operator token cannot approve the same request twice", (await call(tokenClient, "approve_request", { id: tokenRequest.id, approval_token: approvalSecret })).isError);
  check("MCP approval rejects path-like ids", (await call(tokenClient, "approve_request", { id: "../outside", approval_token: approvalSecret })).isError);
  await tokenClient.close();
  await stopServer(server);
  server = null;
  const approvalAudit = await readFile(path.resolve("data", "audit.log"), "utf8").catch(() => "");
  check("audit log redacts approval_token", !approvalAudit.includes(approvalSecret));

  // Query-string tokens must not authenticate.
  console.log("\n[phase] header-only bearer authentication");
  server = await startServer(path.join(base, "auth"), { port: 19003, policy: "full", auth: "operator-secret" });
  const queryAuth = await fetch("http://127.0.0.1:19003/mcp?token=operator-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check("query-string bearer token is rejected", queryAuth.status === 401, `status=${queryAuth.status}`);
  await stopServer(server);
  server = null;

  // Undo must cover created files and renamed directories.
  const workspaceA = path.join(base, "workspace-a");
  console.log("\n[phase] transactional undo coverage");
  server = await startServer(workspaceA, { port: 19004, policy: "full" });
  const full = await connect(19004);
  await call(full, "apply_patch", { operations: [{ op: "create", path: "created.txt", content: "created" }] });
  await call(full, "undo_last_patch");
  check("undo removes files created by apply_patch", (await call(full, "stat_path", { path: "created.txt" })).isError);
  await call(full, "make_dir", { path: "source-dir" });
  await call(full, "write_file", { path: "source-dir/a.txt", content: "a" });
  await call(full, "move_path", { from: "source-dir", to: "dest-dir" });
  await call(full, "undo_last_patch");
  check("undo restores renamed directory source", !(await call(full, "stat_path", { path: "source-dir/a.txt" })).isError);
  check("undo removes renamed directory destination", (await call(full, "stat_path", { path: "dest-dir" })).isError);
  await full.close();
  await stopServer(server);
  server = null;

  // History is scoped to the workspace and cannot replay into an old root.
  console.log("\n[phase] workspace-scoped history");
  server = await startServer(path.join(base, "workspace-b"), { port: 19005, policy: "full" });
  const other = await connect(19005);
  check("new workspace cannot undo another workspace history", (await call(other, "undo_last_patch")).isError);
  await other.close();
} finally {
  if (server) await stopServer(server);
  await rm(base, { recursive: true, force: true });
}

console.log(`\n==== HARDENING: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
