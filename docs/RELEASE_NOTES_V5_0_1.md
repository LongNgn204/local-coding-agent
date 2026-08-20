# Local Coding Agent v5.0.1

Maintenance release focused on reliable Windows and macOS delivery.

## Downloads

- `LocalCodingAgentTray-5.0.1-win-x64.exe`
- `LocalCodingAgentTray-5.0.1-mac-arm64.zip` (Apple Silicon)
- `LocalCodingAgentTray-5.0.1-mac-x64.zip` (Intel Mac)
- `LocalCodexStudio-5.0.1-win-x64.exe`
- `LocalCodexStudio-5.0.1-mac-arm64.zip` (Apple Silicon)
- `LocalCodexStudio-5.0.1-mac-x64.zip` (Intel Mac)
- `LocalCodingAgentTrayClassic-5.0.1-win-x64.exe` (compatibility)
- `ChromeCompanion-5.0.1.zip`

The Electron apps bundle the tested MCP server and Node runtime. The official
OpenAI tunnel client remains proprietary and is not included; select your own
copy in the Tray settings.

macOS builds are currently unsigned. If Gatekeeper blocks the app, right-click
it and choose **Open**, then confirm once. Windows SmartScreen may similarly ask
for confirmation because the portable binaries are not code-signed yet.

## Fixes

- Cross-platform Tray and Studio packages for Windows x64 and macOS arm64/x64.
- Writable per-user state for packaged server runtimes.
- Canonical multi-root path checks and filesystem-root rejection.
- Correct Windows shutdown executable paths in cross-platform code.
- Dashboard widgets fail independently instead of falsely marking the whole
  server offline.
- Expanded Windows/macOS/Linux CI and tag-driven release publishing.

---

## Tiếng Việt

Đây là bản bảo trì tập trung hoàn thiện phát hành cho Windows và macOS. Tray và
Studio đã kèm MCP server cùng Node runtime; tunnel client chính thức không được
đóng gói vì là phần mềm độc quyền, người dùng cần tự tải và chọn đúng file.

Bản macOS hiện chưa ký chứng thư. Nếu Gatekeeper chặn, hãy nhấp chuột phải vào
app, chọn **Open** và xác nhận một lần. Windows SmartScreen cũng có thể hiện cảnh
báo tương tự vì file portable chưa được ký số.

[Full changelog](https://github.com/LongNgn204/local-coding-agent/compare/v5.0.0...v5.0.1)
