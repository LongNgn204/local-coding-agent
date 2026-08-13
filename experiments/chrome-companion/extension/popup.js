const $ = (id) => document.getElementById(id);
let state = null;

function message(text, kind = "") {
  $("message").textContent = text || "";
  $("message").className = kind;
}

function send(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response?.ok) return reject(new Error(response?.error || "Extension request failed."));
      resolve(response.result);
    });
  });
}

function render(next) {
  state = next;
  $("bridgeUrl").value = next.bridgeUrl || "http://127.0.0.1:8790";
  $("pairSection").hidden = next.paired;
  $("tabSection").hidden = !next.paired;
  $("disconnectButton").hidden = !next.paired;
  $("connectionBadge").textContent = next.paired ? "Paired" : "Offline";
  $("connectionBadge").className = `badge ${next.paired ? "on" : "off"}`;
  $("capabilityCount").textContent = `${next.capabilities?.length || 0} capabilities`;
  $("lastAction").textContent = next.lastAction
    ? `${next.lastAction.ok ? "OK" : "Failed"}: ${next.lastAction.kind} - ${next.lastAction.summary || "completed"}`
    : "No MCP action yet";
  if (next.armedTab) {
    $("tabBadge").textContent = "Armed";
    $("tabBadge").className = "badge on";
    $("tabTitle").textContent = next.armedTab.title || "Untitled tab";
    $("tabOrigin").textContent = next.armedTab.origin;
    $("disarmButton").hidden = false;
  } else {
    $("tabBadge").textContent = "None";
    $("tabBadge").className = "badge neutral";
    $("tabTitle").textContent = "No tab armed";
    $("tabOrigin").textContent = "Open a target page, then arm that tab.";
    $("disarmButton").hidden = true;
  }
}

async function refresh() {
  render(await send({ type: "state" }));
}

$("pairButton").addEventListener("click", async () => {
  try {
    $("pairButton").disabled = true;
    message("Pairing with the local bridge...");
    const next = await send({
      type: "pair",
      pairingCode: $("pairingCode").value.trim(),
      bridgeUrl: $("bridgeUrl").value.trim()
    });
    render(next);
    message("Paired. Arm one Chrome tab to continue.", "ok");
  } catch (error) {
    message(error.message, "error");
  } finally {
    $("pairButton").disabled = false;
  }
});

$("armButton").addEventListener("click", async () => {
  try {
    $("armButton").disabled = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error("No active tab is available.");
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) tabs can be armed.");
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.host}/*`] });
    if (!granted) throw new Error("Chrome did not grant access to this website.");
    render(await send({ type: "arm", tab: { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || "" } }));
    message("Current tab armed for this origin.", "ok");
  } catch (error) {
    message(error.message, "error");
  } finally {
    $("armButton").disabled = false;
  }
});

$("disconnectButton").addEventListener("click", async () => {
  try {
    render(await send({ type: "disconnect" }));
    $("pairingCode").value = "";
    message("Disconnected from the local bridge.");
  } catch (error) {
    message(error.message, "error");
  }
});

$("disarmButton").addEventListener("click", async () => {
  try {
    render(await send({ type: "disarm" }));
    message("Tab access removed. Pairing remains active.", "ok");
  } catch (error) {
    message(error.message, "error");
  }
});

$("dashboardButton").addEventListener("click", async () => {
  try {
    const bridge = new URL(state?.bridgeUrl || $("bridgeUrl").value || "http://127.0.0.1:8790");
    await chrome.tabs.create({ url: `${bridge.origin}/ui#v5` });
  } catch (error) {
    message(error.message, "error");
  }
});

refresh().catch((error) => message(error.message, "error"));
