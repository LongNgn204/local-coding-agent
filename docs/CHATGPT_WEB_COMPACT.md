# ChatGPT Web Compact & Resume

Local Coding Agent v4.4.3 provides a local MCP checkpoint for continuing a long
coding task in a fresh ChatGPT Web conversation. It does not read, modify, or
control ChatGPT's internal context window.

## English

### What It Preserves

- Current goal and concise factual state.
- Decisions and constraints that still apply.
- Verified completed work and remaining tasks.
- Exact next action and key workspace-relative files.
- Server-collected Git state, recent tests, task-plan progress, and MCP activity.

It does not intentionally preserve the full transcript, full source files, full
logs, credentials, cookies, runtime keys, or customer secrets.

### Compact A Long Chat

Generate the prompt locally:

```powershell
node scripts/local-coding-agent.mjs prompt compact
```

Paste it into the current ChatGPT Web conversation. ChatGPT should call:

```text
context_status
compact_context
```

`context_status` estimates pressure only from MCP tool traffic. It cannot see
ChatGPT Web's real token count or context limit. `compact_context` stores an
immutable local checkpoint under the workspace-specific `server/data/` store.

### Resume In A Fresh Chat

Generate and paste the resume prompt:

```powershell
node scripts/local-coding-agent.mjs prompt resume
```

The fresh chat should call `resume_context` first, then verify `workspace_info`
and `git_status` before editing. New user instructions always override the saved
checkpoint.

### Security

- Checkpoints are local and `server/data/` is ignored by Git.
- Common credential patterns are redacted on a best-effort basis.
- Compact fields are size-bounded; long source/log dumps are truncated.
- Compact payload fields are redacted from the Local Coding Agent audit log.
- Strict policy treats `compact_context` as a local write and blocks it.
- `resume_context` and `context_status` are read-only.
- Keep `MCP_AUTH_TOKEN` enabled when the MCP endpoint is exposed beyond trusted
  loopback/private-tunnel use.

Never place credentials or private customer data in `compact_context`, even
with redaction enabled.

## Tiếng Việt

### Nội Dung Được Giữ Lại

- Mục tiêu hiện tại và trạng thái thực tế đã tóm tắt.
- Các quyết định và ràng buộc vẫn còn hiệu lực.
- Công việc đã kiểm chứng hoàn thành và việc còn lại.
- Hành động kế tiếp chính xác và các file chính theo đường dẫn tương đối.
- Git state, test gần đây, tiến độ task plan và hoạt động MCP do server thu thập.

Hệ thống không chủ động lưu toàn bộ transcript, toàn bộ source, full log,
credential, cookie, runtime key hoặc secret của khách hàng.

### Compact Một Chat Dài

Tạo prompt tại máy:

```powershell
node scripts/local-coding-agent.mjs prompt compact
```

Dán prompt vào cuộc trò chuyện ChatGPT Web hiện tại. ChatGPT sẽ gọi:

```text
context_status
compact_context
```

`context_status` chỉ ước tính áp lực từ lưu lượng tool MCP. Nó không thấy số
token hoặc giới hạn context thật của ChatGPT Web. `compact_context` lưu một
checkpoint bất biến trong vùng `server/data/` riêng của workspace.

### Resume Trong Chat Mới

Tạo và dán prompt resume:

```powershell
node scripts/local-coding-agent.mjs prompt resume
```

Chat mới phải gọi `resume_context` đầu tiên, sau đó kiểm tra `workspace_info` và
`git_status` trước khi sửa code. Yêu cầu mới nhất của người dùng luôn có ưu tiên
cao hơn checkpoint đã lưu.

### Bảo Mật

- Checkpoint nằm tại máy và `server/data/` đã được Git bỏ qua.
- Các mẫu credential phổ biến được redact theo best effort.
- Trường compact có giới hạn kích thước; source/log dài sẽ bị cắt.
- Nội dung capsule được che khỏi audit log của Local Coding Agent.
- Policy `strict` xem `compact_context` là ghi dữ liệu cục bộ và sẽ chặn nó.
- `resume_context` và `context_status` chỉ đọc.
- Bật `MCP_AUTH_TOKEN` nếu MCP endpoint được đưa ra ngoài loopback hoặc private
  tunnel đáng tin cậy.

Không đưa credential hoặc dữ liệu riêng của khách vào `compact_context`, kể cả
khi đã có cơ chế redact.
