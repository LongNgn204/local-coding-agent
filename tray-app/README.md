# Local Coding Agent - Windows Tray App

A small C#/.NET WinForms tray app that runs and supervises the Local Coding
Agent on one machine:

- Starts/stops the Node MCP server (`server/server.mjs`) and the OpenAI Secure
  Tunnel.
- A form to set the workspace root(s), mode, policy, ports, Runtime API key,
  Tunnel ID, and Organization ID.
- A v5 profile manager for named multi-path permission sets. Each
  path can be `observe`, `edit`, `develop`, or `full_control`, with optional
  deny globs and a separate per-profile working path.
- Stores the Runtime API key encrypted with Windows DPAPI (per user), never as
  plain text.
- Writes the tunnel profile YAML from the form so changing Tunnel ID or MCP URL
  does not require hand-editing config files.
- Health-gated startup: the tray waits for MCP `/healthz` before it launches
  the tunnel, preventing the one-shot `initial mcp probe failed` race.
- Automatic tunnel recovery with bounded retry/backoff, plus a manual
  **Reconnect tunnel** action that leaves the healthy Node server running.
- Live status distinguishes a running process from a connected `main` channel
  and shows only the final eight Tunnel ID characters for stale-connector
  diagnosis.
- One-click **Copy local MCP URL**, **Copy Tunnel ID**, and **Open Dashboard**.
- Optional **Allow prompt-requested shutdown** switch. It exposes dedicated
  status/schedule/cancel tools without weakening the permanent `run_command`
  shutdown block. Once enabled, an explicit shutdown prompt executes through
  the dedicated tool immediately by default, without a dashboard approval.
- **Stop is authoritative**: it stops the server/tunnel even if they were
  started outside the app, for example by the launcher script.

Full documentation and security model: see the [repository README](../README.md).

## Requirements

- **Build:** .NET SDK (project targets `net10.0-windows`):
  https://aka.ms/dotnet/download
- **Run after self-contained publish:** nothing extra.
- Node.js for the MCP server.
- `tunnel-client.exe`, obtained separately from OpenAI.

## Build / run

```powershell
cd tray-app
dotnet run

# Or publish a single self-contained exe in .\publish:
powershell -ExecutionPolicy Bypass -File .\build.ps1

# Official stable release (versioned output):
powershell -ExecutionPolicy Bypass -File .\build-release.ps1
```

## First-time setup in the app

1. Launch the app. Path fields auto-fill relative to the repo; set
   **Workspace** to the folder you want the agent to work in.
2. Choose **Mode** (`safe` recommended) and **Policy** (`balanced`
   recommended; `strict` = read-only, `full` = no local approval gate).
3. Point **tunnel-client.exe** at your copy.
4. Enter **Tunnel ID** (`tunnel_...`) from ChatGPT/OpenAI and the
   **Organization ID** (`org_...` or the organization value shown in Platform).
   Click **Save tunnel**. This rewrites the profile YAML.
5. Paste the **Runtime API key** into **Runtime API key** and click
   **Save key**. This is the Platform runtime key, not the Admin key used to
   create/manage tunnels.
6. Click **Start**. The tray starts the MCP server, waits until `/healthz`
   reports ready, and only then starts `tunnel-client` with the generated
   profile. It retries a failed initial MCP probe automatically:

For v5 multi-path permissions, click **Manage authorized paths...**,
create or select a named profile, add its roots, assign each root a rights
preset, and click **Save & use**. The profile store is kept in the current
user's app-data directory by default and must remain outside every authorized
root.

The status line must say **Tunnel: CONNECTED** before testing from ChatGPT.
Compare the eight-character Tunnel ID suffix shown by the tray with the suffix
in any ChatGPT tunnel error. If they differ, ChatGPT is using a stale connector:
disable/delete that connector, create or select the connector associated with
the current Tunnel ID, then retry. Never paste the Runtime API key into logs or
support messages.

## Prompt-requested shutdown

This Windows-only feature is off by default. Enable **Allow prompt-requested
shutdown (immediate, no approval)**, then click **Start** to apply it. A prompt
must explicitly request shutdown. The agent should:

1. Call `system_power_status`.
2. Complete and verify any requested task.
3. Call `schedule_system_shutdown` as its final tool action with
   `confirmation=SHUTDOWN_AFTER_TASK`. Omit the delay, or set it to `0`, to
   shut down immediately. No dashboard approval is requested.

Use `cancel_system_shutdown` only when a non-zero delay was requested. Raw shutdown,
restart, and power commands remain blocked in `run_command`.

```text
CONTROL_PLANE_API_KEY=<saved runtime key>
control_plane.tunnel_id=<Tunnel ID>
control_plane.extra_headers=["OpenAI-Organization: <Organization ID>"]
```

The Organization ID fixes tunnel-client errors like:

```text
tunnel_active_organization_required
Configure the organization ID or send the OpenAI-Organization header.
```

Closing the window keeps it in the tray. Tray -> **Exit** fully stops it.

## Where settings live

`%APPDATA%\LocalCodingAgent\config.json`

The API key is the DPAPI-encrypted `EncryptedKey` field, decryptable only by the
same Windows user on the same machine. Tunnel ID and Organization ID are not
encrypted because they are routing/configuration values, not model/API secrets.

Hidden helper: `LocalCodingAgentTray.exe --kill-strays` stops any running
server/tunnel headlessly.
