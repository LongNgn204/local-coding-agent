---
name: update-local-coding-agent
description: Safely update an existing Local Coding Agent clone while preserving customer config, tunnel-client, and secrets.
---

# Update Local Coding Agent

Use this when a customer wants their local clone updated to the latest GitHub
version.

## Rules

- Do not delete the customer workspace.
- Do not delete `tools/tunnel-client*`.
- Do not print, commit, or upload API keys, tunnel IDs, tokens, or local config.
- Do not run `git reset --hard`, `git clean`, or destructive commands unless the
  customer explicitly approves.
- If there are local changes, summarize them and ask before continuing.

## Steps

1. Find the local `local-coding-agent` folder.
2. Run `git status --short --branch`.
3. If local changes exist, stop and ask before updating.
4. Fetch:
   - `git fetch origin main --tags`
5. Show incoming changes:
   - `git log --oneline --decorate --max-count=10 HEAD..origin/main`
6. Update safely:
   - `git pull --ff-only origin main`
7. Reinstall dependencies:
   - Windows: `scripts\lca.cmd install`
   - macOS/Linux: `bash scripts/lca install`
8. Validate:
   - `node --check scripts/local-coding-agent.mjs`
   - `node --check scripts/network-doctor.mjs`
   - `node scripts/validate-skills.mjs`
9. Run doctor/status:
   - Windows: `scripts\lca.cmd doctor` and `scripts\lca.cmd status`
   - macOS/Linux: `bash scripts/lca doctor` and `bash scripts/lca status`
10. Restart only if the customer wants the agent running:
   - stop, then start with the CLI wrapper for the OS.

## Report Back

Return:

- current commit
- current version from `/healthz` if running
- MCP URL
- dashboard URL
- workspace path
- mode and policy
- tunnel status
- any failed check and exact next command
