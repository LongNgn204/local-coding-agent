# Local Coding Agent — MCP server

A local MCP server that ChatGPT Web (or any MCP client) connects to as a tool.
It lets the model act like a coding agent on **your own machine** — read/write
files, run commands, manage background processes, and use git — confined to
folders you configure. It does **not** use an API key and does **not** automate
ChatGPT sessions; it is a normal MCP connector you authorize.

> Full documentation, security model, and setup: see the [repository README](../README.md).

## Tools

| Group | Tools |
|-------|-------|
| Info | `workspace_info`, `ping` |
| Read | `repo_overview`, `list_files`, `find_files`, `read_file`, `read_many`, `stat_path`, `search_text` (ripgrep/git, with context + glob) |
| Write | `write_file`, `replace_in_file`, `apply_patch`, `make_dir`, `move_path`, `delete_path` |
| Execute | `run_command` (cmd/powershell/bash) |
| Processes | `proc_start`, `proc_list`, `proc_output`, `proc_stop` |
| Git | `git` |
| Notes | `save_note`, `list_notes` |

## Run

```bash
cd server
npm install
# minimum: point it at a folder you want the agent to work in
#   Windows PowerShell:  $env:AGENT_WORKSPACE="C:\path\to\your\repo"
#   bash:                export AGENT_WORKSPACE="/path/to/your/repo"
npm start
```

- MCP endpoint: `http://127.0.0.1:8787/mcp`
- Health: `http://127.0.0.1:8787/healthz`
- Local dashboard: `http://127.0.0.1:8790/ui`

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | HTTP port for the MCP endpoint. |
| `AGENT_HOST` | `127.0.0.1` | Bind address. Keep loopback; the tunnel forwards to it. |
| `AGENT_WORKSPACE` | `../agent-workspace` | Primary root the agent may touch. |
| `AGENT_EXTRA_ROOTS` | _(empty)_ | Extra roots, `;`-separated. |
| `AGENT_MODE` | `safe` | `safe` = conservative blocklist; `full` = unrestricted **inside roots**. |
| `AGENT_ALLOW_DANGEROUS` | _(unset)_ | `1` allows even catastrophic system commands. Leave unset. |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, every `/mcp` request must send `Authorization: Bearer <token>`. |
| `DASHBOARD_PORT` | `8790` | Local-only metrics dashboard. `0` disables it. (Avoid 8788 — the OpenAI tunnel uses it.) |

## Test

```bash
npm run test:agent   # exercises every tool against a running server
```
