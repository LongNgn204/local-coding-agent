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
