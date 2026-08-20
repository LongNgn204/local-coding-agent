# AGENTS.md — setup guide for AI coding agents

If a user asks you (Claude Code, Codex, Cursor, or any LLM agent) to **install
and set up this repo**, follow these steps exactly. Keep the user informed and
ask before anything destructive.

## What this is
A local **MCP server** (`server/server.mjs`, Node.js) that lets ChatGPT Web act
as a coding agent on the user's machine, plus a cross-platform Electron
**Tray app** (`desktop-tray/`), **Local Codex Studio** (`desktop-app/`), a
classic Windows compatibility tray (`tray-app/`), and a local dashboard
(`http://127.0.0.1:8790/ui`).

## Prerequisites (check first; do not auto-install without asking)
- **Node.js ≥ 18** — `node -v`. If missing, point the user to https://nodejs.org.
- **The OpenAI tunnel client is NOT in this repo** (proprietary). The user must
  obtain it and place it at `tools/tunnel-client.exe` (Windows) or
  `tools/tunnel-client` (macOS/Linux). Never download/commit it.
- (Only when building the classic Windows tray) **.NET 10 SDK** —
  `dotnet --version`. Packaged Electron apps include their runtime.
- Optional: **ripgrep** (`rg`) makes search faster; the server auto-detects it.

## Install (one command)
- Windows: `pwsh -File install.ps1`  (or `powershell -ExecutionPolicy Bypass -File install.ps1`)
- macOS/Linux: `bash install.sh`

This runs `npm install` in `server/` and creates `tools/`. It does NOT need sudo.

## Run
1. Decide the **workspace** = the folder the agent may read/write. Confirm it
   with the user.
2. Start the server (pick one):
   - Script: set `AGENT_WORKSPACE` then run `scripts/start-tunnel.ps1` (Windows)
     or `scripts/start-tunnel.sh` (macOS/Linux). It also starts the tunnel.
   - Server only (no tunnel), for a quick check:
     `cd server && AGENT_WORKSPACE=<path> AGENT_MODE=safe npm start`
3. Connect ChatGPT: ChatGPT → Settings → Connectors → enable Developer mode →
   add a custom MCP connector. Paste the tunnel's runtime key when the launcher
   asks (`CONTROL_PLANE_API_KEY`).

## Verify (always do this)
- Health: `curl http://127.0.0.1:8787/healthz` → expect `{"status":"ok",...}`.
- Tools: run `npm run test:agent` from `server/` (exercises all tools).
- End-to-end: ask ChatGPT to "call workspace_info" → it returns `roots` + `mode`.
  Those roots are the exact path ChatGPT reads/writes.

## Key config (env vars, see server/README.md)
`AGENT_WORKSPACE` (root folder), `AGENT_MODE` = `safe`|`full`, `AGENT_EXTRA_ROOTS`
(`;`-sep), `AGENT_EXTRA_ROOTS_JSON` (preferred for paths with separators),
`MCP_AUTH_TOKEN`, `DASHBOARD_PORT` (default 8790), `PORT` (8787).

## Gotchas (read before debugging)
- **Default to `AGENT_MODE=safe`.** `full` lets `run_command` do almost anything
  inside the roots; catastrophic system commands stay blocked regardless.
- **Do NOT use port 8788** for the dashboard — the OpenAI tunnel client binds it.
- **Two-clone trap**: if edits seem to "disappear", the user may have two copies
  of their repo at different paths. `workspace_info` shows the real path in use.
- It is **not a sandbox**. For untrusted workspaces use a VM/container/WSL2.
- Windows PowerShell 5.1 reads `.ps1` as ANSI — keep scripts ASCII-only.

## Safety
Read `SECURITY.md`. Prompt injection is real; only connect trusted workspaces.
Never expose the server on a public tunnel without `MCP_AUTH_TOKEN`.
