import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startStudio } from "../standalone-app.mjs";

const manifest = {
  productName: "Local Agent Studio",
  version: "v5.0.0",
  buildNumber: 500000,
  channel: "local-agent-studio",
  releaseStage: "preview",
  defaultMcpEndpoint: "http://127.0.0.1:9/mcp",
  providers: ["openai"],
  features: []
};

test("turn API starts a streamed turn and emits a terminal event", async () => {
  const port = await freePort();
  const storageDir = mkdtempSync(join(tmpdir(), "lca-studio-turn-api-"));
  const studio = startStudio(manifest, {
    host: "127.0.0.1",
    port,
    storageDir,
    repoRoot: null
  });
  try {
    await studio.ready;
    const token = studio.state.security.token;
    const started = await fetch(`http://127.0.0.1:${port}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lca-studio-token": token },
      body: JSON.stringify({
        message: "Summarize the workspace.",
        provider: "openai",
        model: "test-model",
        toolPolicy: "read-only"
      })
    });
    assert.equal(started.status, 202);
    const body = await started.json();
    assert.match(body.turnId, /^turn_/);
    assert.match(body.threadId, /^thr_/);

    const events = await readSse(`http://127.0.0.1:${port}/api/turns/${body.turnId}/events`, token);
    assert.equal(events[0]?.type, "turn.started");
    const terminal = events.find((event) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type));
    assert.equal(terminal?.type, "turn.failed");
    assert.match(terminal.error || "", /fetch failed|connect|OpenAI API key/i);

    const snapshot = await fetch(`http://127.0.0.1:${port}/api/turns/${body.turnId}`, {
      headers: { "x-lca-studio-token": token }
    });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).turn.status, "failed");
  } finally {
    await studio.close();
    rmSync(storageDir, { recursive: true, force: true });
  }
});

async function readSse(url, token) {
  const response = await fetch(url, { headers: { "x-lca-studio-token": token } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());
      events.push(event);
      if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) return events;
    }
    if (done) return events;
  }
}

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
