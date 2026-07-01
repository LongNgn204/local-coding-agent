---
name: customer-support
description: Collect safe Local Coding Agent support context from a customer and produce a concise troubleshooting response.
---

# Customer Support

Use this when helping a customer install, update, debug, or report an issue.

## Rules

- Ask for reports, not secrets.
- Never request API keys, full tunnel profiles, private source files, or raw logs
  containing secrets.
- Prefer commands that produce redacted output.
- Keep the response actionable and short.

## Useful Commands

- `scripts\lca.cmd status` / `bash scripts/lca status`
- `scripts\lca.cmd doctor` / `bash scripts/lca doctor`
- `node scripts/network-doctor.mjs`
- `node scripts/validate-skills.mjs`
- `git status --short --branch`

## Response Template

1. State what the error means in plain language.
2. Identify whether it is local server, tunnel, network, auth, workspace, or
   packaging.
3. Ask for exactly one next report or command output.
4. Tell the customer what not to share.
5. Give a fallback path, such as server-only mode or mobile hotspot test.
