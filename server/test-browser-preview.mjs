// Local Coding Agent Chrome Companion preview integration test
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}`;
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function waitForHealth(port, child, output) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready.\n${output()}`);
}

async function startServer({ port, dashboardPort, preview, policy = "full" }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `lca-browser-preview-${preview ? "on" : "off"}-`));
  const approvalsDir = `${workspace}-approvals`;
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: SERVER_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_MODE: "safe",
      AGENT_POLICY: policy,
      AGENT_APPROVALS_DIR: approvalsDir,
      AGENT_V5_PREVIEW: preview ? "1" : "0",
      AGENT_BROWSER_PREVIEW: preview ? "1" : "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const health = await waitForHealth(port, child, () => `${stdout}\n${stderr}`);
  return {
    child,
    workspace,
    health,
    output: () => `${stdout}\n${stderr}`,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(approvalsDir, { recursive: true, force: true });
    }
  };
}

function extensionHeaders(token) {
  return {
    Origin: extensionOrigin,
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

let previewServer;
let balancedServer;
let strictServer;
let stableServer;
let client;
let balancedClient;
let strictClient;
let stableClient;
try {
  previewServer = await startServer({ port: 19321, dashboardPort: 19322, preview: true });
  check("health exposes preview.12", previewServer.health.preview_version === "5.0.0-preview.12", JSON.stringify(previewServer.health));
  check("health exposes Chrome Companion preview", previewServer.health.browser_preview?.enabled === true);

  const dashboardBase = "http://127.0.0.1:19322";
  const dashboardUi = await (await fetch(`${dashboardBase}/ui`)).text();
  check(
    "dashboard uses the navigable control-center layout",
    dashboardUi.includes('class="app-shell"') &&
      dashboardUi.includes('data-view="overview"') &&
      dashboardUi.includes('data-view="activity"') &&
      dashboardUi.includes('data-view="approvals"') &&
      dashboardUi.includes('data-view="tasks"') &&
      dashboardUi.includes('data-view="reports"') &&
      dashboardUi.includes('data-view="files"') &&
      dashboardUi.includes('data-view="connections"')
  );
  check(
    "dashboard lazy-loads the workspace tree",
    !/\n\s*loadTree\(\);\s*\n/.test(dashboardUi) && dashboardUi.includes("if(name==='files'&&!treeLoaded) loadTree()")
  );
  const status = await json(await fetch(`${dashboardBase}/api/browser/status`));
  check("dashboard exposes a six-digit one-time pairing code", /^\d{6}$/.test(status.pairing_code || ""));
  check("dashboard reports the unpacked extension directory", /chrome-companion-preview[\\/]extension$/.test(status.extension_dir || ""));

  const badPair = await fetch(`${dashboardBase}/api/browser/pair`, {
    method: "POST",
    headers: { Origin: "https://example.com", "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: status.pairing_code, extension_id: extensionId })
  });
  check("pairing rejects non-extension origins", badPair.status === 403, `status=${badPair.status}`);

  const paired = await json(await fetch(`${dashboardBase}/api/browser/pair`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ pairing_code: status.pairing_code, extension_id: extensionId, name: "Integration Chrome" })
  }));
  check("extension receives an ephemeral browser session", /^browser_/.test(paired.client_id || "") && Boolean(paired.token));

  await json(await fetch(`${dashboardBase}/api/browser/state`, {
    method: "POST",
    headers: extensionHeaders(paired.token),
    body: JSON.stringify({
      armed_tab: { tab_id: 44, window_id: 5, url: "https://example.com/page", title: "Example", origin: "https://example.com" },
      capabilities: ["snapshot", "screenshot", "navigate", "tab_action", "click", "type", "scroll", "press", "select"],
      last_action: { kind: "snapshot", ok: true, at: "2026-07-15T00:00:00.000Z", summary: "Example" }
    })
  }));

  client = new Client({ name: "browser-preview-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:19321/mcp")));
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  const expectedBrowserTools = ["browser_status", "browser_snapshot", "browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_tab_action", "browser_scroll", "browser_press", "browser_select"];
  check("preview MCP advertises the complete browser tool set", expectedBrowserTools.every((name) => toolNames.includes(name)) && expectedBrowserTools.length === 10);

  const mcpStatus = await callJson(client, "browser_status");
  check("browser_status reports the armed tab", mcpStatus.connected === true && mcpStatus.clients?.[0]?.armed_tab?.tab_id === 44);
  check("browser_status reports capabilities and last action", mcpStatus.clients?.[0]?.capabilities?.includes("screenshot") && mcpStatus.clients?.[0]?.last_action?.kind === "snapshot");

  async function roundTrip(name, args, expectedKind, result) {
    const call = client.callTool({ name, arguments: args });
    const polled = await json(await fetch(`${dashboardBase}/api/browser/poll?wait_ms=3000`, { headers: extensionHeaders(paired.token) }));
    check(`${name} reaches the extension queue`, polled.command?.kind === expectedKind, JSON.stringify(polled.command));
    await json(await fetch(`${dashboardBase}/api/browser/result/${polled.command.id}`, {
      method: "POST",
      headers: extensionHeaders(paired.token),
      body: JSON.stringify({ result })
    }));
    return await call;
  }

  const snapshotCall = callJson(client, "browser_snapshot", { max_chars: 3000, max_elements: 20 });
  const snapshotPoll = await json(await fetch(`${dashboardBase}/api/browser/poll?wait_ms=3000`, { headers: extensionHeaders(paired.token) }));
  check("snapshot command reaches the extension queue", snapshotPoll.command?.kind === "snapshot");
  await json(await fetch(`${dashboardBase}/api/browser/result/${snapshotPoll.command.id}`, {
    method: "POST",
    headers: extensionHeaders(paired.token),
    body: JSON.stringify({ result: { url: "https://example.com/page", title: "Example", text: "Visible page text", elements: [{ ref: "lca-1", tag: "button", label: "Continue" }] } })
  }));
  const snapshot = await snapshotCall;
  check("snapshot result returns compact untrusted page data", snapshot.untrusted_page_content === true && snapshot.elements?.[0]?.ref === "lca-1");

  const clickCall = callJson(client, "browser_click", { ref: "lca-1", click_count: 2 });
  const clickPoll = await json(await fetch(`${dashboardBase}/api/browser/poll?wait_ms=3000`, { headers: extensionHeaders(paired.token) }));
  check("click command supports double click with snapshot refs", clickPoll.command?.kind === "click" && clickPoll.command?.payload?.ref === "lca-1" && clickPoll.command?.payload?.click_count === 2);
  await json(await fetch(`${dashboardBase}/api/browser/result/${clickPoll.command.id}`, {
    method: "POST",
    headers: extensionHeaders(paired.token),
    body: JSON.stringify({ result: { ok: true, ref: "lca-1" } })
  }));
  check("MCP caller receives the Chrome action result", (await clickCall).ok === true);

  const screenshotResult = await roundTrip("browser_screenshot", { quality: 50, max_bytes: 100000 }, "screenshot", {
    data_url: `data:image/jpeg;base64,${Buffer.from("preview-image").toString("base64")}`,
    width: 1280,
    height: 720,
    url: "https://example.com/page",
    title: "Example"
  });
  check("browser_screenshot returns MCP text and image content", screenshotResult.content?.[0]?.type === "text" && screenshotResult.content?.[1]?.type === "image" && screenshotResult.content?.[1]?.mimeType === "image/jpeg");

  const tabAction = await roundTrip("browser_tab_action", { action: "reload" }, "tab_action", { ok: true, action: "reload", url: "https://example.com/page" });
  check("browser_tab_action returns its result", JSON.parse(tabAction.content[0].text).action === "reload");
  await roundTrip("browser_scroll", { delta_y: 600 }, "scroll", { ok: true, scroll_y: 600, url: "https://example.com/page" });
  await roundTrip("browser_press", { key: "Enter", ref: "lca-1" }, "press", { ok: true, key: "Enter", ref: "lca-1" });
  await roundTrip("browser_select", { ref: "lca-2", label: "Vietnam" }, "select", { ok: true, ref: "lca-2", label: "Vietnam", value: "vn" });

  await client.close();
  client = null;
  await previewServer.stop();
  previewServer = null;

  balancedServer = await startServer({ port: 19325, dashboardPort: 19326, preview: true, policy: "balanced" });
  const balancedDashboard = "http://127.0.0.1:19326";
  const balancedStatus = await json(await fetch(`${balancedDashboard}/api/browser/status`));
  const balancedPair = await json(await fetch(`${balancedDashboard}/api/browser/pair`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ pairing_code: balancedStatus.pairing_code, extension_id: extensionId, name: "Balanced Chrome" })
  }));
  await json(await fetch(`${balancedDashboard}/api/browser/state`, {
    method: "POST",
    headers: extensionHeaders(balancedPair.token),
    body: JSON.stringify({ armed_tab: { tab_id: 45, window_id: 6, url: "https://example.com/page", title: "Example", origin: "https://example.com" } })
  }));
  balancedClient = new Client({ name: "browser-balanced-test", version: "1.0.0" });
  await balancedClient.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:19325/mcp")));
  const selectDenied = await balancedClient.callTool({ name: "browser_select", arguments: { ref: "lca-2", label: "Vietnam" } });
  check("balanced policy requires approval before browser_select", selectDenied.isError === true && /Approval required/.test(selectDenied.content?.[0]?.text || ""));

  strictServer = await startServer({ port: 19327, dashboardPort: 19328, preview: true, policy: "strict" });
  strictClient = new Client({ name: "browser-strict-test", version: "1.0.0" });
  await strictClient.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:19327/mcp")));
  const clickDenied = await strictClient.callTool({ name: "browser_click", arguments: { ref: "lca-1" } });
  check("strict policy blocks browser mutation tools", clickDenied.isError === true && /blocked by policy=strict/.test(clickDenied.content?.[0]?.text || ""));

  stableServer = await startServer({ port: 19323, dashboardPort: 19324, preview: false });
  stableClient = new Client({ name: "browser-stable-test", version: "1.0.0" });
  await stableClient.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:19323/mcp")));
  const stableTools = (await stableClient.listTools()).tools.map((tool) => tool.name);
  check("stable mode does not expose browser preview tools", stableTools.every((name) => !name.startsWith("browser_")));
} finally {
  await client?.close().catch(() => {});
  await balancedClient?.close().catch(() => {});
  await strictClient?.close().catch(() => {});
  await stableClient?.close().catch(() => {});
  await previewServer?.stop().catch(() => {});
  await balancedServer?.stop().catch(() => {});
  await strictServer?.stop().catch(() => {});
  await stableServer?.stop().catch(() => {});
}

console.log(`\n==== BROWSER PREVIEW: ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
