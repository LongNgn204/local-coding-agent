# v5.0.0 Local Agent Studio Preview

Local Agent Studio is the productized desktop path for Local Coding Agent. It
keeps the MCP-powered local coding workflow, but moves the daily experience out
of ChatGPT Web and into a standalone app with durable threads, tool timeline,
workspace controls, diagnostics, and commercial-release guardrails.

## What Is Implemented

- OpenAI, Anthropic, and Ollama provider adapters.
- MCP server connect, tool listing, tool execution, and managed start/stop/status.
- React + Vite renderer with virtualized chat messages for long threads.
- Agent turns stream through `/api/turns/:id/events`, can be cancelled from the
  UI, recover interrupted turns on restart, compact older context into a bounded
  summary, and expose per-turn tool policies: `read-only`, `workspace`, `full`.
- Electron desktop shell with `nodeIntegration=false`, `contextIsolation=true`,
  renderer sandboxing, denied permission prompts, and local-only navigation.
- Typed desktop IPC bridge for privileged actions. The renderer can request only
  allowlisted actions; the Electron main process owns the local session token,
  injects structured intent, and rejects untrusted renderer origins.
- Workspace profiles, Skills controls, dashboard metrics, approvals, file
  preview, Git diff, support bundle export, and guarded customer update flow.
- Workspace Review modal with bounded directory browsing, path filtering,
  large-file preview, colored Git diff, and exact-action approval decisions.
  Tree and content render limits keep large repositories responsive.
- Reviewed Patch workflow with parallel dry-run/validation, SHA-256-bound
  one-time tickets, a ten-minute expiry, explicit apply confirmation, automatic
  MCP backup batches, and guarded undo of the latest patch batch.
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
- Recursive redaction for support bundles. Bundles include bounded previews of
  recent thread items, persistent turn status, and tool policy outcomes for
  customer diagnostics; the global event list still omits raw arguments and
  results.
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

The desktop app runs the v5 Studio server inside the Electron main process and
opens the local UI in a sandboxed renderer. Packaged customers do not need to
install Node.js: SQLite, the HTTP runtime, and maintenance scripts use the Node
runtime embedded in Electron. Managed MCP processes run through the same signed
executable with `ELECTRON_RUN_AS_NODE=1`.

## Self-Contained Desktop Runtime

Production files are packed into Electron ASAR. Release packaging excludes
development scripts, the standalone CLI entry point, and external Node runtime
folders from the customer artifact. Verify both the runtime and archive path:

```powershell
npm run desktop:smoke
npm run desktop:pack
npm run desktop:smoke:packaged
```

The packaged smoke starts the Studio API, opens SQLite, launches the managed MCP
server with the embedded runtime, checks `/healthz`, stops the process tree, and
asserts that the app ran from `app.asar`.

The original cross-platform application icon and its provenance notes live in
`build/`. Electron Builder derives the native Windows, macOS, and Linux icon
formats from that master PNG.

## Release Doctor

Run the release doctor before giving a build to testers or customers:

```powershell
npm run release:doctor
```

Preview mode is allowed to pass with warnings for missing production signing
material. Stable mode fails closed until the release branch has `releaseStage:
stable`, public verification keys, a valid integrity manifest, a packaged
artifact, and platform signing policy:

```powershell
npm run release:doctor -- --target stable --platform win32 --artifact "dist\\win-unpacked\\Local Agent Studio.exe" --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT
```

## Signed Release Updates

Preview can verify signed update manifests before any updater downloads or
installs a new app version. The verifier checks:

- Ed25519 signature from `LCA_UPDATE_PUBLIC_KEY_PEM`, `update-public-key.pem`,
  or the release public key fallback.
- product and channel match.
- HTTPS artifact URLs.
- SHA-256 artifact hashes.
- Windows Authenticode publisher/certificate policy or macOS TeamIdentifier.
- build number is not older than the current app or a previously verified build.
- minimum app version compatibility.

The Updates panel can download a signed artifact into private staging. Download
is streamed, bounded by the signed size, hashed during write, checked with the
native OS signature verifier, and deleted if any check fails. Stable Windows
and macOS manifests must include a platform-signature policy. A staged artifact
always reports `installReady: false`; Preview does not execute installers
automatically.

Sign the installer first, verify its platform signature, and only then generate
the update manifest. For Windows Authenticode:

```powershell
npm run signature:verify -- --artifact "dist\\Local Agent Studio.exe" --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT
```

Generate a signed update manifest outside the app:

```powershell
$env:LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\update-private-key.pem"
npm run update:manifest -- --version v5.0.1 --build-number 500100 --platform win32 --arch x64 --artifact "dist\\Local Agent Studio.exe" --url https://example.com/LocalAgentStudio.exe --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT --out update-manifest.json
```

For macOS, use `--team-id YOURTEAMID` with both commands. The current Preview
EXE is intentionally reported as unsigned until a real publisher certificate
is configured; it is not a production installer.

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

## Reviewed Patch Workflow

Open `Workspace Review`, select `Patch`, and paste a standard unified diff. The
workflow is deliberately split into separate trust steps:

1. `Preview` validates the diff locally, then runs `preview_patch` and
   `validate_patch` in parallel without writing files.
2. A successful preview creates an in-memory ticket bound to the exact diff by
   SHA-256. The ticket expires after ten minutes and never returns raw diff text
   through the public API.
3. `Apply` requires a second high-risk confirmation and consumes the ticket
   exactly once. The server applies only the private diff attached to that
   ticket; the renderer cannot replace it after review.
4. The MCP patch engine creates a workspace-scoped backup batch before writing.
   `Undo Last` requires its own high-risk confirmation and restores that latest
   batch.

The generic manual-tool route is read-only and cannot call `apply_patch` or
other mutating/unknown tools. A file may still change outside Studio between
preview and apply; the MCP patch engine re-matches hunk context and fails closed
on conflicts. This review layer is not an OS sandbox or a substitute for Git.

## Build Desktop Package

```powershell
npm run desktop:pack
```

For release artifacts:

```powershell
npm run desktop:dist
```

Stable release builds still need a real publisher certificate and installation
testing on each target OS before customer release.

## Preview Licensing

No commercial key is required while `releaseStage` is `preview`.

Stable builds accept only an admin-issued license token signed outside the app.
The app contains only the public verification key. The admin private key must
never be committed, bundled, passed on a command line, placed in CI logs, or
sent to customers.

Generate a license signing keypair on an admin machine:

```powershell
npm run license:keygen -- --out-dir "C:\\secure\\local-agent-studio-license"
```

Then issue a customer token from that admin machine:

```powershell
$env:LCA_LICENSE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\local-agent-studio-license\\license-private-key.pem"
npm run license:issue -- --license-id lic_customer_001 --customer-id customer_001 --edition pro --expires-at 2027-01-01T00:00:00Z --feature agent --feature updates --out license-customer-001.json
```

Copy only the public counterpart into `license-public-key.pem` for Stable
builds. The private signing key stays outside this repo and outside customer
packages.

Release integrity uses a different signing key from customer licensing. See
`docs/SECURITY_AND_COMMERCIALIZATION.md` for the threat model and release gates.

In the desktop app, a Stable license token is stored through Electron
`safeStorage`. Electron main decrypts it and sends it to the server only in
memory through the desktop-only bridge. A successful secure activation removes
the legacy plaintext `license.json` file. Browser Preview retains the legacy
file flow for development compatibility.

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
- Agent turn stream qua `/api/turns/:id/events`, có thể Cancel ngay trong UI,
  tự đánh dấu turn bị gián đoạn khi app restart, compact context cũ thành
  summary có giới hạn, và có policy theo từng turn: `read-only`, `workspace`, `full`.
- Electron desktop shell với `nodeIntegration=false`, `contextIsolation=true`,
  renderer sandbox, từ chối permission prompt và chỉ cho điều hướng local.
- Typed desktop IPC bridge cho action có quyền cao. Renderer chỉ được yêu cầu
  các action trong allowlist; Electron main process giữ local session token,
  tự gắn structured intent và từ chối renderer origin không tin cậy.
- Workspace profiles, Skills controls, dashboard metrics, approvals, file
  preview, Git diff, support bundle export và guarded customer update flow.
- Workspace Review modal có duyệt thư mục giới hạn, lọc path, preview file lớn,
  Git diff có màu và quyết định exact-action approval. Giới hạn tree/content
  giúp repo lớn không làm lag giao diện.
- Luồng Reviewed Patch có dry-run/validation chạy song song, ticket một lần gắn
  SHA-256, hết hạn sau mười phút, xác nhận apply riêng, backup batch tự động ở
  MCP và undo có bảo vệ cho patch batch gần nhất.
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
- Support bundle có redaction đệ quy, kèm preview giới hạn của thread gần đây,
  trạng thái turn và kết quả tool policy để hỗ trợ khách hàng. Event list tổng
  vẫn không xuất raw tool args/results.
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

Desktop app chạy v5 Studio server ngay trong Electron main process và mở local
UI bằng renderer đã sandbox. Khách dùng bản đóng gói không cần cài Node.js:
SQLite, HTTP runtime và maintenance script dùng Node runtime nhúng trong
Electron. Managed MCP process chạy bằng cùng executable đã ký với
`ELECTRON_RUN_AS_NODE=1`.

## Desktop Runtime Tự Chứa

File production được đóng vào Electron ASAR. Package khách hàng không chứa
development script, standalone CLI entry point hoặc thư mục Node runtime ngoài.
Kiểm tra cả runtime và đường dẫn archive bằng:

```powershell
npm run desktop:smoke
npm run desktop:pack
npm run desktop:smoke:packaged
```

Packaged smoke khởi động Studio API, mở SQLite, chạy managed MCP server bằng
runtime nhúng, kiểm tra `/healthz`, dừng process tree và xác nhận app chạy từ
`app.asar`.

Icon ứng dụng cross-platform nguyên bản và ghi chú provenance nằm trong
`build/`. Electron Builder tạo icon native Windows, macOS và Linux từ PNG
master này.

## Release Doctor

Chạy release doctor trước khi đưa build cho tester hoặc khách hàng:

```powershell
npm run release:doctor
```

Preview được phép pass kèm warning khi chưa có vật liệu ký production. Stable
sẽ fail closed cho tới khi release branch có `releaseStage: stable`, public key
xác minh, integrity manifest hợp lệ, artifact đã đóng gói và policy chữ ký
platform:

```powershell
npm run release:doctor -- --target stable --platform win32 --artifact "dist\\win-unpacked\\Local Agent Studio.exe" --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT
```

## Signed Release Updates

Preview có thể verify update manifest đã ký trước khi updater tải hoặc cài bản
mới. Verifier kiểm tra:

- Chữ ký Ed25519 từ `LCA_UPDATE_PUBLIC_KEY_PEM`, `update-public-key.pem`, hoặc
  fallback sang release public key.
- Product và channel phải khớp.
- Artifact URL phải dùng HTTPS.
- Artifact phải có SHA-256 hash.
- Policy publisher/chứng thư Authenticode trên Windows hoặc TeamIdentifier trên macOS.
- Build number không được cũ hơn app hiện tại hoặc build đã verify trước đó.
- Minimum app version phải tương thích.

Panel Updates có thể tải signed artifact vào private staging. Download được
stream theo chunk, giới hạn bằng signed size, hash trong lúc ghi, kiểm tra bằng
trình xác minh chữ ký native của hệ điều hành và bị xóa nếu bất kỳ check nào
fail. Manifest Stable cho Windows và macOS bắt buộc có policy chữ ký platform.
Artifact đã stage luôn có `installReady: false`; Preview không tự chạy installer.

Phải ký installer trước, kiểm tra chữ ký platform, rồi mới tạo update manifest.
Với Windows Authenticode:

```powershell
npm run signature:verify -- --artifact "dist\\Local Agent Studio.exe" --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT
```

Tạo signed update manifest ở bên ngoài app:

```powershell
$env:LCA_UPDATE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\update-private-key.pem"
npm run update:manifest -- --version v5.0.1 --build-number 500100 --platform win32 --arch x64 --artifact "dist\\Local Agent Studio.exe" --url https://example.com/LocalAgentStudio.exe --publisher "Local Coding Agent" --thumbprint CERTIFICATE_THUMBPRINT --out update-manifest.json
```

Với macOS, dùng `--team-id YOURTEAMID` trong cả hai lệnh. EXE Preview hiện tại
được báo rõ là chưa ký cho đến khi cấu hình chứng thư publisher thật; đây chưa
phải installer production.

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

## Luồng Reviewed Patch

Mở `Workspace Review`, chọn `Patch`, rồi dán standard unified diff. Workflow
được tách thành các bước tin cậy riêng:

1. `Preview` kiểm tra diff cục bộ, sau đó chạy song song `preview_patch` và
   `validate_patch` mà không ghi file.
2. Preview thành công tạo ticket trong RAM, gắn với chính xác nội dung diff bằng
   SHA-256. Ticket hết hạn sau mười phút và public API không trả lại raw diff.
3. `Apply` cần thêm một xác nhận high-risk và chỉ dùng ticket đúng một lần.
   Server chỉ apply private diff đã gắn với ticket; renderer không thể thay diff
   sau khi người dùng đã review.
4. MCP patch engine tạo backup batch theo workspace trước khi ghi. `Undo Last`
   cần xác nhận high-risk riêng và khôi phục batch gần nhất đó.

Route gọi tool thủ công chỉ cho read-only, không thể gọi `apply_patch` hoặc tool
thay đổi/không xác định. File vẫn có thể bị tiến trình ngoài Studio thay đổi giữa
lúc preview và apply; MCP patch engine sẽ match lại hunk context và fail closed
khi có conflict. Lớp review này chưa phải OS sandbox và không thay thế Git.

## Build Desktop Package

```powershell
npm run desktop:pack
```

Để tạo artifact release:

```powershell
npm run desktop:dist
```

Bản Stable vẫn cần chứng thư publisher thật và kiểm thử cài đặt trên từng hệ
điều hành trước khi phát hành cho khách hàng.

## License Preview

Khi `releaseStage` là `preview`, app chưa cần key thương mại.

Bản Stable chỉ chấp nhận license token do admin ký ở bên ngoài app. App chỉ chứa
public verification key. Admin private key tuyệt đối không được commit, bundle,
truyền qua command line, đặt trong CI log hoặc gửi cho khách hàng.

Tạo cặp key ký license trên máy admin:

```powershell
npm run license:keygen -- --out-dir "C:\\secure\\local-agent-studio-license"
```

Sau đó tạo token cho khách trên máy admin đó:

```powershell
$env:LCA_LICENSE_SIGNING_PRIVATE_KEY_FILE="C:\\secure\\local-agent-studio-license\\license-private-key.pem"
npm run license:issue -- --license-id lic_customer_001 --customer-id customer_001 --edition pro --expires-at 2027-01-01T00:00:00Z --feature agent --feature updates --out license-customer-001.json
```

Chỉ copy public key tương ứng vào `license-public-key.pem` cho bản Stable.
Private signing key phải nằm ngoài repo và ngoài package gửi khách.

Release integrity dùng khóa ký riêng với customer licensing. Xem
`docs/SECURITY_AND_COMMERCIALIZATION.md` để biết threat model và release gates.

Trong desktop app, Stable license token được lưu qua Electron `safeStorage`.
Electron main decrypt rồi chỉ gửi token vào RAM server qua desktop-only bridge.
Khi secure activation thành công, app dọn file plaintext `license.json` cũ.
Browser Preview vẫn giữ legacy file flow để tương thích phát triển.

## Tiêu Chí Lên Production

- Khách không chuyên có thể cài app, nhập model key, chọn workspace, yêu cầu
  agent inspect repo, approve hành động rủi ro và export support report khi lỗi.
- App chạy được workflow coding chính mà không phụ thuộc ChatGPT Web.
- Workflow connector ChatGPT Web cũ vẫn là tùy chọn cho người thích dùng.
- Bản thương mại fail closed nếu thiếu license, release integrity sai hoặc file
  runtime bị chỉnh sửa.
