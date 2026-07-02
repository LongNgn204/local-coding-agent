import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startStudio } from "../standalone-app.mjs";

const manifest = {
  productName: "Local Agent Studio",
  version: "v5.0.0-test",
  buildNumber: 500000,
  channel: "local-agent-studio",
  releaseStage: "preview",
  defaultMcpEndpoint: "http://127.0.0.1:8787/mcp",
  providers: ["openai"],
  features: []
};

test("Studio runs in-process and closes its HTTP and SQLite lifecycle idempotently", async () => {
  const port = await freePort();
  const storageDir = mkdtempSync(join(tmpdir(), "lca-studio-lifecycle-"));
  const studio = startStudio(manifest, {
    host: "127.0.0.1",
    port,
    storageDir,
    repoRoot: null,
    desktopBridgeToken: "desktop-test-token",
    nodeRuntime: {
      executable: "embedded-electron",
      source: "electron-embedded",
      version: "24.0.0"
    }
  });
  try {
    await studio.ready;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.node_runtime.source, "electron-embedded");
    assert.equal(health.node_runtime.executable, "embedded-electron");
    assert.equal(health.security.desktop_secret_bridge, true);

    await studio.close();
    await studio.close();
    assert.equal(studio.server.listening, false);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`));
  } finally {
    await studio.close();
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test("support bundle includes redacted agent session diagnostics", async () => {
  const port = await freePort();
  const storageDir = mkdtempSync(join(tmpdir(), "lca-studio-support-"));
  const studio = startStudio({ ...manifest, features: ["supportBundle"] }, {
    host: "127.0.0.1",
    port,
    storageDir,
    repoRoot: null
  });
  try {
    await studio.ready;
    const thread = studio.state.threadStore.createThread({ title: "Customer blocked tool", provider: "openai", model: "test-model", workspace: "C:/customer/repo" });
    const turn = studio.state.threadStore.startTurn(thread.id, { provider: "openai", model: "test-model", toolPolicy: "read-only" });
    studio.state.threadStore.appendItem(thread.id, { turnId: turn.id, role: "user", content: "My token is sk-secret-value" });
    studio.state.threadStore.appendItem(thread.id, {
      turnId: turn.id,
      type: "tool",
      content: "Tool blocked by read-only policy.",
      metadata: { tool: "run_command", blocked: true, isError: true, policy: "read-only", level: "command", ms: 0 }
    });
    studio.state.threadStore.finishTurn(turn.id, { status: "failed", error: "Blocked" });

    const response = await fetch(`http://127.0.0.1:${port}/api/support-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lca-studio-token": studio.state.security.token
      },
      body: JSON.stringify({ intent: { action: "support-bundle:export", confirm: "support-bundle:export" } })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.report.agentSessions.threads[0].turns[0].toolPolicy, "read-only");
    assert.equal(body.report.agentSessions.threads[0].recentItems[1].metadata.blocked, true);
    assert.doesNotMatch(JSON.stringify(body.report), /sk-secret-value/);
  } finally {
    await studio.close();
    rmSync(storageDir, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(selected));
    });
  });
}
