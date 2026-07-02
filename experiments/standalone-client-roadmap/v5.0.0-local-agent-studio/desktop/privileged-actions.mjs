const ALLOWED_PROVIDER = new Set(["openai", "anthropic"]);
const ALLOWED_APPROVAL_DECISION = new Set(["approve", "deny"]);

export function buildPrivilegedRequest(request = {}) {
  const action = String(request.action || "");
  const payload = request.payload && typeof request.payload === "object" ? request.payload : {};
  switch (action) {
    case "providerKey:set": {
      const provider = providerId(payload.provider);
      return jsonRequest("POST", `/api/secrets/${encodeURIComponent(provider)}`, {
        value: String(payload.value || ""),
        label: String(payload.label || `${provider} key`),
        intent: intent("provider-key:set")
      });
    }
    case "providerKey:delete": {
      const provider = providerId(payload.provider);
      return jsonRequest("DELETE", `/api/secrets/${encodeURIComponent(provider)}`, {
        intent: intent("provider-key:delete")
      });
    }
    case "license:activate":
      return jsonRequest("POST", "/api/license/activate", {
        token: String(payload.token || ""),
        intent: intent("license:activate")
      });
    case "license:delete":
      return jsonRequest("DELETE", "/api/license", {
        intent: intent("license:delete")
      });
    case "mcpServer:start":
      return jsonRequest("POST", "/api/server/start", {
        workspace: optionalString(payload.workspace),
        mode: payload.mode === "full" ? "full" : "safe",
        policy: ["strict", "balanced", "full"].includes(payload.policy) ? payload.policy : "balanced",
        intent: intent("mcp-server:start")
      });
    case "mcpServer:stop":
      return jsonRequest("POST", "/api/server/stop", {
        intent: intent("mcp-server:stop")
      });
    case "supportBundle:export":
      return jsonRequest("POST", "/api/support-bundle", {
        intent: intent("support-bundle:export")
      });
    case "releaseUpdate:verify":
      if (!payload.envelope || typeof payload.envelope !== "object") throw new Error("Signed update envelope is required.");
      return jsonRequest("POST", "/api/release-update/verify", {
        envelope: payload.envelope,
        persist: payload.persist !== false,
        intent: intent("release-update:verify")
      });
    case "releaseUpdate:stage":
      if (!payload.envelope || typeof payload.envelope !== "object") throw new Error("Signed update envelope is required.");
      return jsonRequest("POST", "/api/release-update/stage", {
        envelope: payload.envelope,
        platform: optionalPlatform(payload.platform),
        arch: optionalArch(payload.arch),
        intent: intent("release-update:stage")
      });
    case "tool:call":
      return jsonRequest("POST", "/api/call-tool", {
        name: safeToolName(payload.name),
        arguments: payload.arguments && typeof payload.arguments === "object" ? payload.arguments : {},
        intent: intent("tool:call")
      });
    case "approval:mutate": {
      const id = safeSegment(payload.id, "approval id");
      const decision = String(payload.decision || "");
      if (!ALLOWED_APPROVAL_DECISION.has(decision)) throw new Error("Invalid approval decision.");
      return jsonRequest("POST", `/api/approvals/${encodeURIComponent(id)}/${decision}`, {
        intent: intent("approval:mutate")
      });
    }
    case "customerUpdate:run":
      return jsonRequest("POST", "/api/update", {
        confirm: "update",
        force: payload.force === true,
        intent: intent("customer-update:run")
      });
    default:
      throw new Error(`Unknown privileged desktop action: ${action}`);
  }
}

export function privilegedActionNames() {
  return [
    "providerKey:set",
    "providerKey:delete",
    "license:activate",
    "license:delete",
    "mcpServer:start",
    "mcpServer:stop",
    "supportBundle:export",
    "releaseUpdate:verify",
    "releaseUpdate:stage",
    "tool:call",
    "approval:mutate",
    "customerUpdate:run"
  ];
}

function jsonRequest(method, path, body) {
  return { method, path, body };
}

function intent(action) {
  return { action, confirm: action };
}

function providerId(value) {
  const provider = String(value || "");
  if (!ALLOWED_PROVIDER.has(provider)) throw new Error("Unsupported provider.");
  return provider;
}

function optionalString(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function safeToolName(value) {
  const text = String(value || "");
  if (!/^[\w.-]{1,128}$/.test(text)) throw new Error("Invalid tool name.");
  return text;
}

function optionalPlatform(value) {
  const platform = String(value || process.platform);
  if (!/^(win32|darwin|linux)$/.test(platform)) throw new Error("Invalid update platform.");
  return platform;
}

function optionalArch(value) {
  const arch = String(value || process.arch);
  if (!/^(x64|arm64)$/.test(arch)) throw new Error("Invalid update architecture.");
  return arch;
}

function safeSegment(value, label) {
  const text = String(value || "");
  if (!/^[\w.-]{1,160}$/.test(text)) throw new Error(`Invalid ${label}.`);
  return text;
}
