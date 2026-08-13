# Public Preview — Multi-root permission profiles

This feature is published as part of `v5.0.0-preview.12`. It remains
experimental: review every authorized path and use `observe`, `edit`, or
`develop` unless a trusted task genuinely requires `full_control`.

## Model

`working_directory` answers “where does the task start?” Authorized roots
answer “which paths may it use, and how?”. They are deliberately separate.

Each root has one preset:

| Preset | Filesystem | Commands | Intended use |
|---|---|---|---|
| `observe` | read | denied | Review source or documentation |
| `edit` | read/write | denied | Controlled content edits |
| `develop` | read/write | safe | Normal coding, build, and test work |
| `full_control` | read/write | full | Trusted automation only |

Catastrophic system commands remain blocked unless the separate dangerous
override is explicitly enabled. Shell commands are not an OS sandbox: a full
command can access more than its cwd. Use a VM/container/WSL2 for untrusted
workspaces.

Nested roots are supported. The most specific matching root supplies the
allow level, while any matching `deny` root or deny glob wins over an allow.
Paths are canonicalized through their longest existing ancestor, which closes
symlink and Windows junction escapes even for not-yet-created files.

## Store format

Keep the store outside every authorized workspace. The CLI and Desktop Studio
use the per-user application config directory by default.

```json
{
  "version": 1,
  "active_profile": "monorepo",
  "profiles": {
    "monorepo": {
      "version": 1,
      "name": "monorepo",
      "working_directory": "C:\\code\\app",
      "roots": [
        {
          "label": "Application",
          "path": "C:\\code\\app",
          "preset": "develop",
          "deny": [".env", "secrets/**"]
        },
        {
          "label": "Shared docs",
          "path": "D:\\shared\\docs",
          "preset": "edit"
        },
        {
          "label": "Reference source",
          "path": "D:\\shared\\reference",
          "preset": "observe"
        }
      ]
    }
  }
}
```

Server variables:

- `AGENT_PERMISSION_PROFILE_FILE`: absolute profile-store path.
- `AGENT_PERMISSION_PROFILE_NAME`: named profile to activate.
- `AGENT_PERMISSION_PROFILE_JSON`: direct JSON profile for ephemeral/test use.
- `AGENT_APPROVALS_DIR`: optional operator-owned approval storage override. It
  must remain outside every authorized root.
- `AGENT_WORKSPACE`, `AGENT_EXTRA_ROOTS`, and `AGENT_MODE`: automatically
  migrate to an equivalent legacy profile when no explicit profile is set.

## Local CLI

```powershell
node scripts/local-coding-agent.mjs permissions init --workspace "C:\code\app" --name monorepo
node scripts/local-coding-agent.mjs permissions add-root monorepo "D:\shared\docs" edit
node scripts/local-coding-agent.mjs permissions add-root monorepo "D:\shared\reference" observe
node scripts/local-coding-agent.mjs permissions list
node scripts/local-coding-agent.mjs permissions show monorepo
node scripts/local-coding-agent.mjs permissions use monorepo
```

Starting through the CLI automatically enables the public preview when a
permission profile file is configured. Desktop Studio exposes the same model
in its **Authorized paths** panel. The tray app accepts a profile file and name
for launch compatibility.

## Runtime grants

The MCP flow is intentionally two-party:

1. `request_path_access(path, preset, scope, reason)` creates an exact pending
   request. It grants nothing.
2. The local operator reviews and approves it in the loopback dashboard.
3. `activate_path_access(id)` consumes that exact approval.

Scopes:

- `once`: one successful MCP tool call.
- `session`: until server restart, expiry, or `revoke_path_access`.
- `profile`: persisted to the external profile store.

Use `permission_status` to inspect current roots and `check_path_access` to see
the exact rule deciding a path.

## Codex CLI provider

Raw Codex tasks receive the selected working directory with `--cd` and each
additional writable root with `--add-dir`. Roots containing deny globs are not
passed as writable because that flag cannot express deny rules; they remain
protected through MCP file tools. This is fail-closed by design.
