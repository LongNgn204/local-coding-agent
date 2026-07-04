# Local Codex Studio

A personal Electron desktop GUI that runs coding tasks locally through the
**OpenAI Codex CLI** (already installed and ChatGPT-authenticated on your
machine), reusing this repo's already-tested MCP backend (`server/server.mjs`).

It does **not** run its own server or turn-manager stack. On launch, the Electron
main process:

1. Spawns `server/server.mjs` as a loopback-only child with
   `AGENT_V5_PREVIEW=1`, a free `PORT` and `DASHBOARD_PORT`, your chosen
   `AGENT_WORKSPACE`, `AGENT_MODE` (safe/full), `AGENT_HOST=127.0.0.1`.
2. Waits for `GET /healthz` to return ok (polled, ~15s budget).
3. Connects an MCP client (`StreamableHTTPClientTransport`) to
   `http://127.0.0.1:<PORT>/mcp`.
4. Exposes IPC to the renderer via a hardened preload bridge (`window.studio`).

Mutations (create/cancel) and status go through the **MCP client**. Paginated
report/log viewing goes through the loopback **dashboard JSON endpoint**
(`/api/agent?id=&source=&offset=&limit=`). No new server endpoints were added.

On quit / all windows closed, the MCP client is closed and the server child is
tree-killed (`taskkill /PID <pid> /T /F` on Windows).

## Run (dev mode)

```
cd desktop-app
npm install        # downloads Electron (~150 MB) + Vite/React toolchain
npm run dev        # starts Vite (127.0.0.1:5199) then Electron pointed at it
```

Other scripts:

```
npm run build      # tsc typecheck + vite build of the renderer -> ui/dist
npm start          # electron on the built files (loads ui/dist/index.html)
npm test           # node --test test/backend.test.mjs (integration test)
```

## What you'll see

- **Top bar**: workspace path + Change, engine dropdown
  (`codex_cli` default | `script_runner`), mode dropdown (`safe` | `full`),
  a live server status pill, and "Open dashboard".
- **Left**: task list with status/role/engine/time badges and status filter
  chips (all / running / queued / done / failed / cancelled), auto-refresh ~3s.
- **Main**: a "New task" composer (role + title + task text + Run) and, when a
  task is selected, a detail view with a paginated Report/Log tabbed viewer and
  a Cancel button for running tasks.

The default engine is `codex_cli`, which runs your local, ChatGPT-authenticated
Codex CLI. Switch to `script_runner` for the built-in deterministic planner
(spends no Codex quota).

## Security

Electron is hardened: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, a strict CSP in `index.html`, external links blocked (opened in
the system browser instead), and only local content is loaded. The server stays
loopback-only. Secrets are never printed.

The app is **dev-run only** for now — it is not packaged to `.exe`.

---

## Tiếng Việt (ngắn gọn)

Local Codex Studio là ứng dụng desktop (Electron) chạy tác vụ code **cục bộ**
qua **OpenAI Codex CLI** (đã cài + đã đăng nhập ChatGPT), dùng lại backend MCP
đã kiểm thử của repo này (`server/server.mjs`).

Cách chạy (chế độ dev):

```
cd desktop-app
npm install     # tải Electron (~150 MB)
npm run dev     # chạy Vite rồi mở Electron
```

Giao diện: thanh trên chọn workspace / engine (`codex_cli` mặc định hoặc
`script_runner`) / mode (`safe`/`full`) + trạng thái server; danh sách task bên
trái; ô tạo task mới và khung xem Report/Log (có phân trang) ở giữa. Chọn
`script_runner` để không tốn quota Codex. Ứng dụng chỉ chạy dev, chưa đóng gói
`.exe`.
