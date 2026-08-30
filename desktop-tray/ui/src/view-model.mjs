const VALID_MODES = new Set(["safe", "full"]);
const VALID_POLICIES = new Set(["strict", "balanced", "full"]);
const VALID_THEMES = new Set(["system", "light", "dark"]);

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function getSetupIssues(config) {
  const issues = [];
  if (!hasText(config?.node)) issues.push("node");
  if (!hasText(config?.mcpAppDir)) issues.push("mcpAppDir");
  if (!hasText(config?.workspace)) issues.push("workspace");
  if (!VALID_MODES.has(config?.mode)) issues.push("mode");
  if (!VALID_POLICIES.has(config?.policy)) issues.push("policy");
  if (!validPort(config?.port)) issues.push("port");
  if (!validPort(config?.dashboardPort) || config.dashboardPort === 8788) issues.push("dashboardPort");
  return issues;
}

export function isSetupComplete(config) {
  return getSetupIssues(config).length === 0;
}

export function normalizeTheme(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_THEMES.has(normalized) ? normalized : "system";
}

export function effectiveTheme(preference, prefersDark) {
  const normalized = normalizeTheme(preference);
  if (normalized === "system") return prefersDark ? "dark" : "light";
  return normalized;
}

export function serverPresentation(server) {
  const state = String(server?.state || "offline").toLowerCase();
  if (state === "online") {
    const version = server?.version ? `v${server.version}` : "ready";
    const mode = server?.mode || "unknown mode";
    const policy = server?.policy || "unknown policy";
    const profile = server?.permissionProfile || "legacy";
    const roots = Number.isFinite(server?.roots) ? `${server.roots} path(s)` : "paths unavailable";
    return { label: "Server ONLINE", detail: `${version} · ${mode} · ${policy} · ${profile} · ${roots}`, tone: "ok" };
  }
  if (state === "starting") return { label: "Server STARTING", detail: "Waiting for the MCP health check.", tone: "warn" };
  if (state === "stopping") return { label: "Server STOPPING", detail: "Shutting down local processes safely.", tone: "warn" };
  if (state === "error") return { label: "Server ERROR", detail: server?.reason || "Inspect logs, correct the configuration, then retry.", tone: "error" };
  return { label: "Server OFFLINE", detail: "Start the agent when you are ready.", tone: "neutral" };
}

export function tunnelPresentation(tunnel) {
  const state = String(tunnel?.state || "stopped").toLowerCase();
  const reason = hasText(tunnel?.reason) ? tunnel.reason.trim() : "";
  if (state === "connected") return { label: "Tunnel CONNECTED", detail: reason || "Secure MCP tunnel is connected.", tone: "ok" };
  if (state === "starting") return { label: "Tunnel STARTING", detail: reason || "Establishing a secure connection.", tone: "warn" };
  if (state === "reconnecting") return { label: "Tunnel RECONNECTING", detail: reason || "Recovering the secure connection.", tone: "warn" };
  if (state === "error") return { label: "Tunnel ERROR", detail: reason || "Review the tunnel path, ID, organization, and runtime key.", tone: "error" };
  if (state === "not_configured") return { label: "Tunnel NOT CONFIGURED", detail: "Local-only operation is available.", tone: "neutral" };
  return { label: "Tunnel STOPPED", detail: reason || "The MCP server can still run locally.", tone: "neutral" };
}
