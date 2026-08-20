import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { canonicalizePath } from "./permission-resolver.mjs";

const SERVER = path.resolve("server.mjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { isError: Boolean(result.isError), text, json };
}

test("v5 enforces per-root rights and approved dynamic grants", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lca-permission-preview-"));
  const observe = path.join(base, "observe");
  const edit = path.join(base, "edit");
  const develop = path.join(base, "develop");
  const dynamic = path.join(base, "dynamic");
  const persistent = path.join(base, "persistent");
  const sibling = path.join(base, "observe-evil");
  const profileFile = path.join(base, "private-config", "permission-profiles.json");
  await Promise.all([observe, edit, develop, dynamic, persistent, sibling, path.dirname(profileFile)].map((dir) => mkdir(dir, { recursive: true })));
  await mkdir(path.join(observe, "secrets"), { recursive: true });
  await writeFile(path.join(observe, "readme.txt"), "readable", "utf8");
  await writeFile(path.join(observe, "secrets", "token.txt"), "hidden", "utf8");
  await writeFile(profileFile, `${JSON.stringify({
    version: 1,
    active_profile: "mixed",
    profiles: {
      mixed: {
        version: 1,
        name: "mixed",
        working_directory: observe,
        roots: [
          { path: observe, preset: "observe", deny: ["secrets/**"] },
          { path: edit, preset: "edit" },
          { path: develop, preset: "develop" }
        ]
      }
    }
  }, null, 2)}\n`, "utf8");

  const port = await freePort();
  const dashboardPort = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_HOST: "127.0.0.1",
      AGENT_V5_PREVIEW: "1",
      AGENT_WORKSPACE: observe,
      AGENT_MODE: "safe",
      AGENT_POLICY: "full",
      AGENT_PERMISSION_PROFILE_FILE: profileFile,
      AGENT_PERMISSION_PROFILE_NAME: "mixed",
      AGENT_PERMISSION_PROFILE_JSON: "",
      AGENT_APPROVALS_DIR: path.join(base, "private-config", "approvals"),
      AGENT_EXTRA_ROOTS: "",
      AGENT_EXTRA_ROOTS_JSON: "[]"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(base, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${logs}`);
  });
  const client = new Client({ name: "permission-preview-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  t.after(() => client.close().catch(() => {}));

  const status = await call(client, "permission_status");
  assert.equal(status.isError, false, status.text);
  assert.equal(status.json.active.name, "mixed");
  assert.equal(status.json.active.roots.length, 3);

  assert.equal((await call(client, "read_file", { path: path.join(observe, "readme.txt") })).isError, false);
  assert.match((await call(client, "write_file", { path: path.join(observe, "blocked.txt"), content: "x" })).text, /permission denied/i);
  assert.match((await call(client, "read_file", { path: path.join(observe, "secrets", "token.txt") })).text, /deny pattern/i);
  assert.match((await call(client, "task_plan", { goal: "blocked", steps: ["one"] })).text, /permission denied/i);

  assert.equal((await call(client, "write_file", { path: path.join(edit, "ok.txt"), content: "ok" })).isError, false);
  assert.match((await call(client, "run_command", { cwd: edit, command: "node --version" })).text, /permission denied/i);
  assert.equal((await call(client, "run_command", { cwd: develop, command: "node --version" })).isError, false);
  assert.match((await call(client, "read_file", { path: path.join(sibling, "no.txt") })).text, /outside_roots/i);
  assert.match((await call(client, "create_local_task", { role: "docs_update", task: "x", workspace_root: sibling, dry_run: true })).text, /not readable/i);

  const sessionRequest = await call(client, "request_path_access", {
    path: dynamic,
    preset: "edit",
    scope: "session",
    reason: "integration test"
  });
  assert.equal(sessionRequest.isError, false, sessionRequest.text);
  const approvedSession = await fetch(`http://127.0.0.1:${dashboardPort}/api/approvals/${sessionRequest.json.id}/approve`, { method: "POST" });
  assert.equal(approvedSession.ok, true);
  const sessionGrant = await call(client, "activate_path_access", { id: sessionRequest.json.id });
  assert.equal(sessionGrant.isError, false, sessionGrant.text);
  assert.equal((await call(client, "write_file", { path: path.join(dynamic, "session.txt"), content: "ok" })).isError, false);
  assert.equal((await call(client, "revoke_path_access", { grant_id: sessionGrant.json.grant.id })).isError, false);
  assert.match((await call(client, "read_file", { path: path.join(dynamic, "session.txt") })).text, /outside_roots/i);

  const persistentRequest = await call(client, "request_path_access", {
    path: persistent,
    preset: "develop",
    scope: "profile",
    reason: "integration test persistent grant"
  });
  assert.equal(persistentRequest.isError, false, persistentRequest.text);
  const approvedPersistent = await fetch(`http://127.0.0.1:${dashboardPort}/api/approvals/${persistentRequest.json.id}/approve`, { method: "POST" });
  assert.equal(approvedPersistent.ok, true);
  assert.equal((await call(client, "activate_path_access", { id: persistentRequest.json.id })).isError, false);
  const stored = JSON.parse(await readFile(profileFile, "utf8"));
  assert.ok(stored.profiles.mixed.roots.some((root) => canonicalizePath(root.path) === canonicalizePath(persistent)));
  assert.equal((await call(client, "run_command", { cwd: persistent, command: "node --version" })).isError, false);
});
