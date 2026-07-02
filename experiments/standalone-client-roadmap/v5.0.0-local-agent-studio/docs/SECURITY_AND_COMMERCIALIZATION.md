# Studio v5 Security and Commercialization

## English

### Security Boundaries

Local Agent Studio is a privileged coding agent. Treat model output, workspace
content, MCP tool descriptions, downloaded dependencies, remote endpoints, and
runtime files as untrusted input until verified.

The Preview implements these baseline controls:

1. The local HTTP server only accepts loopback peers and loopback Host headers.
2. Every private API call requires a random per-process capability token.
3. Browser requests with a foreign Origin are rejected.
4. State-changing requests require `application/json`, which blocks simple
   cross-origin form or `text/plain` attacks.
5. CSP, anti-framing, no-sniff, no-referrer, and restrictive permissions
   headers are applied.
6. Remote MCP endpoints are disabled unless the operator explicitly opts in.
7. Privileged API routes require structured intent confirmation through the
   server-side permission broker. Audit entries record metadata only, not raw
   request payloads.
8. The Electron renderer runs with `nodeIntegration=false`,
   `contextIsolation=true`, sandboxing enabled, denied permission prompts, and
   local-only navigation.
9. Desktop privileged actions go through a typed IPC bridge. The Electron main
   process owns the Studio token, maps actions through an allowlist, injects
   structured intent, and validates the renderer origin before proxying.
10. Desktop provider keys use Electron `safeStorage`, remain encrypted at rest,
    and are synchronized to the server only in memory through a separate
    per-process desktop bridge token. Linux `basic_text` fallback is rejected.
    Browser Preview retains the AES-256-GCM vault; APIs return only metadata.
    `npm run credential:smoke` verifies the actual backend and encryption
    round-trip on the current machine.
11. Admin-issued Stable license tokens use the same OS-backed store. The server
    verifies them in memory through the desktop-only bridge and removes legacy
    plaintext `license.json` after secure activation.
12. Support bundles recursively redact credentials and omit raw tool arguments
    and results from the event list.
13. SQLite persists threads without putting API credentials in the database.
14. The desktop launcher resolves Node.js from `LCA_NODE_PATH`, packaged
    runtimes, source-tree runtimes, then system Node. Release CI can require a
    bundled runtime with `npm run runtime:verify -- --require-bundled`.
15. Signed update artifacts can be streamed into private staging only after
    signature verification. HTTPS, exact size, SHA-256, OS/arch, rollback, and
    minimum-app-version checks are enforced. Preview never executes a staged
    installer automatically.

This is defense in depth, not an operating-system sandbox. Before customer
release, the Stable desktop app still needs typed IPC coverage for every
privileged workflow, OS-enforced workspace boundaries, network allowlists,
signed installers, signed update manifests, bundled runtime artifacts for every
supported OS/arch, and platform code signing.

### Commercial License Design

The admin does not give customers a shared secret. The admin license service
signs a customer-specific token with an Ed25519 private key. The app contains
only the matching public key and can verify the token offline.

Required claims:

- `product`: `local-agent-studio`
- `licenseId`
- `customerId`
- `edition`
- optional `issuedAt`, `notBefore`, `expiresAt`, and `features`

Preview builds are intentionally allowed without a license. Stable builds are
fail-closed: a missing verification key, missing token, invalid signature, wrong
product, incomplete claims, future activation date, or expiration denies model
execution.

The private license key belongs in an offline signing environment or a managed
KMS/HSM. Never put it in source code, environment defaults, CI logs, release
archives, customer machines, or command-line arguments.

### Release Integrity and Anti-Backdoor Controls

License signing and release signing use separate Ed25519 keys. Compromise of a
license issuer must not authorize software updates.

The release pipeline must:

1. Install dependencies from the lockfile with `npm ci`.
2. Reject install/prepare lifecycle scripts unless explicitly reviewed.
3. Place verified Node runtime artifacts in `runtimes/node/<platform>-<arch>/`.
4. Run `npm run runtime:verify -- --require-bundled` for each release target.
5. Run syntax checks, unit tests, HTTP security tests, dependency audit, and
   `security:audit` on Windows, macOS, and Linux.
6. Generate a SHA-256 integrity manifest for production runtime files.
7. Sign the integrity manifest outside the repository.
8. Build in an isolated CI runner from a reviewed commit.
9. Generate an SBOM and provenance attestation.
10. Sign Windows, macOS, and Linux release artifacts with platform-appropriate
    signing identities.
11. Publish checksums and verify them before installation/update.
12. Require a separately signed update manifest and support rollback.

Pattern scanning cannot prove that software has no backdoor. Review, least
privilege, reproducible inputs, signed provenance, platform code signing,
runtime isolation, and transparent release evidence are all required.

### Planned Stable Controls

- Expand typed, allowlisted IPC to every privileged desktop workflow and reduce
  direct renderer access to localhost APIs.
- One-time approvals backed by the permission broker for all destructive,
  network, install, and out-of-root actions.
- Complete installation testing for OS-backed provider/license storage on
  Windows DPAPI, macOS Keychain, and Linux secret-service backends.
- OS-enforced workspace write boundaries.
- Network disabled by default for model-generated commands.
- Device activation, revocation, offline grace periods, and privacy-preserving
  license refresh.
- Signed auto-update with staged rollout and automatic rollback.
- External security review and release penetration test.

---

## Tiếng Việt

### Ranh Giới Bảo Mật

Local Agent Studio là coding agent có quyền cao. Phải xem model output, nội dung
workspace, mô tả MCP tool, dependency tải về, remote endpoint và runtime file là
dữ liệu chưa đáng tin cho tới khi được kiểm tra.

Preview hiện có các lớp bảo vệ cơ bản:

1. HTTP server local chỉ chấp nhận loopback peer và loopback Host header.
2. Mọi private API yêu cầu capability token ngẫu nhiên theo từng tiến trình.
3. Request trình duyệt có Origin lạ bị từ chối.
4. Thao tác thay đổi chỉ nhận `application/json`, giúp chặn form hoặc request
   `text/plain` cross-origin đơn giản.
5. App gửi CSP, anti-framing, no-sniff, no-referrer và permissions policy chặt.
6. Remote MCP bị tắt trừ khi operator chủ động bật.
7. API route có quyền cao phải có structured intent confirmation qua permission
   broker ở server. Audit chỉ ghi metadata, không ghi raw request payload.
8. Electron renderer chạy với `nodeIntegration=false`, `contextIsolation=true`,
   sandbox bật, permission prompt bị từ chối và chỉ cho điều hướng local.
9. Desktop privileged action đi qua typed IPC bridge. Electron main process giữ
   Studio token, map action qua allowlist, tự gắn structured intent và kiểm tra
   renderer origin trước khi proxy.
10. Desktop provider key dùng Electron `safeStorage`, được mã hóa khi lưu và chỉ
    sync vào RAM server qua desktop bridge token riêng theo từng tiến trình.
    Linux `basic_text` fallback bị từ chối. Browser Preview vẫn dùng AES vault;
    API chỉ trả metadata.
    `npm run credential:smoke` kiểm tra backend thật và encrypt/decrypt round-trip
    trên máy hiện tại.
11. Stable license token do admin cấp dùng cùng OS-backed store. Server verify
    token trong RAM qua desktop-only bridge và dọn plaintext `license.json` cũ
    sau khi secure activation thành công.
12. Support Bundle redaction đệ quy và bỏ raw tool args/results khỏi event list.
13. SQLite lưu thread nhưng không lưu API credential.
14. Desktop launcher resolve Node.js từ `LCA_NODE_PATH`, packaged runtime,
    source-tree runtime rồi mới tới system Node. Release CI có thể bắt buộc
    bundled runtime bằng `npm run runtime:verify -- --require-bundled`.
15. Signed update artifact chỉ được stream vào private staging sau khi verify
    chữ ký. App kiểm tra HTTPS, exact size, SHA-256, OS/arch, rollback và minimum
    app version. Preview không tự execute installer đã stage.

Đây là defense in depth, chưa phải sandbox cấp hệ điều hành. Trước khi phát hành
Stable cho khách, desktop app vẫn cần typed IPC cho toàn bộ workflow có quyền
cao, workspace boundary do hệ điều hành cưỡng chế, network allowlist, signed
installer, signed update manifest, runtime bundle cho mọi OS/arch được hỗ trợ và
platform code signing.

### Thiết Kế License Thương Mại

Admin không đưa cho khách một shared secret. License service của admin ký token
riêng cho từng khách bằng Ed25519 private key. App chỉ chứa public key tương ứng
để xác minh offline.

Claims bắt buộc:

- `product`: `local-agent-studio`
- `licenseId`
- `customerId`
- `edition`
- có thể thêm `issuedAt`, `notBefore`, `expiresAt` và `features`

Preview được phép chạy không cần license. Stable fail-closed: thiếu verification
key, thiếu token, chữ ký sai, sai product, claims thiếu, chưa đến ngày kích hoạt
hoặc đã hết hạn đều không được chạy model.

Private license key phải nằm trong môi trường ký offline hoặc KMS/HSM. Tuyệt đối
không đặt trong source, env mặc định, CI log, release archive, máy khách hoặc
command-line argument.

### Release Integrity Và Chống Backdoor

Khóa ký license và khóa ký release phải là hai cặp khóa khác nhau. Mất khóa cấp
license không được phép biến thành quyền phát hành bản update.

Release pipeline phải:

1. Cài dependency từ lockfile bằng `npm ci`.
2. Từ chối install/prepare lifecycle script nếu chưa review rõ ràng.
3. Đặt Node runtime đã verify vào `runtimes/node/<platform>-<arch>/`.
4. Chạy `npm run runtime:verify -- --require-bundled` cho từng release target.
5. Chạy syntax check, unit test, HTTP security test, dependency audit và
   `security:audit` trên Windows, macOS và Linux.
6. Tạo SHA-256 integrity manifest cho các file runtime production.
7. Ký integrity manifest ở bên ngoài repository.
8. Build trong CI runner cô lập từ commit đã review.
9. Tạo SBOM và provenance attestation.
10. Ký artifact Windows, macOS và Linux bằng signing identity phù hợp từng nền tảng.
11. Công bố checksum và verify trước khi install/update.
12. Yêu cầu update manifest được ký riêng và hỗ trợ rollback.

Pattern scanner không thể tự chứng minh app không có backdoor. Cần kết hợp code
review, least privilege, input build có thể truy vết, signed provenance,
platform code signing, runtime isolation và bằng chứng release minh bạch.

### Stable Còn Cần Gì

- Mở rộng typed IPC có allowlist cho toàn bộ privileged desktop workflow và giảm
  quyền renderer gọi trực tiếp localhost APIs.
- One-time approval dựa trên permission broker cho destructive, network,
  install và out-of-root actions.
- Hoàn tất kiểm thử cài đặt OS-backed provider/license storage với Windows
  DPAPI, macOS Keychain và Linux secret-service.
- Workspace write boundary do hệ điều hành cưỡng chế.
- Tắt network mặc định cho command do model sinh ra.
- Device activation, revocation, offline grace period và license refresh bảo vệ
  quyền riêng tư.
- Signed auto-update có staged rollout và automatic rollback.
- Security review bên ngoài và penetration test trước release.
