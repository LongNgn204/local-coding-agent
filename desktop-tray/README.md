# Local Coding Agent Tray v5.0.1

Cross-platform Electron GUI (Windows / macOS / Linux) that supervises the
**Local Coding Agent** end to end without touching a terminal:

- Starts/stops the Node MCP server (`server/server.mjs`) with health-gated
  startup (waits for `/healthz` before considering the server online).
- Configures and runs the OpenAI Secure MCP Tunnel (profile YAML written from
  the form; tunnel ID + organization ID never need hand-editing).
- v5 named multi-path permission profiles via **Manage authorized paths...**
  (same `permission-profiles.json` store the universal CLI uses).
- Secrets (Runtime API key, MCP auth token) are encrypted with the platform
  secret store (macOS Keychain / Windows DPAPI) through Electron `safeStorage`;
  never written as plain text to config.
- Shares `cli-config.json` with `scripts/lca` so the GUI and the CLI agree on
  one configuration.
- System tray / menu bar with live server + tunnel status and Start / Stop /
  Reconnect Tunnel / Open Dashboard / Open Settings / Open Logs / Quit.
- Live status bar distinguishes server (`OFFLINE` / `STARTING` / `ONLINE` /
  `STOPPING` / `ERROR`) and tunnel (`STOPPED` / `STARTING` / `CONNECTED` /
  `RECONNECTING` / `ERROR` / `NOT CONFIGURED`), with the tunnel suffix shown
  for stale-connector diagnosis.
- Closing the window hides to tray; the agent keeps running.

## Requirements

- Packaged releases include their own Node runtime. Source/dev mode needs
  Node.js ≥ 18.
- The OpenAI tunnel client is **not shipped** (proprietary). Place your copy
  at `tools/tunnel-client` (macOS/Linux) or `tools/tunnel-client.exe`
  (Windows), or point the field at it in the GUI.

## Run (dev mode)

```
cd desktop-tray
npm install        # downloads Electron (~150 MB) + Vite/React toolchain
npm run dev        # starts Vite (127.0.0.1:5201) then Electron pointed at it
```

Other scripts:

```
npm run build      # tsc typecheck + vite build of the renderer -> ui/dist
npm run package    # Windows portable exe / macOS zip / Linux AppImage
npm run package:dir # unpacked smoke-test build for the current OS
npm start          # electron on the built files (loads ui/dist/index.html)
npm test           # node --test test/supervisor.test.mjs (no Electron needed)
```

Production packages include the tested MCP server runtime, but never the
proprietary OpenAI tunnel client. Release names are
`LocalCodingAgentTray-<version>-<os>-<arch>.<ext>`.

## First-time setup in the app

1. **Paths**: keep the auto-filled Node executable / MCP app folder, point
   **tunnel-client** at your copy.
2. **Agent**: set **Legacy workspace** (or create a named profile under
   **Manage authorized paths...**), pick **Mode** (`safe` recommended) and
   **Policy** (`balanced` recommended).
3. **Tunnel**: paste **Tunnel ID** (`tunnel_...`) and optional **Organization
   ID** (`org_...`), click **Save tunnel**. Paste the Runtime API key and
   click **Save key**.
4. Click **Start**. The app starts the server, waits for `/healthz`, then
   starts the tunnel when it is configured. The status line must say
   **Tunnel: CONNECTED** before testing from ChatGPT.

## Security

- Renderer is hardened: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, strict CSP, external links open in the system browser.
- Server stays loopback-only (`AGENT_HOST=127.0.0.1`).
- Secrets are never printed or logged in plain text.
- Never expose the MCP server on a public tunnel without `MCP_AUTH_TOKEN`.

## Where settings live

`~/Library/Application Support/LocalCodingAgent/` on macOS (app-data dir on
other platforms):

- `cli-config.json` — shared with the universal CLI (non-secret settings).
- `secrets.json` — encrypted Runtime API key + auth token.
- `permission-profiles.json` — v5 named multi-path profiles.
- `tray.log` — app/server/tunnel runtime log.

---

## Tiếng Việt (ngắn gọn)

Local Coding Agent Tray là GUI Electron đa nền tảng quản lý toàn bộ Local
Coding Agent: bật/tắt MCP server (chờ `/healthz` trước khi báo ONLINE), cấu
hình và chạy OpenAI Secure MCP Tunnel (ghi profile YAML tự động), quản lý
profile đa root v5, lưu secret qua Keychain (macOS) / DPAPI (Windows). Chia sẻ
`cli-config.json` với CLI `scripts/lca`. Có tray/menu bar: Start, Stop,
Reconnect Tunnel, Open Dashboard, Open Settings, Open Logs, Quit. Đóng cửa sổ
chỉ ẩn xuống tray, agent vẫn chạy. Chạy dev: `cd desktop-tray && npm install &&
npm run dev`.
