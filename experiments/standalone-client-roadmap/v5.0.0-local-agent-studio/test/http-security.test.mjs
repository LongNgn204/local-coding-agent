import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const VERSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

test("Studio HTTP boundary blocks CSRF and persists authenticated threads", async () => {
  const port = await freePort();
  const storage = mkdtempSync(join(tmpdir(), "lca-studio-http-"));
  const desktopBridgeToken = "desktop-bridge-test-token";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: VERSION_DIR,
    env: {
      ...process.env,
      LCA_STUDIO_PORT: String(port),
      LOCALAPPDATA: storage,
      LCA_DESKTOP_BRIDGE_TOKEN: desktopBridgeToken,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });

  try {
    await waitForHealth(port, child, () => logs);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-security-policy") || "", /default-src 'none'/);
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    const html = await root.text();
    const token = html.match(/const STUDIO_TOKEN="([A-Za-z0-9_-]+)"/)?.[1] ||
      html.match(/<meta name="lca-studio-token" content="([A-Za-z0-9_-]+)" \/>/)?.[1];
    assert.ok(token, "session token should be embedded only in the same-origin HTML");

    const missingToken = await fetch(`http://127.0.0.1:${port}/api/threads`);
    assert.equal(missingToken.status, 401);

    const hostileOrigin = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token, origin: "https://evil.example" },
      body: JSON.stringify({ title: "blocked" })
    });
    assert.equal(hostileOrigin.status, 403);

    const simpleRequest = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-lca-studio-token": token },
      body: JSON.stringify({ title: "blocked" })
    });
    assert.equal(simpleRequest.status, 415);

    const unconfirmedPatchPreview = await fetch(`http://127.0.0.1:${port}/api/patches/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({ diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" })
    });
    assert.equal(unconfirmedPatchPreview.status, 428);

    const malformedPatchPreview = await fetch(`http://127.0.0.1:${port}/api/patches/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({ diff: "not a unified diff", intent: { action: "patch:preview", confirm: "patch:preview" } })
    });
    assert.equal(malformedPatchPreview.status, 400);

    const manualPatchBypass = await fetch(`http://127.0.0.1:${port}/api/call-tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({
        name: "apply_patch",
        arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" },
        intent: { action: "tool:call", confirm: "tool:call" }
      })
    });
    assert.equal(manualPatchBypass.status, 403);

    const desktopSecretWithoutBridge = await fetch(`http://127.0.0.1:${port}/api/desktop-secrets/anthropic`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({
        value: "sk-ant-runtime",
        intent: { action: "provider-key:set", confirm: "provider-key:set" }
      })
    });
    assert.equal(desktopSecretWithoutBridge.status, 403);

    const desktopSecret = await fetch(`http://127.0.0.1:${port}/api/desktop-secrets/anthropic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lca-studio-token": token,
        "x-lca-desktop-token": desktopBridgeToken
      },
      body: JSON.stringify({
        value: "sk-ant-runtime",
        label: "OS credential",
        intent: { action: "provider-key:set", confirm: "provider-key:set" }
      })
    });
    assert.equal(desktopSecret.status, 200);
    assert.equal((await desktopSecret.json()).source, "os-safe-storage");

    const anthropicStatus = await fetch(`http://127.0.0.1:${port}/api/secrets/anthropic`, {
      headers: { "x-lca-studio-token": token }
    });
    assert.equal((await anthropicStatus.json()).source, "os-safe-storage");

    const fakeSecret = "sk-test-http-secret-123";
    const unconfirmedSecret = await fetch(`http://127.0.0.1:${port}/api/secrets/openai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({ value: fakeSecret, label: "HTTP Test" })
    });
    assert.equal(unconfirmedSecret.status, 428);

    const savedSecret = await fetch(`http://127.0.0.1:${port}/api/secrets/openai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({
        value: fakeSecret,
        label: "HTTP Test",
        intent: { action: "provider-key:set", confirm: "provider-key:set" }
      })
    });
    assert.equal(savedSecret.status, 200);
    assert.equal(JSON.stringify(await savedSecret.json()).includes(fakeSecret), false);

    const secretStatus = await fetch(`http://127.0.0.1:${port}/api/secrets`, {
      headers: { "x-lca-studio-token": token }
    });
    assert.equal(secretStatus.status, 200);
    assert.equal(JSON.stringify(await secretStatus.json()).includes(fakeSecret), false);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).openai_key_present, true);

    const created = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({ title: "Secure thread", provider: "openai", model: "test" })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.match(createdBody.thread.id, /^thr_/);

    const listed = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      headers: { "x-lca-studio-token": token }
    });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).threads[0].title, "Secure thread");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
    if (!child.killed) child.kill("SIGKILL");
    rmSync(storage, { recursive: true, force: true });
  }
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port, child, getLogs) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode != null) throw new Error(`Studio exited early (${child.exitCode}): ${getLogs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Studio health timeout: ${getLogs()}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
