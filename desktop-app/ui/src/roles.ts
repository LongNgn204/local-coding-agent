// The 6 roles the server exposes (server/agent-manager.mjs ROLES).
export const ROLES: { id: string; label: string }[] = [
  { id: "repo_setup", label: "Repo setup" },
  { id: "bug_fix", label: "Bug fix" },
  { id: "network_check", label: "Network check" },
  { id: "release_prep", label: "Release prep" },
  { id: "docs_update", label: "Docs update" },
  { id: "safety_review", label: "Safety review" }
];

export const STATUS_FILTERS = ["all", "running", "queued", "done", "failed", "cancelled"] as const;

export function roleLabel(id: string): string {
  return ROLES.find((r) => r.id === id)?.label || id;
}

export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
