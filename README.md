<div align="center">

<img src="docs/banner.svg" alt="Local Coding Agent" width="760" />

<h1>Local Coding Agent</h1>

<p><b>Turn ChatGPT Web into a coding agent on your own machine — via MCP.</b><br/>
Read/write files · run commands · background processes · git — confined to folders you choose.<br/>
Ships with a Windows tray app and a live local dashboard.</p>

<p>
  <a href="https://github.com/LongNgn204/local-coding-agent/releases"><img src="https://img.shields.io/github/v/release/LongNgn204/local-coding-agent?color=2dd4bf&label=release" alt="release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-60a5fa" alt="platforms" />
  <img src="https://img.shields.io/badge/MCP-server-a78bfa" alt="mcp" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="node" />
  <a href="https://github.com/LongNgn204/local-coding-agent/stargazers"><img src="https://img.shields.io/github/stars/LongNgn204/local-coding-agent?style=social" alt="stars" /></a>
</p>

<p><b>Works with</b><br/>
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-compatible-D97757?logo=anthropic&logoColor=white" />
  <img alt="OpenAI Codex" src="https://img.shields.io/badge/Codex-compatible-412991?logo=openai&logoColor=white" />
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-compatible-111111?logo=cursor&logoColor=white" />
  <img alt="ChatGPT Web" src="https://img.shields.io/badge/ChatGPT%20Web-MCP%20connector-10a37f?logo=openai&logoColor=white" />
</p>
<sub>Compatible with any MCP client · not affiliated with Anthropic or OpenAI.</sub>

<p><b>🇬🇧 English</b> · <a href="#tiếng-việt">🇻🇳 Tiếng Việt</a></p>

</div>

> ⚠️ This tool can run commands on your computer. Read **[SECURITY.md](SECURITY.md)**
> before using it. It is not a sandbox; only connect workspaces you trust.

<!-- Tip: drop a screen recording at docs/demo.gif and embed it here:
     <p align="center"><img src="docs/demo.gif" alt="demo" width="760"></p> -->

---

## English

### Install in one command

```powershell
# Windows
git clone https://github.com/LongNgn204/local-coding-agent.git
cd local-coding-agent; .\install.ps1
```
```bash
# macOS / Linux
git clone https://github.com/LongNgn204/local-coding-agent.git
cd local-coding-agent && bash install.sh
```

> **Using an AI agent (Claude Code / Codex / Cursor)?** Point it at
> **[AGENTS.md](AGENTS.md)** — it has exact, copy-pasteable setup steps so the
> agent can install & verify the repo for you.

### Features

- **25+ coding tools** over MCP: `repo_overview`, `list_files`, `find_files`,
  `read_file`, `read_many` (batch read), `search_text` (ripgrep/git, with
  context + glob), `write_file`, `replace_in_file`, `apply_patch` (multi-file),
  `make_dir`, `move_path`, `delete_path`, `run_command` (cmd/powershell/bash),
  background processes (`proc_start/list/output/stop`), git
  (`git`, `git_status`, `git_diff`), and notes.
- **Speed-tuned**: compact JSON, relative paths, batch reads, one-call repo map —
  fewer round-trips over the tunnel.
- **Safety layers**: loopback-only bind, root confinement, `safe`/`full` modes,
  catastrophic-command blocklist, optional bearer token, audit log.
- **Windows tray app** (C#/.NET): start/stop, status, copy MCP URL, encrypted
  key storage (DPAPI), authoritative Stop.
- **Local dashboard** (`/ui`): tool-call metrics, estimated token throughput, a
  per-minute chart, top tools, recent calls with error reasons, a **Files
  mini-IDE** (read-only file tree + viewer + `git diff`), and a clear-metrics
  button.
- **Skills** (Claude-style): drop reusable playbooks in `skills/` or your
  workspace's `.claude/skills/`; the agent discovers and loads them on demand
  via `list_skills` / `read_skill`, and can author/remove them with
  `create_skill` / `delete_skill` (instructions stay out of context until needed).

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
scripts/     start-tunnel.ps1 (Windows) + start-tunnel.sh (macOS/Linux)
tools/        (you create) place your tunnel-client.exe here — gitignored
```

### Platforms

The **server runs on Windows, macOS, and Linux** (it's Node.js). The **tray app
is Windows-only**; on macOS/Linux use the CLI launcher `scripts/start-tunnel.sh`.

### Prerequisites

- **Node.js 18+** (for the server).
- **.NET 8+ SDK** (only if you build the Windows tray app).
- A **ChatGPT account** with MCP connector / Apps access.
- The **OpenAI Secure MCP Tunnel client**. It is **not included** in this repo
  (proprietary). Obtain it from OpenAI and place it at `tools/tunnel-client.exe`
  (Windows) or `tools/tunnel-client` (macOS/Linux, `chmod +x` it).

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

Put your tunnel client in `tools/`, then run the launcher for your OS (edit the
variables at the top first, or set `AGENT_WORKSPACE`):

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
```
```bash
# macOS / Linux
chmod +x scripts/start-tunnel.sh
AGENT_WORKSPACE="/path/to/your/repo" bash scripts/start-tunnel.sh
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

### Cài đặt 1 lệnh

```powershell
# Windows
git clone https://github.com/LongNgn204/local-coding-agent.git
cd local-coding-agent; .\install.ps1
```
```bash
# macOS / Linux
git clone https://github.com/LongNgn204/local-coding-agent.git
cd local-coding-agent && bash install.sh
```

> **Dùng AI agent (Claude Code / Codex / Cursor)?** Chỉ nó vào file
> **[AGENTS.md](AGENTS.md)** — có sẵn các bước cài + kiểm chứng để agent tự dựng
> repo giúp bạn.

### Tính năng

- **Hơn 25 tool coding** qua MCP: `repo_overview`, `list_files`, `find_files`,
  `read_file`, `read_many` (đọc nhiều file 1 lần), `search_text` (ripgrep/git,
  kèm context + glob), `write_file`, `replace_in_file`, `apply_patch` (sửa nhiều
  file), `make_dir`, `move_path`, `delete_path`, `run_command`
  (cmd/powershell/bash), tiến trình nền (`proc_start/list/output/stop`), git
  (`git`, `git_status`, `git_diff`), và ghi chú.
- **Tối ưu tốc độ**: JSON gọn, đường dẫn tương đối, đọc theo lô, map repo trong 1
  lần gọi — giảm round-trip qua tunnel.
- **Nhiều lớp an toàn**: chỉ bind loopback, giới hạn thư mục gốc, chế độ
  `safe`/`full`, blocklist lệnh thảm hoạ, token tuỳ chọn, audit log.
- **App tray Windows** (C#/.NET): start/stop, trạng thái, copy MCP URL, lưu key
  mã hoá (DPAPI), nút Stop dừng được cả tiến trình ngoài app.
- **Dashboard cục bộ** (`/ui`): số liệu tool, ước tính token, biểu đồ theo phút,
  top tool, các lệnh gần đây kèm lý do lỗi, **mini-IDE Files** (cây thư mục +
  trình xem chỉ-đọc + `git diff`), và nút xoá số liệu.
- **Skills** (kiểu Claude): bỏ "playbook" tái dùng vào `skills/` hoặc
  `.claude/skills/` của workspace; agent tự dò và nạp khi cần qua `list_skills` /
  `read_skill`, và có thể tạo/xoá bằng `create_skill` / `delete_skill` (chỉ nạp
  lúc cần, đỡ tốn context).

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
scripts/     Launcher: start-tunnel.ps1 (Windows), start-tunnel.sh (macOS/Linux)
tools/        (bạn tự tạo) đặt tunnel-client.exe ở đây — đã gitignore
```

### Nền tảng

**Server chạy trên Windows, macOS và Linux** (vì là Node.js). **App tray chỉ cho
Windows**; trên macOS/Linux dùng launcher dòng lệnh `scripts/start-tunnel.sh`.

### Yêu cầu

- **Node.js 18+** (cho server).
- **.NET 8+ SDK** (chỉ khi build app tray Windows).
- Tài khoản **ChatGPT** có quyền dùng MCP connector / Apps.
- **OpenAI Secure MCP Tunnel client**. **Không kèm** trong repo (độc quyền). Tự
  lấy từ OpenAI, đặt vào `tools/tunnel-client.exe` (Windows) hoặc
  `tools/tunnel-client` (macOS/Linux, nhớ `chmod +x`).

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

Đặt tunnel client vào `tools/`, rồi chạy launcher theo hệ điều hành (sửa biến ở
đầu script hoặc set `AGENT_WORKSPACE`):

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
```
```bash
# macOS / Linux
chmod +x scripts/start-tunnel.sh
AGENT_WORKSPACE="/duong/dan/toi/repo" bash scripts/start-tunnel.sh
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
