const MODES = new Set(["read-only", "workspace", "full"]);

const READ_ONLY_NAMES = /^(workspace_(info|snapshot)|repo_map|read(_|$)|read_many$|list(_|$)|search(_|$)|get(_|$)|git_(status|diff|show|log)|policy_status$|preview(_|$)|review_diff$|security_scan$|health(_|$)|check(_|$)|find(_|$))/i;
const WORKSPACE_WRITE_NAMES = /^(apply_patch$|replace_in_file$|write_file$|create_file$|mkdir$|format(_|$)|run_changed_tests$)/i;

export function normalizeAgentToolPolicy(value) {
  const mode = String(value || "read-only");
  if (!MODES.has(mode)) throw new Error(`Unsupported agent tool policy: ${mode}`);
  return mode;
}

export function evaluateAgentTool(tool, mode = "read-only") {
  const policy = normalizeAgentToolPolicy(mode);
  const name = String(tool?.name || "");
  const readOnlyHint = tool?.annotations?.readOnlyHint === true;
  const destructiveHint = tool?.annotations?.destructiveHint === true;
  if (!destructiveHint && (readOnlyHint || READ_ONLY_NAMES.test(name))) {
    return { allowed: true, mode: policy, level: "read", reason: "Read-only tool allowed." };
  }
  if (policy === "read-only") {
    return { allowed: false, mode: policy, level: "mutating", reason: "Read-only turn blocks mutating or unknown tools." };
  }
  if (!destructiveHint && WORKSPACE_WRITE_NAMES.test(name)) {
    return { allowed: true, mode: policy, level: "workspace", reason: "Workspace edit allowed." };
  }
  if (policy === "workspace") {
    return { allowed: false, mode: policy, level: destructiveHint ? "destructive" : "command", reason: "Workspace policy blocks commands, destructive, network, and unknown tools." };
  }
  return { allowed: true, mode: policy, level: destructiveHint ? "destructive" : "full", reason: "Full tool policy explicitly enabled for this turn." };
}

export function publicToolPolicyModes() {
  return ["read-only", "workspace", "full"];
}
