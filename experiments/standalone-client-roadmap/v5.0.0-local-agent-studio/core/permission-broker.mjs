const MAX_AUDIT = 300;

const ACTIONS = new Map([
  ["tool:call", { risk: "medium", confirmation: "tool:call" }],
  ["provider-key:set", { risk: "sensitive", confirmation: "provider-key:set" }],
  ["provider-key:delete", { risk: "sensitive", confirmation: "provider-key:delete" }],
  ["license:activate", { risk: "sensitive", confirmation: "license:activate" }],
  ["license:delete", { risk: "sensitive", confirmation: "license:delete" }],
  ["mcp-server:start", { risk: "high", confirmation: "mcp-server:start" }],
  ["mcp-server:stop", { risk: "high", confirmation: "mcp-server:stop" }],
  ["approval:mutate", { risk: "high", confirmation: "approval:mutate" }],
  ["support-bundle:export", { risk: "sensitive", confirmation: "support-bundle:export" }],
  ["release-update:verify", { risk: "high", confirmation: "release-update:verify" }],
  ["release-update:stage", { risk: "high", confirmation: "release-update:stage" }],
  ["customer-update:run", { risk: "high", confirmation: "customer-update:run" }]
]);

export class PermissionBroker {
  constructor({ strict = true } = {}) {
    this.strict = strict;
    this.audit = [];
  }

  require(action, body = {}, metadata = {}) {
    const definition = ACTIONS.get(action);
    if (!definition) throw new PermissionDeniedError(`Unknown privileged action: ${action}`, 403, action);
    const intent = normalizeIntent(body.intent);
    const allowed =
      intent.action === action &&
      intent.confirm === definition.confirmation;
    const entry = {
      at: new Date().toISOString(),
      action,
      risk: definition.risk,
      allowed,
      route: metadata.route || "",
      method: metadata.method || "",
      target: safeTarget(metadata.target),
      reason: allowed ? "confirmed" : "missing structured confirmation"
    };
    this.record(entry);
    if (!allowed && this.strict) {
      throw new PermissionDeniedError(
        `Action ${action} requires intent.action="${action}" and intent.confirm="${definition.confirmation}".`,
        428,
        action,
        definition.risk
      );
    }
    return entry;
  }

  publicAudit(limit = 100) {
    return this.audit.slice(-Number(limit || 100)).map((entry) => ({ ...entry }));
  }

  summary() {
    return {
      strict: this.strict,
      privilegedActions: ACTIONS.size,
      recentDenied: this.audit.slice(-50).filter((entry) => !entry.allowed).length
    };
  }

  record(entry) {
    this.audit.push(entry);
    if (this.audit.length > MAX_AUDIT) this.audit.splice(0, this.audit.length - MAX_AUDIT);
  }
}

export class PermissionDeniedError extends Error {
  constructor(message, status = 428, action = "", risk = "") {
    super(message);
    this.name = "PermissionDeniedError";
    this.status = status;
    this.action = action;
    this.risk = risk;
  }
}

export function privilegedIntent(action) {
  const definition = ACTIONS.get(action);
  if (!definition) throw new Error(`Unknown privileged action: ${action}`);
  return { action, confirm: definition.confirmation };
}

function normalizeIntent(value) {
  if (!value || typeof value !== "object") return {};
  return {
    action: String(value.action || ""),
    confirm: String(value.confirm || "")
  };
}

function safeTarget(value) {
  return String(value || "").replace(/[^\w .:@/-]+/g, "").slice(0, 160);
}
