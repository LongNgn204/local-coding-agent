---
name: setup-local-coding-agent
description: Install Local Coding Agent for a customer using the universal CLI, safe defaults, and verification checks.
---

# Setup Local Coding Agent

Use this when a customer asks an AI agent to clone, install, configure, and
start Local Coding Agent.

## Rules

- Do not install system dependencies without asking first.
- Do not download or commit `tunnel-client`; the customer must provide it.
- Do not print, commit, or upload API keys, tunnel IDs, auth tokens, or local config.
- Default to `mode=safe` and `policy=balanced`.
- Prefer the universal CLI over the Windows tray app unless the customer asks for GUI.

## Steps

1. Check prerequisites:
   - `node -v` must be 18 or newer.
   - `git --version` should work.
2. Clone the repo if needed:
   - `git clone https://github.com/LongNgn204/local-coding-agent.git`
3. Enter the repo and install:
   - Windows: `scripts\lca.cmd install`
   - macOS/Linux: `bash scripts/lca install`
4. Run setup:
   - Windows: `scripts\lca.cmd setup`
   - macOS/Linux: `bash scripts/lca setup`
5. Ask the customer for:
   - workspace path
   - tunnel-client path, only if using ChatGPT Web tunnel
   - Tunnel ID
   - Organization ID if required
   - Runtime API key, preferably via `CONTROL_PLANE_API_KEY`
6. Start:
   - Windows: `scripts\lca.cmd start`
   - macOS/Linux: `bash scripts/lca start`
7. Verify:
   - `http://127.0.0.1:8787/healthz`
   - `http://127.0.0.1:8790/ui`
   - `scripts\lca.cmd status` or `bash scripts/lca status`

## Report Back

Return:

- repo path
- workspace path
- MCP URL
- dashboard URL
- mode and policy
- tunnel status
- any missing requirement and the exact next fix
