# v5.0.0-preview.9 — Local Sub-Agent Manager

> **Experimental.** Opt-in preview. Stable v4 behavior is unchanged unless you
> set `AGENT_V5_PREVIEW=1`. The preview API shape may change between previews.

> **ChatGPT Web does not run native sub-agents here. ChatGPT calls MCP tools;
> Local Coding Agent runs and tracks sub-agent tasks locally.**

Preview.6 keeps the same local task-agent model and adds customer setup/update/
diagnose prompt helpers in the CLI and dashboard v5 panel.

English first, Tiếng Việt bên dưới. Both sections have the same meaning.

---

## English

### What it is

A **Local Sub-Agent Manager** that runs specialist "sub-agent" tasks on your own
machine and stores their heavy logs/reports locally. ChatGPT only ever receives
a compact status + summary + a local path.

```
ChatGPT Web
  -> MCP Connector
    -> Local Coding Agent server
      -> Agent Manager
        -> Specialist agents (roles)
          -> Dashboard / log / report store (local, loopback only)
```

### Why it reduces ChatGPT Web lag

A long ChatGPT thread gets slow when it accumulates huge logs, command output,
diffs, and screenshots that the browser must keep in the DOM. With sub-agents,
the heavy work and its output stay **local**; the thread only carries small
summaries and ids. You inspect full output on the local dashboard or via the CLI.

### MCP tools (only when `AGENT_V5_PREVIEW=1`)

| Tool | Purpose | Output |
|---|---|---|
| `create_local_task` | Start a specialist task (optional `engine`: `script_runner` \| `codex_cli`) | `task_id`, `status`, dashboard link, message |
| `list_local_tasks` | List tasks (metadata only) | compact array, filter by `status` |
| `get_local_task_status` | One task's full status | metadata, no heavy output |
| `get_local_task_result` | One task's result | summary + report/log paths + **truncated** slice (`max_chars`) |
| `cancel_local_task` | Cancel a queued/running task | final status |

Every tool is **compact by default**. `get_local_task_result` truncates to `max_chars`
(default 2000) and always returns the local `report_path` / `log_path` for the
full content.

### Roles (specialists)

| Role | What it does |
|---|---|
| `repo_setup` | Install / verify / diagnose setup problems |
| `bug_fix` | Investigate errors, point at files, propose a focused fix plan |
| `network_check` | Network / customer diagnostics, redacted report |
| `release_prep` | Changelog, version notes, build checklist, readiness report |
| `docs_update` | Bilingual VI/EN doc updates with matching content |
| `safety_review` | Permission risks, token leaks, unsafe commands, tunnel exposure, redaction |

### Agent states

`queued` → `running` → `done` | `failed` | `cancelled`. Tasks left `running` when
the server restarts are marked `failed` (interrupted) on next start.

> **Shared store is safe (preview.5).** The CLI and the server can use the same
> workspace store at the same time: each run records the pid that owns it, so a
> second manager starting up leaves another manager's genuinely-running task
> alone (it only marks a task interrupted when the owning process is really gone).
> On timeout or cancel a stuck child is force-killed; if it still cannot be killed
> (e.g. Windows "Access is denied"), the task fails within a short grace period
> with a clear message naming the child pid to kill by hand — it never hangs.

### Use it from ChatGPT Web

1. `create_local_task` with a `role` and a `task`. You get an `task_id` back.
2. `get_local_task_status(task_id)` to see when it is `done`.
3. `get_local_task_result(task_id)` for a compact summary + local paths.
4. Open the full report/log on the dashboard, not in chat.

### Use it from the local dashboard

Open `http://127.0.0.1:8790/ui` and scroll to the **v5 preview → Local
sub-agents** panel:

- **Status filter chips** (All / running / queued / done / failed / cancelled)
  with live counts — click one to filter the list.
- A clean task table: agent id, role, title, status badge, created time.
- Click an `task_id` to open the **viewer**, with **Report / Log** tabs and
  **Prev / Next 200** line pagination. It shows `lines X-Y of N`, so the page
  never renders thousands of DOM nodes at once. Everything is loopback-only.

### Use it from the CLI

```bash
node scripts/local-coding-agent.mjs agents roles
node scripts/local-coding-agent.mjs agents spawn --role network_check --task "diagnose office network"
node scripts/local-coding-agent.mjs agents list
node scripts/local-coding-agent.mjs agents clean --days 7
```

The CLI shares the same workspace-scoped store as the server.

### Generate a customer support report

For a redacted, sendable diagnostic bundle (not agent-specific):

```bash
node scripts/support-report.mjs
node scripts/local-coding-agent.mjs support
```

### Local storage

Per workspace, under `server/data/workspaces/<id>/agents/`:

- `index.json` — compact metadata for all agents.
- `<agent_id>.log` — full execution log (redacted).
- `<agent_id>.report.md` — final report (redacted), when produced.

### Redaction

Before any report/log is written, secrets are redacted: API keys (`sk-…`,
`sk-proj-…`), GitHub/Slack tokens, `Bearer` tokens, `CONTROL_PLANE_API_KEY`,
`MCP_AUTH_TOKEN`, `AGENT_APPROVAL_TOKEN`, long tunnel ids, common
`api_key/token/secret/password/authorization` fields, and long opaque blobs.

### Providers (engines)

- `script_runner` — **implemented** (default). A local, deterministic planner.
  No network calls, no subprocess: safe and reproducible.
- `codex_cli` — **implemented** (preview.4). Runs the locally installed,
  already-authenticated **OpenAI Codex CLI** in its non-interactive `codex exec`
  mode. It maps the agent `mode` to a Codex sandbox (`safe` → `read-only`,
  `full` → `workspace-write`), runs the CLI in the task's `workspace_root`,
  disables approval prompts, enforces the `max_runtime_ms` timeout (default
  300000 ms, hard cap 600000 ms; on timeout it tree-kills the child and keeps the
  partial output), and is fully cancellable (`cancel_local_task` aborts and
  tree-kills the child — on Windows via `taskkill /T /F`). The task text is fed on
  Codex's stdin, so user input never touches a shell command line. It requires the
  Codex CLI on `PATH` and a prior `codex login`; if unavailable, `create_local_task`
  returns a clear error.
- `claude_cli`, `openai_api` — **detected but not implemented**. The server
  safely reports availability (PATH / `OPENAI_API_KEY`) without assuming any CLI
  is installed.

#### Choosing an engine

`create_local_task` takes an optional `engine` (`script_runner` | `codex_cli`,
default `script_runner`). From the CLI, use `--engine`:

```bash
# ChatGPT Web: create_local_task(role="docs_update", task="...", engine="codex_cli")

# CLI:
node scripts/local-coding-agent.mjs agents spawn \
  --role docs_update --task "Summarize the README" --engine codex_cli \
  --workspace "C:\\path\\repo"
```

A `codex_cli` task can take minutes; the CLI prints `running codex, this may take
a while...` while it waits. The dashboard agents table shows the engine per task.

### Safety limitations

- It is not an OS sandbox (see `SECURITY.md`). Sub-agents inherit the server's
  `mode`/`policy`.
- `workspace_root` must be inside the configured roots.
- The dashboard endpoints (`/api/agents`, `/api/agent`) are loopback-only and
  never tunneled.
- This is an experimental preview; do not rely on the API shape yet.

---

## Tiếng Việt

### Là gì

Một **Trình quản lý sub-agent cục bộ** chạy các tác vụ "sub-agent" chuyên biệt
ngay trên máy của bạn và lưu log/report nặng ở máy. ChatGPT chỉ nhận trạng thái
gọn + tóm tắt + đường dẫn cục bộ.

```
ChatGPT Web
  -> MCP Connector
    -> Local Coding Agent server
      -> Agent Manager
        -> Specialist agents (vai trò)
          -> Kho dashboard / log / report (cục bộ, chỉ loopback)
```

### Vì sao giảm lag ChatGPT Web

Thread ChatGPT dài bị chậm khi tích nhiều log, output lệnh, diff, ảnh chụp mà
trình duyệt phải giữ trong DOM. Với sub-agent, phần việc nặng và output ở lại
**máy cục bộ**; thread chỉ mang tóm tắt nhỏ và id. Bạn xem output đầy đủ trên
dashboard hoặc bằng CLI.

### Tool MCP (chỉ khi `AGENT_V5_PREVIEW=1`)

| Tool | Mục đích | Output |
|---|---|---|
| `create_local_task` | Bắt đầu tác vụ chuyên biệt (tùy chọn `engine`: `script_runner` \| `codex_cli`) | `task_id`, `status`, link dashboard, message |
| `list_local_tasks` | Liệt kê tác vụ (chỉ metadata) | mảng gọn, lọc theo `status` |
| `get_local_task_status` | Trạng thái đầy đủ 1 tác vụ | metadata, không kèm output nặng |
| `get_local_task_result` | Kết quả 1 tác vụ | tóm tắt + đường dẫn report/log + phần **cắt ngắn** (`max_chars`) |
| `cancel_local_task` | Hủy tác vụ đang chờ/chạy | trạng thái cuối |

Mọi tool **gọn mặc định**. `get_local_task_result` cắt theo `max_chars` (mặc định
2000) và luôn trả về `report_path` / `log_path` cục bộ để xem đầy đủ.

### Vai trò (chuyên gia)

| Vai trò | Làm gì |
|---|---|
| `repo_setup` | Cài / kiểm tra / chẩn đoán lỗi setup |
| `bug_fix` | Điều tra lỗi, chỉ ra file, đề xuất kế hoạch sửa gọn |
| `network_check` | Chẩn đoán mạng / khách, report đã redact |
| `release_prep` | Changelog, ghi chú phiên bản, checklist build, báo cáo sẵn sàng |
| `docs_update` | Cập nhật tài liệu song ngữ VI/EN khớp nội dung |
| `safety_review` | Rủi ro quyền, lộ token, lệnh nguy hiểm, expose tunnel, redaction |

### Trạng thái agent

`queued` → `running` → `done` | `failed` | `cancelled`. Tác vụ còn `running` khi
server khởi động lại sẽ được đánh dấu `failed` (bị gián đoạn).

> **Kho dùng chung an toàn (preview.5).** CLI và server có thể dùng chung một kho
> theo workspace cùng lúc: mỗi lần chạy ghi lại pid sở hữu nó, nên một manager
> khởi động sau sẽ để yên tác vụ đang thực sự chạy của manager khác (chỉ đánh dấu
> gián đoạn khi tiến trình sở hữu đã thực sự tắt). Khi hết giờ hoặc bị hủy, tiến
> trình con bị kẹt sẽ bị buộc dừng; nếu vẫn không dừng được (ví dụ Windows báo
> "Access is denied"), tác vụ sẽ chuyển sang `failed` trong một khoảng ân hạn ngắn
> kèm thông báo rõ ràng nêu pid tiến trình con cần tắt thủ công — không bao giờ bị
> treo.

### Dùng từ ChatGPT Web

1. `create_local_task` với `role` và `task`. Nhận về `task_id`.
2. `get_local_task_status(task_id)` để biết khi nào `done`.
3. `get_local_task_result(task_id)` để lấy tóm tắt gọn + đường dẫn cục bộ.
4. Mở report/log đầy đủ trên dashboard, không dán vào chat.

### Dùng từ dashboard cục bộ

Mở `http://127.0.0.1:8790/ui`, kéo tới bảng **v5 preview → Local sub-agents**:

- **Chip lọc trạng thái** (All / running / queued / done / failed / cancelled)
  kèm số đếm — bấm để lọc danh sách.
- Bảng tác vụ gọn: agent id, vai trò, tiêu đề, huy hiệu trạng thái, thời gian tạo.
- Bấm `task_id` để mở **trình xem**, có tab **Report / Log** và phân trang
  **Prev / Next 200** dòng. Hiển thị `lines X-Y of N` nên trang không bao giờ
  render hàng nghìn node DOM. Tất cả chỉ loopback.

### Dùng từ CLI

```bash
node scripts/local-coding-agent.mjs agents roles
node scripts/local-coding-agent.mjs agents spawn --role network_check --task "chan doan mang cong ty"
node scripts/local-coding-agent.mjs agents list
node scripts/local-coding-agent.mjs agents clean --days 7
```

CLI dùng chung kho theo workspace với server.

### Tạo báo cáo hỗ trợ khách

Gói chẩn đoán đã redact, gửi lại được (không riêng agent):

```bash
node scripts/support-report.mjs
node scripts/local-coding-agent.mjs support
```

### Lưu trữ cục bộ

Theo từng workspace, trong `server/data/workspaces/<id>/agents/`:

- `index.json` — metadata gọn của mọi agent.
- `<agent_id>.log` — log thực thi đầy đủ (đã redact).
- `<agent_id>.report.md` — report cuối (đã redact), khi có.

### Redaction

Trước khi ghi report/log, secret bị che: API key (`sk-…`, `sk-proj-…`), token
GitHub/Slack, token `Bearer`, `CONTROL_PLANE_API_KEY`, `MCP_AUTH_TOKEN`,
`AGENT_APPROVAL_TOKEN`, tunnel id dài, các trường
`api_key/token/secret/password/authorization`, và chuỗi bí mật dài.

### Provider (engine)

- `script_runner` — **đã có** (mặc định). Bộ lập kế hoạch cục bộ, xác định.
  Không gọi mạng, không spawn tiến trình: an toàn và tái lập được.
- `codex_cli` — **đã có** (preview.4). Chạy **Codex CLI của OpenAI** đã cài và
  đã đăng nhập sẵn trên máy, ở chế độ không tương tác `codex exec`. Nó ánh xạ
  `mode` của agent sang sandbox Codex (`safe` → `read-only`, `full` →
  `workspace-write`), chạy trong `workspace_root` của tác vụ, tắt hỏi phê duyệt,
  áp timeout `max_runtime_ms` (mặc định 300000 ms, trần cứng 600000 ms; khi hết
  giờ sẽ tree-kill tiến trình con và giữ lại output dở), và hủy được hoàn toàn
  (`cancel_local_task` sẽ abort và tree-kill tiến trình con — trên Windows dùng
  `taskkill /T /F`). Văn bản tác vụ được đưa qua stdin của Codex nên đầu vào của
  người dùng không bao giờ nằm trên dòng lệnh shell. Cần có Codex CLI trên `PATH`
  và đã `codex login`; nếu không, `create_local_task` trả về lỗi rõ ràng.
- `claude_cli`, `openai_api` — **phát hiện nhưng chưa cài đặt**. Server báo khả
  dụng an toàn (PATH / `OPENAI_API_KEY`) mà không giả định CLI đã cài.

#### Chọn engine

`create_local_task` nhận tham số tùy chọn `engine` (`script_runner` |
`codex_cli`, mặc định `script_runner`). Từ CLI dùng `--engine`:

```bash
# ChatGPT Web: create_local_task(role="docs_update", task="...", engine="codex_cli")

# CLI:
node scripts/local-coding-agent.mjs agents spawn \
  --role docs_update --task "Tom tat README" --engine codex_cli \
  --workspace "C:\\path\\repo"
```

Tác vụ `codex_cli` có thể chạy vài phút; CLI in `running codex, this may take a
while...` trong lúc chờ. Bảng agents trên dashboard hiển thị engine của từng tác vụ.

### Giới hạn an toàn

- Không phải sandbox hệ điều hành (xem `SECURITY.md`). Sub-agent kế thừa
  `mode`/`policy` của server.
- `workspace_root` phải nằm trong các root đã cấu hình.
- Endpoint dashboard (`/api/agents`, `/api/agent`) chỉ loopback, không qua tunnel.
- Đây là bản preview thử nghiệm; chưa nên phụ thuộc vào hình dạng API.
