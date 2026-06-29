# Local Coding Agent

A local **MCP server** that lets ChatGPT Web (or any MCP client) act as a coding
agent on **your own machine** — read/write files, run commands, manage
background processes, and use git — confined to folders you choose. Ships with a
**Windows tray app** to manage it and a **local metrics dashboard**.

> ⚠️ This tool can run commands on your computer. Read **[SECURITY.md](SECURITY.md)**
> before using it. It is not a sandbox; only connect workspaces you trust.

**🇬🇧 English** · **[🇻🇳 Tiếng Việt](#tiếng-việt)**

---

## English

### Features

- **20+ coding tools** over MCP: `repo_overview`, `list_files`, `find_files`,
  `read_file`, `read_many` (batch read), `search_text` (ripgrep/git, with
  context + glob), `write_file`, `replace_in_file`, `apply_patch` (multi-file),
  `make_dir`, `move_path`, `delete_path`, `run_command` (cmd/powershell/bash),
  background processes (`proc_start/list/output/stop`), `git`, and notes.
- **Speed-tuned**: compact JSON, relative paths, batch reads, one-call repo map —
  fewer round-trips over the tunnel.
- **Safety layers**: loopback-only bind, root confinement, `safe`/`full` modes,
  catastrophic-command blocklist, optional bearer token, audit log.
- **Windows tray app** (C#/.NET): start/stop, status, copy MCP URL, encrypted
  key storage (DPAPI), authoritative Stop.
- **Local dashboard** (`/ui`): tool-call metrics, estimated token throughput, a
  per-minute chart, top tools, and recent calls with error reasons.

### Architecture

```
ChatGPT Web
   │  (HTTPS via the OpenAI Secure MCP Tunnel — private to your account)
   ▼
tunnel-client.exe  ──►  Node MCP server (127.0.0.1:8787)  ──►  your files/commands
                              │
                              └─► local dashboard (127.0.0.1:8790/ui, not tunneled)

Windows tray app supervises the node server + tunnel-client.
```

### Repository layout

```
server/      Node MCP server (server.mjs) + tests
tray-app/    C#/.NET WinForms tray app (source)
scripts/     start-tunnel.ps1 launcher
tools/        (you create) place your tunnel-client.exe here — gitignored
```

### Prerequisites

- **Node.js 18+** (for the server).
- **.NET 8+ SDK** (only if you build the tray app).
- A **ChatGPT account** with MCP connector / Apps access.
- The **OpenAI Secure MCP Tunnel client** (`tunnel-client.exe`). It is **not
  included** in this repo (proprietary). Obtain it from OpenAI and place it at
  `tools/tunnel-client.exe`.

### Quick start

**1) Run the MCP server**

```bash
cd server
npm install
#   PowerShell:  $env:AGENT_WORKSPACE="C:\path\to\your\repo"
#   bash:        export AGENT_WORKSPACE="/path/to/your/repo"
npm start
```

Check it: open `http://127.0.0.1:8787/healthz` and the dashboard
`http://127.0.0.1:8790/ui`.

**2) Expose it to ChatGPT via the secure tunnel**

Put your `tunnel-client.exe` in `tools/`, then:

```powershell
# edit the variables at the top of the script first (workspace, tunnel path)
powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
```

Paste your tunnel Runtime API key when prompted, then add the resulting MCP URL
as a connector in ChatGPT.

**3) (Optional) Use the tray app instead of scripts**

```powershell
cd tray-app
dotnet run
# or build a single self-contained exe:
powershell -ExecutionPolicy Bypass -File build.ps1
```

### Connect it to ChatGPT Web

> Requires a ChatGPT plan that supports custom MCP connectors. Menu names may
> differ slightly by version.

1. **Start the agent.** Run the tray app (set **Workspace** to the folder you
   want the agent to work in, pick **Mode**, click **Start**). The header should
   read `Server: ONLINE`.
2. **Create a connector in ChatGPT.** ChatGPT → **Settings → Connectors** →
   enable **Developer mode** → **Create / Add custom connector** (MCP). ChatGPT
   gives you a **Runtime / control-plane API key** for the secure tunnel.
3. **Start the tunnel with that key.** In the tray app paste the key into
   **CONTROL_PLANE_API_KEY → Save key**, then **Start** (or run
   `scripts/start-tunnel.ps1` and paste the key when prompted). The tunnel links
   your local server to your ChatGPT account.
4. **Finish & enable.** Complete the connector in ChatGPT, then enable it in a
   new chat.
5. **Verify.** In the chat, send: *“Call workspace_info — what are roots and
   mode?”* It should return your workspace path and mode. That confirms the path
   ChatGPT actually reads/writes through MCP.

**Change the working folder later:** edit **Workspace (root)** (or **Extra
roots**) → **Save settings → Start** (it restarts with the new path). Re-run
`workspace_info` to confirm. The dashboard (`/ui`) also shows the active roots.

**Troubleshooting**
- *Server offline* → click Start; open `http://127.0.0.1:8787/healthz`.
- *Tunnel fails to start ("bind 127.0.0.1:8788")* → the tunnel client owns 8788;
  keep the dashboard on **8790** (not 8788).
- *Tools don't appear* → ensure the connector is enabled in the chat and
  Developer mode is on.
- *Edits land "nowhere"* → you may have two clones; `workspace_info` shows the
  exact path being used — point Workspace at the one you mean.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | MCP endpoint port. |
| `AGENT_HOST` | `127.0.0.1` | Bind address (keep loopback). |
| `AGENT_WORKSPACE` | `../agent-workspace` | Primary root the agent may touch. |
| `AGENT_EXTRA_ROOTS` | _(empty)_ | Extra roots, `;`-separated. |
| `AGENT_MODE` | `safe` | `safe` = conservative blocklist; `full` = unrestricted inside roots. |
| `AGENT_ALLOW_DANGEROUS` | _(unset)_ | `1` allows catastrophic system commands. Leave unset. |
| `MCP_AUTH_TOKEN` | _(empty)_ | If set, `/mcp` requires `Authorization: Bearer <token>`. |
| `DASHBOARD_PORT` | `8790` | Local dashboard (`0` disables). Avoid `8788` (the tunnel uses it). |

### Security

See **[SECURITY.md](SECURITY.md)**. In short: it is not a sandbox, prompt
injection is real, keep `safe` mode unless you know what you're doing, and never
expose it on a public tunnel without `MCP_AUTH_TOKEN`.

### License

**[AGPL-3.0-or-later](LICENSE)** © 2026 Long Nguyễn ([@LongNgn204](https://github.com/LongNgn204)).

Free and open source. You may use, study, modify, and share it — but if you
distribute it or run a modified version as a network service, you must release
your source under the same AGPL-3.0 license and keep the copyright notice. This
keeps the project free for everyone and prevents closed, proprietary forks.

> This project is not affiliated with or endorsed by OpenAI. "ChatGPT" and
> related marks belong to their owners. You must obtain the tunnel client and
> use ChatGPT in accordance with OpenAI's terms.

---

## Tiếng Việt

Một **MCP server cục bộ** giúp ChatGPT Web (hoặc bất kỳ MCP client nào) hoạt động
như một coding agent **trên chính máy của bạn** — đọc/ghi file, chạy lệnh, quản lý
tiến trình nền, dùng git — giới hạn trong các thư mục bạn chọn. Kèm **app tray
Windows** để quản lý và một **dashboard số liệu cục bộ**.

> ⚠️ Công cụ này có thể chạy lệnh trên máy bạn. Hãy đọc **[SECURITY.md](SECURITY.md)**
> trước khi dùng. Đây không phải sandbox; chỉ kết nối workspace bạn tin tưởng.

### Tính năng

- **Hơn 20 tool coding** qua MCP: `repo_overview`, `list_files`, `find_files`,
  `read_file`, `read_many` (đọc nhiều file 1 lần), `search_text` (ripgrep/git,
  kèm context + glob), `write_file`, `replace_in_file`, `apply_patch` (sửa nhiều
  file), `make_dir`, `move_path`, `delete_path`, `run_command`
  (cmd/powershell/bash), tiến trình nền (`proc_start/list/output/stop`), `git`,
  và ghi chú.
- **Tối ưu tốc độ**: JSON gọn, đường dẫn tương đối, đọc theo lô, map repo trong 1
  lần gọi — giảm round-trip qua tunnel.
- **Nhiều lớp an toàn**: chỉ bind loopback, giới hạn thư mục gốc, chế độ
  `safe`/`full`, blocklist lệnh thảm hoạ, token tuỳ chọn, audit log.
- **App tray Windows** (C#/.NET): start/stop, trạng thái, copy MCP URL, lưu key
  mã hoá (DPAPI), nút Stop dừng được cả tiến trình ngoài app.
- **Dashboard cục bộ** (`/ui`): số liệu tool, ước tính token, biểu đồ theo phút,
  top tool, và các lệnh gần đây kèm lý do lỗi.

### Kiến trúc

```
ChatGPT Web
   │  (HTTPS qua OpenAI Secure MCP Tunnel — riêng cho tài khoản của bạn)
   ▼
tunnel-client.exe  ──►  Node MCP server (127.0.0.1:8787)  ──►  file/lệnh của bạn
                              │
                              └─► dashboard cục bộ (127.0.0.1:8790/ui, KHÔNG qua tunnel)

App tray Windows giám sát node server + tunnel-client.
```

### Cấu trúc repo

```
server/      Node MCP server (server.mjs) + test
tray-app/    App tray C#/.NET WinForms (source)
scripts/     Launcher start-tunnel.ps1
tools/        (bạn tự tạo) đặt tunnel-client.exe ở đây — đã gitignore
```

### Yêu cầu

- **Node.js 18+** (cho server).
- **.NET 8+ SDK** (chỉ khi build app tray).
- Tài khoản **ChatGPT** có quyền dùng MCP connector / Apps.
- **OpenAI Secure MCP Tunnel client** (`tunnel-client.exe`). **Không kèm** trong
  repo (độc quyền). Hãy tự lấy từ OpenAI và đặt vào `tools/tunnel-client.exe`.

### Bắt đầu nhanh

**1) Chạy MCP server**

```bash
cd server
npm install
#   PowerShell:  $env:AGENT_WORKSPACE="C:\duong-dan\toi\repo"
#   bash:        export AGENT_WORKSPACE="/duong/dan/toi/repo"
npm start
```

Kiểm tra: mở `http://127.0.0.1:8787/healthz` và dashboard
`http://127.0.0.1:8790/ui`.

**2) Đưa ra ChatGPT qua secure tunnel**

Đặt `tunnel-client.exe` vào `tools/`, rồi:

```powershell
# sửa các biến ở đầu script trước (workspace, đường dẫn tunnel)
powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
```

Dán Runtime API key của tunnel khi được hỏi, rồi thêm MCP URL thu được làm
connector trong ChatGPT.

**3) (Tuỳ chọn) Dùng app tray thay cho script**

```powershell
cd tray-app
dotnet run
# hoặc build 1 file exe self-contained:
powershell -ExecutionPolicy Bypass -File build.ps1
```

### Kết nối với ChatGPT Web

> Cần gói ChatGPT hỗ trợ MCP connector tuỳ chỉnh. Tên menu có thể khác chút theo phiên bản.

1. **Khởi động agent.** Mở app tray (đặt **Workspace** = thư mục muốn agent làm
   việc, chọn **Mode**, bấm **Start**). Dòng đầu phải hiện `Server: ONLINE`.
2. **Tạo connector trong ChatGPT.** ChatGPT → **Settings → Connectors** → bật
   **Developer mode** → **Create / Add custom connector** (MCP). ChatGPT sẽ cấp
   một **Runtime / control-plane API key** cho secure tunnel.
3. **Chạy tunnel bằng key đó.** Trong app tray dán key vào
   **CONTROL_PLANE_API_KEY → Save key**, rồi **Start** (hoặc chạy
   `scripts/start-tunnel.ps1` và dán key khi được hỏi). Tunnel nối server local
   với tài khoản ChatGPT của bạn.
4. **Hoàn tất & bật.** Tạo xong connector trong ChatGPT, rồi bật nó trong một
   chat mới.
5. **Kiểm chứng.** Trong chat gõ: *“Gọi workspace_info — roots và mode là gì?”*
   Nó phải trả về đường dẫn workspace + mode → xác nhận đúng path ChatGPT đọc/ghi
   qua MCP.

**Đổi thư mục làm việc sau này:** sửa **Workspace (root)** (hoặc **Extra roots**)
→ **Save settings → Start** (tự khởi động lại với path mới). Chạy lại
`workspace_info` để xác nhận. Dashboard (`/ui`) cũng hiện roots đang dùng.

**Khắc phục sự cố**
- *Server offline* → bấm Start; mở `http://127.0.0.1:8787/healthz`.
- *Tunnel không lên ("bind 127.0.0.1:8788")* → tunnel chiếm cổng 8788; để
  dashboard ở **8790** (đừng dùng 8788).
- *Không thấy tool* → đảm bảo đã bật connector trong chat và Developer mode đang bật.
- *Sửa file mà "không thấy đâu"* → có thể bạn có 2 bản clone; `workspace_info`
  cho biết path chính xác đang dùng — trỏ Workspace vào đúng bản bạn muốn.

### Cấu hình

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `PORT` | `8787` | Cổng MCP. |
| `AGENT_HOST` | `127.0.0.1` | Địa chỉ bind (giữ loopback). |
| `AGENT_WORKSPACE` | `../agent-workspace` | Thư mục gốc agent được phép đụng. |
| `AGENT_EXTRA_ROOTS` | _(trống)_ | Thư mục thêm, ngăn cách bằng `;`. |
| `AGENT_MODE` | `safe` | `safe` = chặn cẩn trọng; `full` = toàn quyền trong root. |
| `AGENT_ALLOW_DANGEROUS` | _(không đặt)_ | `1` cho phép lệnh hệ thống thảm hoạ. Nên để trống. |
| `MCP_AUTH_TOKEN` | _(trống)_ | Nếu đặt, `/mcp` yêu cầu `Authorization: Bearer <token>`. |
| `DASHBOARD_PORT` | `8790` | Dashboard cục bộ (`0` để tắt). Tránh `8788` (tunnel dùng). |

### Bảo mật

Xem **[SECURITY.md](SECURITY.md)**. Tóm tắt: đây không phải sandbox, prompt
injection là rủi ro thật, hãy giữ `safe` mode trừ khi bạn hiểu rõ, và đừng bao
giờ expose qua tunnel public mà không đặt `MCP_AUTH_TOKEN`.

### Giấy phép

**[AGPL-3.0-or-later](LICENSE)** © 2026 Long Nguyễn ([@LongNgn204](https://github.com/LongNgn204)).

Miễn phí và mã nguồn mở. Bạn được dùng, học hỏi, sửa đổi và chia sẻ — nhưng nếu
phân phối lại hoặc chạy bản đã sửa dưới dạng dịch vụ mạng, bạn **phải công khai
mã nguồn theo cùng giấy phép AGPL-3.0** và giữ nguyên dòng bản quyền. Điều này
giữ cho dự án luôn miễn phí với mọi người và **ngăn việc đem đóng kín/thương mại
hoá riêng**.

> Dự án không liên kết hay được bảo trợ bởi OpenAI. "ChatGPT" và các nhãn liên
> quan thuộc về chủ sở hữu của chúng. Bạn phải tự lấy tunnel client và dùng
> ChatGPT theo đúng điều khoản của OpenAI.
