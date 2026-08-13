---
name: setup-assistant
description: Guide a customer through installing, configuring, and verifying Local Coding Agent with safe defaults.
---

# Setup Assistant

Use this when a customer wants their AI agent to install and verify Local
Coding Agent from scratch. It keeps the ChatGPT thread light by pointing at
local tools instead of pasting long output.

## Rules

- Never install system dependencies without asking first.
- Never download or commit `tunnel-client`; the customer provides it.
- Never print or commit API keys, tunnel IDs, or auth tokens.
- Default to `mode=safe` and `policy=balanced`.

## Steps

1. Check prerequisites:
   - `node -v` must be 18 or newer.
   - `git --version` should work.
2. Install dependencies:
   - Windows: `scripts\lca.cmd install`
   - macOS/Linux: `bash scripts/lca install`
3. Configure the workspace with the customer's chosen folder:
   - `node scripts/local-coding-agent.mjs setup --workspace <path> --save`
4. Start the server (server-only check first):
   - `node scripts/local-coding-agent.mjs start --workspace <path> --no-tunnel`
5. Verify:
   - Health: `http://127.0.0.1:8787/healthz`
   - Dashboard: `http://127.0.0.1:8790/ui`
   - Tools: run `npm run test:agent` from `server/`.
6. For long output, keep raw logs in local report/support files and return only
   a compact summary.

## Report Back

Return: repo path, workspace path, MCP URL, dashboard URL, mode/policy,
whether health is `ok`, and the exact next fix for anything missing. For long
logs, attach the local file path instead of pasting them into chat.
