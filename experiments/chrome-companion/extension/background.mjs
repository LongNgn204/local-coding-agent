// Local Coding Agent Chrome Companion v5
// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8790";
const SESSION_KEYS = ["clientId", "token", "armedTab", "lastAction"];
const CAPABILITIES = ["snapshot", "screenshot", "navigate", "tab_action", "click", "type", "scroll", "press", "select"];
let polling = false;

function normalizeBridgeUrl(raw) {
  const url = new URL(String(raw || DEFAULT_BRIDGE_URL));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Bridge URL must use http://127.0.0.1 or http://localhost.");
  }
  if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("Bridge URL must contain only the loopback host and port.");
  }
  return url.origin;
}

function siteOrigin(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) tabs are supported.");
  return url.origin;
}

function sitePattern(raw) {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}/*`;
}

async function settings() {
  const local = await chrome.storage.local.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
  const session = await chrome.storage.session.get(SESSION_KEYS);
  return { bridgeUrl: normalizeBridgeUrl(local.bridgeUrl), ...session };
}

async function saveBridgeUrl(bridgeUrl) {
  const normalized = normalizeBridgeUrl(bridgeUrl);
  await chrome.storage.local.set({ bridgeUrl: normalized });
  return normalized;
}

async function clearSession() {
  polling = false;
  await chrome.storage.session.remove(SESSION_KEYS);
}

async function authFetch(pathname, options = {}) {
  const state = await settings();
  if (!state.token || !state.clientId) throw new Error("Chrome Companion is not paired.");
  const response = await fetch(`${state.bridgeUrl}${pathname}`, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    await clearSession();
    throw new Error("Browser session expired. Pair the extension again.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Bridge request failed (${response.status}).`);
  return body;
}

async function liveArmedTab() {
  const state = await settings();
  if (!state.armedTab?.tabId) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(state.armedTab.tabId);
  } catch {
    await chrome.storage.session.remove("armedTab");
    return null;
  }
  if (!tab.url || siteOrigin(tab.url) !== state.armedTab.origin) {
    await chrome.storage.session.remove("armedTab");
    return null;
  }
  return { ...state.armedTab, url: tab.url, title: tab.title || "", windowId: tab.windowId };
}

async function postState() {
  const state = await settings();
  if (!state.token) return;
  const tab = await liveArmedTab();
  await authFetch("/api/browser/state", {
    method: "POST",
    body: JSON.stringify({
      armed_tab: tab
        ? {
            tab_id: tab.tabId,
            window_id: tab.windowId,
            url: tab.url,
            title: tab.title,
            origin: tab.origin,
            armed_at: tab.armedAt
          }
        : null,
      capabilities: CAPABILITIES,
      last_action: state.lastAction || null
    })
  });
}

async function pair({ pairingCode, bridgeUrl }) {
  if (!/^\d{6}$/.test(String(pairingCode || ""))) throw new Error("Pairing code must contain 6 digits.");
  const base = await saveBridgeUrl(bridgeUrl);
  const response = await fetch(`${base}/api/browser/pair`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairing_code: pairingCode,
      extension_id: chrome.runtime.id,
      name: "Chrome Companion Preview"
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Pairing failed.");
  await chrome.storage.session.set({ clientId: body.client_id, token: body.token });
  void startPolling();
  await postState();
  return await publicState();
}

async function armTab(tab) {
  if (!Number.isInteger(tab?.id) || !tab.url) throw new Error("No active HTTP(S) tab was provided.");
  const origin = siteOrigin(tab.url);
  const allowed = await chrome.permissions.contains({ origins: [sitePattern(tab.url)] });
  if (!allowed) throw new Error("Website permission was not granted for this host.");
  await chrome.storage.session.set({
    armedTab: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title || "",
      origin,
      armedAt: new Date().toISOString()
    }
  });
  await postState();
  return await publicState();
}

async function disarmTab() {
  await chrome.storage.session.remove("armedTab");
  await postState();
  return await publicState();
}

async function disconnect() {
  try {
    const state = await settings();
    if (state.token) await authFetch("/api/browser/disconnect", { method: "POST", body: "{}" });
  } catch {}
  await clearSession();
  return await publicState();
}

async function publicState() {
  const state = await settings();
  const tab = await liveArmedTab();
  return {
    paired: Boolean(state.clientId && state.token),
    clientId: state.clientId || null,
    bridgeUrl: state.bridgeUrl,
    capabilities: CAPABILITIES,
    lastAction: state.lastAction || null,
    armedTab: tab
      ? { tabId: tab.tabId, url: tab.url, title: tab.title, origin: tab.origin, armedAt: tab.armedAt }
      : null
  };
}

async function executeCommand(command) {
  try {
    let result;
    switch (command.kind) {
      case "status": result = await publicState(); break;
      case "snapshot": result = await snapshot(command.payload || {}); break;
      case "screenshot": result = await screenshot(command.payload || {}); break;
      case "navigate": result = await navigate(command.payload?.url); break;
      case "tab_action": result = await tabAction(command.payload?.action); break;
      case "click": result = await click(command.payload?.ref, command.payload?.click_count); break;
      case "type": result = await typeInto(command.payload?.ref, command.payload?.value, Boolean(command.payload?.submit)); break;
      case "scroll": result = await scroll(command.payload || {}); break;
      case "press": result = await press(command.payload || {}); break;
      case "select": result = await selectOption(command.payload || {}); break;
      default: throw new Error(`Unsupported browser command: ${command.kind}`);
    }
    await recordAction(command.kind, true, actionSummary(result));
    return result;
  } catch (error) {
    await recordAction(command.kind, false, String(error?.message || error).slice(0, 180));
    throw error;
  }
}

function actionSummary(result) {
  if (!result || typeof result !== "object") return "completed";
  if (result.title) return String(result.title).slice(0, 180);
  if (result.url) {
    try { return new URL(result.url).origin; } catch {}
  }
  return result.ref ? `element ${result.ref}` : "completed";
}

async function recordAction(kind, ok, summary) {
  await chrome.storage.session.set({
    lastAction: { kind: String(kind || "unknown").slice(0, 80), ok: Boolean(ok), at: new Date().toISOString(), summary: String(summary || "").slice(0, 180) }
  });
}

async function requireArmedTab() {
  const tab = await liveArmedTab();
  if (!tab) throw new Error("The armed tab is unavailable or changed origin. Arm the target tab again.");
  const allowed = await chrome.permissions.contains({ origins: [sitePattern(tab.url)] });
  if (!allowed) throw new Error("Chrome no longer grants access to the armed host.");
  return tab;
}

async function snapshot({ max_chars = 16000, max_elements = 120 }) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: pageSnapshot,
    args: [Math.min(Math.max(max_chars, 1000), 40000), Math.min(Math.max(max_elements, 1), 300)]
  });
  return result;
}

async function click(ref, clickCount = 1) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: clickRef,
    args: [ref, clickCount === 2 ? 2 : 1]
  });
  return result;
}

async function typeInto(ref, value, submit) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: typeRef,
    args: [ref, String(value || ""), submit]
  });
  return result;
}

async function screenshot({ quality = 55, max_bytes = 500000 }) {
  const tab = await requireArmedTab();
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.tabId) throw new Error("The armed tab must be active before taking a screenshot.");
  const limit = Math.min(Math.max(Number(max_bytes || 500000), 100000), 700000);
  const qualities = [...new Set([quality, quality - 15, quality - 30, 30].map((item) => Math.min(Math.max(Math.round(item), 30), 75)))];
  let dataUrl = "";
  for (const candidate of qualities) {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: candidate });
    const estimatedBytes = Math.floor((dataUrl.split(",")[1]?.length || 0) * 0.75);
    if (estimatedBytes <= limit) break;
  }
  const estimatedBytes = Math.floor((dataUrl.split(",")[1]?.length || 0) * 0.75);
  if (!dataUrl || estimatedBytes > limit) throw new Error("Screenshot is too large even at reduced quality.");
  const [{ result: viewport }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: () => ({ width: innerWidth, height: innerHeight, url: location.href, title: document.title })
  });
  return { data_url: dataUrl, width: viewport.width, height: viewport.height, url: viewport.url, title: viewport.title };
}

async function tabAction(action) {
  const tab = await requireArmedTab();
  if (!["back", "forward", "reload"].includes(action)) throw new Error("Unsupported tab action.");
  if (action === "back") await chrome.tabs.goBack(tab.tabId);
  else if (action === "forward") await chrome.tabs.goForward(tab.tabId);
  else await chrome.tabs.reload(tab.tabId);
  await waitForTabComplete(tab.tabId, 25000);
  const updated = await liveArmedTab();
  await postState();
  return { ok: true, action, url: updated?.url || "", title: updated?.title || "" };
}

async function scroll({ delta_x = 0, delta_y = 0, ref } = {}) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: scrollPage,
    args: [Number(delta_x || 0), Number(delta_y || 0), ref || null]
  });
  return result;
}

async function press({ key, ref, shift = false } = {}) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: pressKey,
    args: [key, ref || null, Boolean(shift)]
  });
  return result;
}

async function selectOption({ ref, value, label } = {}) {
  const tab = await requireArmedTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.tabId },
    func: selectRef,
    args: [ref, value ?? null, label ?? null]
  });
  return result;
}

async function navigate(rawUrl) {
  const tab = await requireArmedTab();
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) navigation is allowed.");
  if (url.origin !== tab.origin) throw new Error("Cross-origin navigation is blocked. Open the target host manually and arm that tab.");
  await chrome.tabs.update(tab.tabId, { url: url.href });
  await waitForTabComplete(tab.tabId, 25000);
  const updated = await liveArmedTab();
  await postState();
  return { ok: true, url: updated?.url || url.href, title: updated?.title || "" };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Navigation timed out."));
    }, timeoutMs);
    function listener(updatedId, changeInfo) {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

function pageSnapshot(maxChars, maxElements) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  document.querySelectorAll("[data-lca-ref]").forEach((element) => element.removeAttribute("data-lca-ref"));
  const selector = "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]";
  const candidates = [...document.querySelectorAll(selector)].filter(visible).slice(0, maxElements);
  const elements = candidates.map((element, index) => {
    const ref = `lca-${index + 1}`;
    element.setAttribute("data-lca-ref", ref);
    const rawHref = element instanceof HTMLAnchorElement ? element.href : "";
    let href = "";
    try {
      const parsed = new URL(rawHref);
      href = `${parsed.origin}${parsed.pathname}`.slice(0, 1000);
    } catch {}
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      role: (element.getAttribute("role") || "").slice(0, 80),
      type: (element.getAttribute("type") || "").slice(0, 80),
      name: (element.getAttribute("name") || "").slice(0, 120),
      label: (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.innerText || "")
        .replace(/\s+/g, " ").trim().slice(0, 300),
      href,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true")
    };
  });
  const fullText = (document.body?.innerText || "").replace(/\n{4,}/g, "\n\n\n").trim();
  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, maxChars),
    text_truncated: fullText.length > maxChars,
    viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
    scroll: { x: scrollX, y: scrollY, max_x: Math.max(0, document.documentElement.scrollWidth - innerWidth), max_y: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
    active_element: document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), ref: document.activeElement.getAttribute("data-lca-ref") || null } : null,
    forms: document.forms.length,
    elements
  };
}

function clickRef(ref, clickCount) {
  if (!/^lca-[1-9][0-9]{0,3}$/.test(String(ref || ""))) throw new Error("Invalid element ref.");
  const element = document.querySelector(`[data-lca-ref="${ref}"]`);
  if (!element) throw new Error("Element ref is stale. Take a new browser_snapshot.");
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
    throw new Error("Element is not visible.");
  }
  if (element.disabled || element.getAttribute("aria-disabled") === "true") throw new Error("Element is disabled.");
  element.scrollIntoView({ block: "center", inline: "center" });
  if (clickCount === 2) element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  else element.click();
  return { ok: true, ref, click_count: clickCount, tag: element.tagName.toLowerCase(), label: (element.getAttribute("aria-label") || element.innerText || "").trim().slice(0, 200), url: location.href };
}

function typeRef(ref, value, submit) {
  if (!/^lca-[1-9][0-9]{0,3}$/.test(String(ref || ""))) throw new Error("Invalid element ref.");
  const element = document.querySelector(`[data-lca-ref="${ref}"]`);
  if (!element) throw new Error("Element ref is stale. Take a new browser_snapshot.");
  const inputType = String(element.getAttribute("type") || "").toLowerCase();
  const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
  if (["password", "file"].includes(inputType) || /(cc-|one-time-code|current-password|new-password)/.test(autocomplete)) {
    throw new Error("Typing into password, file, payment, or one-time-code fields is blocked.");
  }
  const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
  if (!editable) throw new Error("Element is not editable.");
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else {
    element.textContent = value;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = element.closest("form");
    if (!form) throw new Error("Submit was requested but the element is not inside a form.");
    form.requestSubmit();
  }
  return { ok: true, ref, chars: value.length, submitted: Boolean(submit), url: location.href };
}

function scrollPage(deltaX, deltaY, ref) {
  const target = ref ? document.querySelector(`[data-lca-ref="${ref}"]`) : document.scrollingElement;
  if (!target) throw new Error(ref ? "Element ref is stale. Take a new browser_snapshot." : "Page is not scrollable.");
  if (ref) target.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  else window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return { ok: true, ref: ref || null, scroll_x: ref ? target.scrollLeft : scrollX, scroll_y: ref ? target.scrollTop : scrollY, url: location.href };
}

function pressKey(key, ref, shift) {
  const supported = ["Enter", "Escape", "Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
  if (!supported.includes(key)) throw new Error("Unsupported key.");
  const target = ref ? document.querySelector(`[data-lca-ref="${ref}"]`) : document.activeElement;
  if (!target) throw new Error("No target element is focused.");
  target.focus?.();
  if (key === "Tab") {
    const focusable = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,select,[tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.disabled && element.getClientRects().length > 0);
    const current = focusable.indexOf(target);
    const direction = shift ? -1 : 1;
    const next = focusable[(current + direction + focusable.length) % focusable.length];
    next?.focus();
  } else if (key === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit();
    else target.click?.();
  } else if (key === "Space" && (target.matches?.("button,[role=button],a[href]"))) {
    target.click();
  } else {
    const eventKey = key === "Space" ? " " : key;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: eventKey, shiftKey: shift, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: eventKey, shiftKey: shift, bubbles: true, cancelable: true }));
  }
  return { ok: true, key, ref: ref || target.getAttribute?.("data-lca-ref") || null, url: location.href };
}

function selectRef(ref, value, label) {
  if (!/^lca-[1-9][0-9]{0,3}$/.test(String(ref || ""))) throw new Error("Invalid element ref.");
  const element = document.querySelector(`[data-lca-ref="${ref}"]`);
  if (!(element instanceof HTMLSelectElement)) throw new Error("Element ref is not a native select.");
  const option = value != null
    ? [...element.options].find((item) => item.value === value)
    : [...element.options].find((item) => item.label.trim() === String(label).trim() || item.text.trim() === String(label).trim());
  if (!option) throw new Error("Select option was not found.");
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, ref, value: option.value.slice(0, 300), label: option.text.trim().slice(0, 300), url: location.href };
}

async function reportResult(command, outcome) {
  await authFetch(`/api/browser/result/${encodeURIComponent(command.id)}`, {
    method: "POST",
    body: JSON.stringify(outcome)
  });
}

async function startPolling() {
  if (polling) return;
  polling = true;
  while (polling) {
    const state = await settings();
    if (!state.token || !state.clientId) break;
    try {
      const body = await authFetch("/api/browser/poll?wait_ms=20000");
      const command = body.command;
      if (!command) continue;
      try {
        const result = await executeCommand(command);
        await reportResult(command, { result });
      } catch (error) {
        await reportResult(command, { error: error?.message || String(error) });
      }
      await postState();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  polling = false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = async () => {
    switch (message?.type) {
      case "state": return await publicState();
      case "pair": return await pair(message);
      case "arm": return await armTab(message.tab);
      case "disarm": return await disarmTab();
      case "disconnect": return await disconnect();
      default: throw new Error("Unknown popup action.");
    }
  };
  action().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await settings();
  if (state.armedTab?.tabId !== tabId) return;
  await chrome.storage.session.remove("armedTab");
  await postState().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const state = await settings();
  if (state.armedTab?.tabId !== tabId) return;
  try {
    if (siteOrigin(tab.url) !== state.armedTab.origin) await chrome.storage.session.remove("armedTab");
  } catch {
    await chrome.storage.session.remove("armedTab");
  }
  await postState().catch(() => {});
});

void startPolling();
