// Local Coding Agent Chrome Companion tests
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserBridge } from "./browser-bridge.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${extensionId}`;

function pair(bridge) {
  return bridge.pair({ pairing_code: bridge.pairingCode, extension_id: extensionId, name: "Test Chrome" }, origin);
}

test("pairing is one-time and bound to the extension origin", () => {
  const bridge = new BrowserBridge({ enabled: true });
  const code = bridge.pairingCode;
  const paired = pair(bridge);
  assert.match(paired.client_id, /^browser_/);
  assert.ok(paired.token.length >= 32);
  assert.notEqual(bridge.pairingCode, code);
  assert.throws(() => bridge.pair({ pairing_code: code, extension_id: extensionId, name: "Replay" }, origin), /Invalid or expired/);
  assert.throws(() => bridge.pair({ pairing_code: bridge.pairingCode, extension_id: extensionId, name: "Wrong origin" }, "https://example.com"), /Chrome extension origin/);
});

test("bearer authentication is origin-bound", () => {
  const bridge = new BrowserBridge({ enabled: true });
  const paired = pair(bridge);
  assert.ok(bridge.authenticate(`Bearer ${paired.token}`, origin));
  assert.equal(bridge.authenticate(`Bearer ${paired.token}`, "chrome-extension://pppppppppppppppppppppppppppppppp"), null);
  assert.equal(bridge.authenticate("Bearer wrong", origin), null);
});

test("dispatch waits for an armed extension and returns its compact result", async () => {
  const bridge = new BrowserBridge({ enabled: true, pollWaitMs: 1000 });
  const paired = pair(bridge);
  const client = bridge.authenticate(`Bearer ${paired.token}`, origin);
  bridge.updateState(client, { armed_tab: { tab_id: 7, window_id: 2, url: "https://example.com", title: "Example", origin: "https://example.com" } });

  const resultPromise = bridge.dispatch("snapshot", { max_chars: 5000 });
  const command = await bridge.poll(client, 1000);
  assert.equal(command.kind, "snapshot");
  bridge.complete(client, command.id, { result: { title: "Example", text: "hello" } });
  assert.deepEqual(await resultPromise, { title: "Example", text: "hello" });
});

test("client capability and last-action state is bounded and exposed", () => {
  const bridge = new BrowserBridge({ enabled: true });
  const paired = pair(bridge);
  const client = bridge.authenticate(`Bearer ${paired.token}`, origin);
  bridge.updateState(client, {
    capabilities: ["snapshot", "screenshot", "x".repeat(200)],
    last_action: { kind: "type", ok: true, at: "2026-07-15T00:00:00.000Z", summary: "completed" }
  });
  const state = bridge.status().clients[0];
  assert.deepEqual(state.capabilities.slice(0, 2), ["snapshot", "screenshot"]);
  assert.equal(state.capabilities[2].length, 80);
  assert.deepEqual(state.last_action, { kind: "type", ok: true, at: "2026-07-15T00:00:00.000Z", summary: "completed" });
});

test("mutating commands require an armed tab", async () => {
  const bridge = new BrowserBridge({ enabled: true });
  const paired = pair(bridge);
  const client = bridge.authenticate(`Bearer ${paired.token}`, origin);
  await assert.rejects(bridge.dispatch("click", { ref: "lca-1" }), /No Chrome tab is armed/);
  bridge.updateState(client, { armed_tab: null });
});

test("command errors and disconnects reach the MCP caller", async () => {
  const bridge = new BrowserBridge({ enabled: true, pollWaitMs: 1000 });
  const paired = pair(bridge);
  const client = bridge.authenticate(`Bearer ${paired.token}`, origin);
  bridge.updateState(client, { armed_tab: { tab_id: 3, url: "https://example.com", origin: "https://example.com" } });

  const failed = bridge.dispatch("click", { ref: "lca-2" });
  const command = await bridge.poll(client, 1000);
  bridge.complete(client, command.id, { error: "Element is no longer visible" });
  await assert.rejects(failed, /no longer visible/);

  const disconnected = bridge.dispatch("snapshot", {});
  bridge.disconnect(client.id, "was disconnected by the operator");
  await assert.rejects(disconnected, /disconnected by the operator/);
});
