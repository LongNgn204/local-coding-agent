# v5.0.0-preview.12 — Local-first, multi-root workflow

> **Experimental.** This is a preview channel. Stable v4 behavior is unchanged
> unless you opt in with `AGENT_V5_PREVIEW=1`. Do not depend on the preview API
> shape staying stable across previews.

Preview.8 also includes the local task-agent manager documented in
[V5_SUBAGENTS.md](V5_SUBAGENTS.md), plus customer AI prompt generation, a
non-destructive setup wizard report, a skills doctor for support triage, and
the local-only Chrome Companion experiment documented in
[`experiments/chrome-companion-preview/README.md`](../experiments/chrome-companion-preview/README.md).

Preview.9 adds named multi-root permission profiles, per-path rights, deny
rules, approved runtime grants, Codex CLI `--add-dir` integration, and a local
profile manager. See [V5_MULTI_ROOT_PERMISSIONS.md](V5_MULTI_ROOT_PERMISSIONS.md).

Preview.12 lets the Windows tray's explicit shutdown opt-in authorize the
dedicated power tool directly. An explicit shutdown prompt now uses a zero-second
delay by default and does not create a second dashboard approval request. Raw
shutdown/restart commands remain blocked.

English below, Tiếng Việt bên dưới. Both sections have the same meaning.

---

## English

### Why v5 exists

ChatGPT Web becomes laggy when a single thread accumulates many messages, logs,
code blocks, screenshots, and long tool outputs. The browser has to keep all of
that in the DOM and re-render it. v5 preview's goal is simple:

> Keep the heavy information **local**. Send ChatGPT only compact summaries plus
> links/instructions so the web thread stays fast.

### What v5 preview changes

Nothing, until you enable it. The preview is fully opt-in:

```bash
# macOS/Linux
AGENT_V5_PREVIEW=1 AGENT_WORKSPACE=/path/repo npm --prefix server start
```

```powershell
# Windows PowerShell
$env:AGENT_V5_PREVIEW="1"
node scripts\local-coding-agent.mjs start --workspace "C:\path\repo" --no-tunnel
```

When enabled you get:

1. **A local report store.** Long output is written under
   `server/data/workspaces/<id>/reports/` (workspace-scoped, loopback dashboard
   only, never tunneled).
2. **New MCP tools:**
   - `save_report(title, content, kind?, format?)` — stores the content locally
     and returns only a compact head/tail summary, a `sha256`, the byte/line
     counts, a report `id`, and the local dashboard link. **The full content is
     not echoed back into chat.**
   - `read_report(id, offset_lines?, limit_lines?, max_chars?)` — paginated read
     so ChatGPT pulls only the slice it needs.
   - `list_reports(limit?)` — metadata only, most recent first.
   - `preview_status()` — versions, dashboard link, report count.
3. **A dashboard v5 panel** at `http://127.0.0.1:8790/ui` (anchor `#v5`):
   version, health, workspace roots, tool-call counts, recent errors, and a
   **paginated** report list (max 20 rows per page, so the page never renders
   thousands of DOM nodes at once). JSON endpoint: `GET /api/v5`.
4. **`healthz` fields** `preview_version` and `preview_enabled`.
5. **Customer flow helpers:**
   - `node scripts/local-coding-agent.mjs prompt setup`
   - `node scripts/local-coding-agent.mjs prompt update`
   - `node scripts/local-coding-agent.mjs prompt diagnose`
   - `node scripts/local-coding-agent.mjs setup-wizard`
   - `node scripts/local-coding-agent.mjs skills doctor`
   The dashboard v5 panel also has copy buttons for the same ChatGPT/Claude
   prompts.
6. **Chrome Companion preview:** an unpacked Manifest V3 extension pairs with
   the loopback dashboard server and exposes one operator-armed Chrome tab via
   `browser_status`, `browser_snapshot`, `browser_screenshot`,
   `browser_navigate`, `browser_tab_action`, `browser_click`, `browser_type`,
   `browser_scroll`, `browser_press`, and `browser_select`. Preview.8 adds
   compressed screenshots, viewport metadata, back/forward/reload, double
   click, scrolling, bounded key presses, native select changes, manual Disarm,
   capability reporting, and redacted last-action status. It is disabled unless
   `AGENT_V5_PREVIEW=1` and is distributed as experimental source that users
   load manually through Chrome's developer mode.

### How to actually reduce lag (recommended workflow)

1. **Start a new ChatGPT thread for each large task.** A fresh thread has no
   accumulated history to re-render. Do not keep piling onto a long, laggy one.
2. **Let the MCP tools read files** instead of pasting large content into chat.
   Ask the agent to `read_file` a line range, not to paste the whole file.
3. **Store long output locally.** When a command produces a big log, a failing
   test dump, or a large diff, tell the agent to `save_report` it and share only
   the returned `id` + the dashboard link.
4. **Read the details locally.** Open the dashboard to read the full content, or
   page through it with `read_report(id, offset_lines, limit_lines)`.
5. **Hand off with `checkpoint` / `resume`.** When a thread still grows long,
   `checkpoint` a compact summary, open a new chat, and `resume` first.

### Limits and knobs

- `AGENT_V5_PREVIEW` — enable the preview tools and instructions (default off).
- `AGENT_BROWSER_PREVIEW=0` — keep the rest of v5 enabled but disable Chrome
  Companion. Chrome Companion is enabled by default only inside the v5 preview.
- When preview is enabled, chat-facing defaults are intentionally smaller:
  `AGENT_READ_DEFAULT` defaults to 12,000 chars, `AGENT_CMD_OUTPUT_DEFAULT`
  defaults to 8,000 chars, and `AGENT_MAX_BATCH_READ_CHARS` defaults to
  120,000 chars. You can still override them for targeted reads.
- `AGENT_MAX_REPORTS` — max stored reports before old ones are trimmed
  (default 200, bounded 10–5000).
- Existing output limits still apply: `AGENT_READ_DEFAULT`,
  `AGENT_CMD_OUTPUT_DEFAULT`, `AGENT_MAX_COMMAND_OUTPUT`, etc.

### Future work (not in this preview)

- Automatic capture: transparently divert oversized tool outputs into the report
  store without an explicit `save_report` call.
- Full skill runtime execution (this preview ships skill discovery + manifests
  only; see `skills/README.md`).

---

## Tiếng Việt

### Vì sao có v5

ChatGPT Web bị lag khi một thread tích quá nhiều tin nhắn, log, khối code, ảnh
chụp và output tool dài. Trình duyệt phải giữ tất cả trong DOM và render lại.
Mục tiêu của v5 preview rất đơn giản:

> Giữ thông tin nặng ở **máy cục bộ**. Chỉ gửi cho ChatGPT tóm tắt gọn kèm
> liên kết/hướng dẫn để thread web luôn nhanh.

### v5 preview thay đổi gì

Không thay đổi gì, cho tới khi bạn bật. Bản preview hoàn toàn tùy chọn:

```bash
# macOS/Linux
AGENT_V5_PREVIEW=1 AGENT_WORKSPACE=/path/repo npm --prefix server start
```

```powershell
# Windows PowerShell
$env:AGENT_V5_PREVIEW="1"
node scripts\local-coding-agent.mjs start --workspace "C:\path\repo" --no-tunnel
```

Khi bật, bạn có:

1. **Kho report cục bộ.** Output dài được ghi trong
   `server/data/workspaces/<id>/reports/` (theo workspace, chỉ dashboard
   loopback, không bao giờ qua tunnel).
2. **Tool MCP mới:**
   - `save_report(title, content, kind?, format?)` — lưu nội dung cục bộ và chỉ
     trả về tóm tắt đầu/cuối gọn, `sha256`, số byte/dòng, một report `id`, và
     link dashboard cục bộ. **Nội dung đầy đủ không bị dội lại vào chat.**
   - `read_report(id, offset_lines?, limit_lines?, max_chars?)` — đọc có phân
     trang để ChatGPT chỉ lấy phần cần.
   - `list_reports(limit?)` — chỉ metadata, mới nhất trước.
   - `preview_status()` — phiên bản, link dashboard, số report.
3. **Bảng v5 trên dashboard** tại `http://127.0.0.1:8790/ui` (mỏ neo `#v5`):
   phiên bản, health, workspace roots, số lượt gọi tool, lỗi gần đây, và danh
   sách report **có phân trang** (tối đa 20 dòng mỗi trang, nên trang không bao
   giờ render hàng nghìn node DOM cùng lúc). Endpoint JSON: `GET /api/v5`.
4. **Trường trong `healthz`:** `preview_version` và `preview_enabled`.
5. **Công cụ hỗ trợ khách hàng:**
   - `node scripts/local-coding-agent.mjs prompt setup`
   - `node scripts/local-coding-agent.mjs prompt update`
   - `node scripts/local-coding-agent.mjs prompt diagnose`
   - `node scripts/local-coding-agent.mjs setup-wizard`
   - `node scripts/local-coding-agent.mjs skills doctor`
   Panel v5 trên dashboard cũng có nút copy cùng các prompt cho ChatGPT/Claude.
6. **Chrome Companion preview:** extension Manifest V3 dạng load-unpacked ghép
   với dashboard server loopback và chỉ cho MCP thao tác trên một tab do người
   dùng chủ động bật. Các tool gồm `browser_status`, `browser_snapshot`,
   `browser_screenshot`, `browser_navigate`, `browser_tab_action`,
   `browser_click`, `browser_type`, `browser_scroll`, `browser_press` và
   `browser_select`. Preview.8 bổ sung screenshot nén, metadata viewport,
   back/forward/reload, double click, cuộn trang, nhấn phím giới hạn, đổi native
   select, Disarm thủ công, báo capability và trạng thái hành động cuối đã rút
   gọn. Tính năng chỉ bật khi `AGENT_V5_PREVIEW=1`. Phải giữ thử nghiệm này ở
   local: không stage, commit, đóng gói hoặc phát hành chung với bản stable.

### Cách giảm lag thực sự (quy trình khuyến nghị)

1. **Mở thread ChatGPT mới cho mỗi tác vụ lớn.** Thread mới không có lịch sử
   tích lũy để render lại. Đừng dồn tiếp vào thread dài đang lag.
2. **Để tool MCP đọc file** thay vì dán nội dung lớn vào chat. Bảo agent
   `read_file` theo khoảng dòng, đừng dán cả file.
3. **Lưu output dài ở máy.** Khi một lệnh tạo log lớn, dump test lỗi, hay diff
   lớn, bảo agent `save_report` rồi chỉ chia sẻ `id` + link dashboard.
4. **Đọc chi tiết ở máy cục bộ.** Mở dashboard để đọc toàn bộ, hoặc phân trang
   bằng `read_report(id, offset_lines, limit_lines)`.
5. **Bàn giao bằng `checkpoint` / `resume`.** Khi thread vẫn dài lên, hãy
   `checkpoint` một tóm tắt gọn, mở chat mới, và `resume` trước.

### Giới hạn và tùy chỉnh

- `AGENT_V5_PREVIEW` — bật tool và hướng dẫn preview (mặc định tắt).
- `AGENT_BROWSER_PREVIEW=0` — vẫn bật các phần v5 khác nhưng tắt Chrome
  Companion. Chrome Companion chỉ mặc định bật bên trong kênh v5 preview.
- Khi bật preview, default trả dữ liệu vào chat sẽ nhỏ hơn có chủ ý:
  `AGENT_READ_DEFAULT` mặc định 12.000 ký tự, `AGENT_CMD_OUTPUT_DEFAULT` mặc
  định 8.000 ký tự, và `AGENT_MAX_BATCH_READ_CHARS` mặc định 120.000 ký tự. Bạn
  vẫn có thể override khi cần đọc đúng phần mục tiêu.
- `AGENT_MAX_REPORTS` — số report tối đa trước khi cắt bớt cái cũ
  (mặc định 200, trong khoảng 10–5000).
- Các giới hạn output hiện có vẫn áp dụng: `AGENT_READ_DEFAULT`,
  `AGENT_CMD_OUTPUT_DEFAULT`, `AGENT_MAX_COMMAND_OUTPUT`, ...

### Việc tương lai (chưa có trong preview này)

- Tự động thu output: chuyển ngầm output tool quá lớn vào kho report mà không
  cần gọi `save_report` tường minh.
- Thực thi skill runtime đầy đủ (bản preview này chỉ có khám phá skill +
  manifest; xem `skills/README.md`).
