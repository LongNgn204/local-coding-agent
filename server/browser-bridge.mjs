// Local Coding Agent Chrome Companion bridge
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

export const CHROME_EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
export const BROWSER_CLIENT_ID_RE = /^browser_[0-9a-f-]{36}$/i;
export const BROWSER_COMMAND_ID_RE = /^bcmd_[0-9a-f-]{36}$/i;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function equalSecret(value, expectedHash) {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(String(expectedHash));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanText(value, max = 500) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function pairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export class BrowserBridge {
  constructor({ enabled = false, commandTimeoutMs = 30_000, pollWaitMs = 20_000, staleMs = 45_000 } = {}) {
    this.enabled = Boolean(enabled);
    this.commandTimeoutMs = commandTimeoutMs;
    this.pollWaitMs = pollWaitMs;
    this.staleMs = staleMs;
    this.clients = new Map();
    this.pending = new Map();
    this.pairingCode = pairingCode();
  }

  status({ includePairingCode = false } = {}) {
    const now = Date.now();
    const clients = [...this.clients.values()].map((client) => ({
      client_id: client.id,
      extension_id: client.extensionId,
      name: client.name,
      paired_at: client.pairedAt,
      last_seen_at: client.lastSeenAt ? new Date(client.lastSeenAt).toISOString() : null,
      connected: Boolean(client.lastSeenAt && now - client.lastSeenAt <= this.staleMs),
      armed_tab: client.state?.armed_tab || null,
      capabilities: client.state?.capabilities || [],
      last_action: client.state?.last_action || null,
      queue_depth: client.queue.length
    }));
    return {
      enabled: this.enabled,
      paired: clients.length > 0,
      connected: clients.some((client) => client.connected),
      clients,
      ...(includePairingCode && this.enabled ? { pairing_code: this.pairingCode } : {})
    };
  }

  pair({ pairing_code, extension_id, name }, origin) {
    if (!this.enabled) throw new Error("Chrome Companion is disabled.");
    if (!CHROME_EXTENSION_ORIGIN_RE.test(origin)) throw new Error("Pairing is allowed only from a Chrome extension origin.");
    if (extension_id !== origin.slice("chrome-extension://".length)) throw new Error("Extension id does not match the request origin.");
    if (!/^\d{6}$/.test(String(pairing_code || "")) || !equalSecret(pairing_code, hash(this.pairingCode))) {
      throw new Error("Invalid or expired pairing code.");
    }

    const id = `browser_${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const client = {
      id,
      extensionId: extension_id,
      origin,
      name: cleanText(name || "Chrome Companion", 80),
      tokenHash: hash(token),
      pairedAt: new Date().toISOString(),
      lastSeenAt: Date.now(),
      queue: [],
      waiter: null,
      state: { armed_tab: null, capabilities: [], last_action: null }
    };

    for (const existing of this.clients.values()) this.disconnect(existing.id, "replaced by a new pairing");
    this.clients.set(id, client);
    this.pairingCode = pairingCode();
    return { client_id: id, token, poll_wait_ms: this.pollWaitMs };
  }

  authenticate(authorization, origin) {
    const raw = String(authorization || "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    if (!token || !CHROME_EXTENSION_ORIGIN_RE.test(origin)) return null;
    for (const client of this.clients.values()) {
      if (client.origin === origin && equalSecret(token, client.tokenHash)) return client;
    }
    return null;
  }

  updateState(client, state = {}) {
    client.lastSeenAt = Date.now();
    const tab = state.armed_tab;
    const action = state.last_action;
    client.state = {
      armed_tab: tab && Number.isInteger(tab.tab_id)
        ? {
            tab_id: tab.tab_id,
            window_id: Number.isInteger(tab.window_id) ? tab.window_id : null,
            url: cleanText(tab.url, 2000),
            title: cleanText(tab.title, 300),
            origin: cleanText(tab.origin, 500),
            armed_at: cleanText(tab.armed_at, 80) || new Date().toISOString()
          }
        : null,
      capabilities: Array.isArray(state.capabilities)
        ? state.capabilities.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 30)
        : [],
      last_action: action && typeof action === "object"
        ? {
            kind: cleanText(action.kind, 80),
            ok: action.ok !== false,
            at: cleanText(action.at, 80),
            summary: cleanText(action.summary, 300)
          }
        : null
    };
    return this.status();
  }

  async poll(client, requestedWaitMs) {
    client.lastSeenAt = Date.now();
    if (client.queue.length) return client.queue.shift();

    const waitMs = Math.min(Math.max(Number(requestedWaitMs || this.pollWaitMs), 1000), 25_000);
    if (client.waiter) client.waiter.resolve(null);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (client.waiter?.timer === timer) client.waiter = null;
        resolve(null);
      }, waitMs);
      client.waiter = {
        timer,
        resolve: (command) => {
          clearTimeout(timer);
          if (client.waiter?.timer === timer) client.waiter = null;
          resolve(command);
        }
      };
    });
  }

  dispatch(kind, payload = {}, { timeoutMs } = {}) {
    if (!this.enabled) return Promise.reject(new Error("Chrome Companion is disabled."));
    const client = [...this.clients.values()].find((candidate) =>
      candidate.lastSeenAt && Date.now() - candidate.lastSeenAt <= this.staleMs
    );
    if (!client) return Promise.reject(new Error("Chrome Companion is not connected. Pair the extension and keep Chrome open."));
    if (kind !== "status" && !client.state?.armed_tab) {
      return Promise.reject(new Error("No Chrome tab is armed. Open the extension popup on the target tab and select Arm tab."));
    }

    const id = `bcmd_${randomUUID()}`;
    const command = { id, kind, payload, created_at: new Date().toISOString() };
    const effectiveTimeout = Math.min(Math.max(Number(timeoutMs || this.commandTimeoutMs), 1000), 60_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome Companion command timed out after ${effectiveTimeout}ms.`));
      }, effectiveTimeout);
      this.pending.set(id, { clientId: client.id, resolve, reject, timer });
      if (client.waiter) client.waiter.resolve(command);
      else client.queue.push(command);
    });
  }

  complete(client, id, { result, error } = {}) {
    if (!BROWSER_COMMAND_ID_RE.test(String(id || ""))) throw new Error("Invalid browser command id.");
    const pending = this.pending.get(id);
    if (!pending || pending.clientId !== client.id) throw new Error("Browser command is unknown, expired, or belongs to another client.");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    client.lastSeenAt = Date.now();
    if (error) pending.reject(new Error(cleanText(error, 1000)));
    else pending.resolve(result ?? null);
    return { ok: true };
  }

  disconnect(clientId, reason = "disconnected") {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (client.waiter) client.waiter.resolve(null);
    for (const [id, pending] of this.pending) {
      if (pending.clientId !== clientId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Chrome Companion ${reason}.`));
      this.pending.delete(id);
    }
    this.clients.delete(clientId);
    return true;
  }
}
