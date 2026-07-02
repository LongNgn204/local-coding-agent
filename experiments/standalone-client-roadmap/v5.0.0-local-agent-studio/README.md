# v5.0.0 Local Agent Studio Preview

Local Agent Studio is the productized desktop path for Local Coding Agent. It
keeps the MCP-powered local coding workflow, but moves the daily experience out
of ChatGPT Web and into a standalone app with durable threads, tool timeline,
workspace controls, diagnostics, and commercial-release guardrails.

## What Is Implemented

- OpenAI, Anthropic, and Ollama provider adapters.
- MCP server connect, tool listing, tool execution, and managed start/stop/status.
- React + Vite renderer with virtualized chat messages for long threads.
- Electron desktop shell with `nodeIntegration=false`, `contextIsolation=true`,
  renderer sandboxing, denied permission prompts, and local-only navigation.
- Typed desktop IPC bridge for privileged actions. The renderer can request only
  allowlisted actions; the Electron main process owns the local session token,
  injects structured intent, and rejects untrusted renderer origins.
- Workspace profiles, Skills controls, dashboard metrics, approvals, file
  preview, Git diff, support bundle export, and guarded customer update flow.
- Provider key setup from the app UI for OpenAI and Anthropic. Desktop uses
  Electron `safeStorage`; browser Preview uses the local encrypted vault. APIs
  return only metadata, never the saved key value.
- Loopback-only API boundary with Host/Origin validation, random per-process
  capability token, JSON-only mutation requests, CSP, no-sniff, anti-framing,
  restrictive permissions policy, and remote-MCP opt-in.
- Server-side permission broker for privileged routes. Manual tool calls,
  provider-key changes, managed server start/stop, customer updates, approval
  mutations, and support-bundle exports require structured intent confirmation
  and produce redacted audit metadata.
- Durable SQLite threads, turns, messages, and tool events.
- Recursive redaction for support bundles. Raw tool arguments/results are not
  exported in the event list.
- Ed25519 commercial license verification. Preview builds run without a key;
  Stable builds fail closed.
- Separate Ed25519 release-integrity verification and anti-backdoor source audit.
  Signing private keys are never stored in the app or repository.
- Automated tests for security, persistence, licensing, integrity, and HTTP
  boundary behavior.

## Run Preview

```powershell
npm install
npm run check
npm test
npm run security:audit
npm run ui:build
npm start
```

Open `http://127.0.0.1:5182`.

## Run Desktop Preview

```powershell
npm run ui:build
npm run desktop:dev
```

The desktop app starts the v5 Studio server as a local child process and opens
the app UI in Electron. The current Preview launcher uses the system `node`
binary, so Node.js 22.5+ is required because the thread store uses the built-in
SQLite module.

Production packaging should bundle or verify the runtime so customers do not
need to install Node.js manually.

## Runtime Packaging

The desktop launcher resolves Node.js in this order:

1. `LCA_NODE_PATH`
2. packaged runtime under Electron resources
3. source-tree runtime under `runtimes/node/<platform>-<arch>/`
4. system `node`

Expected bundled layout:

```text
runtimes/node/win32-x64/node.exe
runtimes/node/darwin-arm64/node
runtimes/node/linux-x64/node
```

Check the selected runtime:

```powershell
npm run runtime:verify
```

Release CI should place the runtime files and run:

```powershell
npm run runtime:verify -- --require-bundled
```

## Signed Release Updates

Preview can verify signed update manifests before any updater downloads or
installs a new app version. The verifier checks:

- Ed25519 signature from `LCA_UPDATE_PUBLIC_KEY_PEM`, `update-public-key.pem`,
  or the release public key fallback.
- product and channel match.
- HTTPS artifact URLs.
- SHA-256 artifact hashes.
- build number is not older than the current app or a previously verified build.

Generate a signed update manifest outside the app:

```powershell
$env:LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\update-private-key.pem"
npm run update:manifest -- --version v5.0.1 --build-number 500100 --platform win32 --arch x64 --artifact dist\\LocalAgentStudio.exe --url https://example.com/LocalAgentStudio.exe --out update-manifest.json
```

The private update signing key must never be committed, bundled, logged, or sent
to customers.

## Provider Keys

Preview can use provider keys from environment variables, desktop OS secure
storage, or the browser-preview encrypted vault:

- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` remain supported.
- Env keys are treated as readonly operator-managed secrets.
- Desktop keys are encrypted through Electron `safeStorage` and synchronized to
  the server only in memory through a separate per-process bridge token.
- Desktop save migrates away from the legacy AES vault copy after secure sync.
- Linux Electron `basic_text` fallback is rejected instead of treated as secure.
- Browser Preview keys use the AES-256-GCM vault under the Studio data directory.
- `GET /api/secrets` and health/provider APIs return only status metadata.

Stable still needs cross-platform installation testing for Windows DPAPI,
macOS Keychain, and Linux secret-service backends before customer release.

Check the actual Electron credential backend on the current machine:

```powershell
npm run credential:smoke
```

## Permission Broker

Privileged API routes require a structured intent:

```json
{
  "intent": {
    "action": "provider-key:set",
    "confirm": "provider-key:set"
  }
}
```

This is not a full OS sandbox. It is a server-side guardrail so renderer bugs,
browser-origin mistakes, and accidental direct API calls cannot silently perform
high-risk actions. Permission audit entries record action, risk, route, target,
and allow/deny status, but not raw request payloads or secrets.

In the desktop app, privileged UI actions use the typed IPC bridge instead of
constructing arbitrary privileged URLs in the renderer. Browser preview keeps a
fetch fallback for development.

## Build Desktop Package

```powershell
npm run desktop:pack
```

For release artifacts:

```powershell
npm run desktop:dist
```

Stable release builds still need signed installers, signed update manifests,
runtime bundling, and platform-specific code signing before customer release.

## Preview Licensing

No commercial key is required while `releaseStage` is `preview`.

Stable builds accept only an admin-issued license token signed outside the app.
The app contains only the public verification key. The admin private key must
never be committed, bundled, passed on a command line, placed in CI logs, or
sent to customers.

Release integrity uses a different signing key from customer licensing. See
`docs/SECURITY_AND_COMMERCIALIZATION.md` for the threat model and release gates.

## Production Exit Criteria

- A non-expert customer can install the app, connect a model key, select a
  workspace, ask the agent to inspect a repo, approve risky actions, and export
  a support report if something fails.
- The app can run without ChatGPT Web for the core coding workflow.
- The old ChatGPT Web connector workflow remains optional for users who prefer it.
- Commercial builds fail closed on missing license, invalid release integrity,
  or tampered runtime files.

---

# v5.0.0 Local Agent Studio Preview (Tiếng Việt)

Local Agent Studio là hướng desktop thương mại hóa của Local Coding Agent. App
vẫn giữ workflow coding local qua MCP, nhưng chuyển trải nghiệm hằng ngày ra
khỏi ChatGPT Web và đưa vào app riêng có thread bền vững, timeline tool,
workspace controls, diagnostics và các lớp kiểm soát để phát hành thương mại.

## Đã Có Gì

- Adapter cho OpenAI, Anthropic và Ollama.
- Kết nối MCP server, liệt kê tool, chạy tool, start/stop/status server do app quản lý.
- Renderer React + Vite với chat message được virtualize để thread dài không kéo lag.
- Electron desktop shell với `nodeIntegration=false`, `contextIsolation=true`,
  renderer sandbox, từ chối permission prompt và chỉ cho điều hướng local.
- Typed desktop IPC bridge cho action có quyền cao. Renderer chỉ được yêu cầu
  các action trong allowlist; Electron main process giữ local session token,
  tự gắn structured intent và từ chối renderer origin không tin cậy.
- Workspace profiles, Skills controls, dashboard metrics, approvals, file
  preview, Git diff, support bundle export và guarded customer update flow.
- Setup provider key ngay trong UI cho OpenAI và Anthropic. Desktop dùng Electron
  `safeStorage`; browser Preview dùng local encrypted vault. API chỉ trả metadata,
  không trả giá trị key đã lưu.
- API chỉ nghe loopback, kiểm tra Host/Origin, token ngẫu nhiên theo từng tiến
  trình, thao tác thay đổi chỉ nhận JSON, CSP, no-sniff, anti-framing,
  permissions policy chặt và remote MCP phải bật thủ công.
- Permission broker chạy ở server cho các route có quyền cao. Manual tool call,
  thay đổi provider key, start/stop managed server, customer update, approval
  mutation và support-bundle export đều cần structured intent confirmation và
  tạo audit metadata đã rút gọn.
- SQLite lưu bền thread, turn, message và tool event.
- Support bundle có redaction đệ quy. Event list không xuất raw tool args/results.
- Xác minh license thương mại bằng Ed25519. Bản Preview chạy không cần key; bản
  Stable sẽ fail closed.
- Xác minh release integrity bằng Ed25519 riêng và có anti-backdoor source audit.
  Private key dùng để ký không được lưu trong app hoặc repo.
- Test tự động cho security, persistence, licensing, integrity và HTTP boundary.

## Chạy Preview

```powershell
npm install
npm run check
npm test
npm run security:audit
npm run ui:build
npm start
```

Mở `http://127.0.0.1:5182`.

## Chạy Desktop Preview

```powershell
npm run ui:build
npm run desktop:dev
```

Desktop app sẽ start v5 Studio server như một local child process và mở UI trong
Electron. Launcher Preview hiện dùng binary `node` của máy, nên cần Node.js
22.5+ vì thread store dùng SQLite tích hợp của Node.

Bản production nên bundle hoặc kiểm tra runtime để khách hàng không phải tự cài
Node.js.

## Runtime Packaging

Desktop launcher resolve Node.js theo thứ tự:

1. `LCA_NODE_PATH`
2. packaged runtime trong Electron resources
3. source-tree runtime ở `runtimes/node/<platform>-<arch>/`
4. system `node`

Layout runtime đi kèm:

```text
runtimes/node/win32-x64/node.exe
runtimes/node/darwin-arm64/node
runtimes/node/linux-x64/node
```

Kiểm tra runtime đang được chọn:

```powershell
npm run runtime:verify
```

Release CI nên đặt runtime file vào đúng layout rồi chạy:

```powershell
npm run runtime:verify -- --require-bundled
```

## Signed Release Updates

Preview có thể verify update manifest đã ký trước khi updater tải hoặc cài bản
mới. Verifier kiểm tra:

- Chữ ký Ed25519 từ `LCA_UPDATE_PUBLIC_KEY_PEM`, `update-public-key.pem`, hoặc
  fallback sang release public key.
- Product và channel phải khớp.
- Artifact URL phải dùng HTTPS.
- Artifact phải có SHA-256 hash.
- Build number không được cũ hơn app hiện tại hoặc build đã verify trước đó.

Tạo signed update manifest ở bên ngoài app:

```powershell
$env:LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\update-private-key.pem"
npm run update:manifest -- --version v5.0.1 --build-number 500100 --platform win32 --arch x64 --artifact dist\\LocalAgentStudio.exe --url https://example.com/LocalAgentStudio.exe --out update-manifest.json
```

Private key ký update tuyệt đối không được commit, bundle, ghi vào log hoặc gửi
cho khách hàng.

## Provider Keys

Preview có thể dùng provider key từ biến môi trường, desktop OS secure storage
hoặc encrypted vault của browser preview:

- Vẫn hỗ trợ `OPENAI_API_KEY` và `ANTHROPIC_API_KEY`.
- Key từ env được xem là readonly secret do operator quản lý.
- Desktop key được mã hóa qua Electron `safeStorage` và chỉ sync vào RAM của
  server qua bridge token riêng theo từng tiến trình.
- Khi desktop lưu key thành công, app dọn legacy AES vault copy.
- Linux Electron `basic_text` fallback bị từ chối, không được xem là bảo mật.
- Browser Preview vẫn dùng AES-256-GCM vault trong thư mục dữ liệu Studio.
- `GET /api/secrets` và API health/provider chỉ trả metadata trạng thái.

Bản Stable vẫn cần kiểm thử cài đặt thực tế trên Windows DPAPI, macOS Keychain
và Linux secret-service trước khi phát hành cho khách hàng.

Kiểm tra Electron credential backend thật trên máy hiện tại:

```powershell
npm run credential:smoke
```

## Permission Broker

Các API có quyền cao cần intent có cấu trúc:

```json
{
  "intent": {
    "action": "provider-key:set",
    "confirm": "provider-key:set"
  }
}
```

Đây chưa phải OS sandbox đầy đủ. Nó là guardrail ở server để lỗi renderer, lỗi
browser origin hoặc việc gọi API trực tiếp không thể âm thầm chạy hành động rủi
ro cao. Permission audit chỉ ghi action, risk, route, target và trạng thái
allow/deny; không ghi raw payload hoặc secret.

Trong desktop app, UI dùng typed IPC bridge cho action có quyền cao thay vì tự
tạo URL nhạy cảm trong renderer. Browser preview vẫn có fetch fallback để dev
dễ chạy.

## Build Desktop Package

```powershell
npm run desktop:pack
```

Để tạo artifact release:

```powershell
npm run desktop:dist
```

Bản Stable vẫn cần signed installer, signed update manifest, bundle runtime và
ký code theo từng hệ điều hành trước khi phát hành cho khách hàng.

## License Preview

Khi `releaseStage` là `preview`, app chưa cần key thương mại.

Bản Stable chỉ chấp nhận license token do admin ký ở bên ngoài app. App chỉ chứa
public verification key. Admin private key tuyệt đối không được commit, bundle,
truyền qua command line, đặt trong CI log hoặc gửi cho khách hàng.

Release integrity dùng khóa ký riêng với customer licensing. Xem
`docs/SECURITY_AND_COMMERCIALIZATION.md` để biết threat model và release gates.

## Tiêu Chí Lên Production

- Khách không chuyên có thể cài app, nhập model key, chọn workspace, yêu cầu
  agent inspect repo, approve hành động rủi ro và export support report khi lỗi.
- App chạy được workflow coding chính mà không phụ thuộc ChatGPT Web.
- Workflow connector ChatGPT Web cũ vẫn là tùy chọn cho người thích dùng.
- Bản thương mại fail closed nếu thiếu license, release integrity sai hoặc file
  runtime bị chỉnh sửa.
