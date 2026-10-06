# Local Coding Agent C# v5.0.2

Ngày phát hành: 06/10/2026. Nhãn GitHub: `csharp-v5.0.2`.

Đây là bản cập nhật app C# cho Windows x64. Server MCP vẫn ở phiên bản 5.0.1;
Electron, macOS, Chrome Companion và Studio không có gói mới trong đợt này.

## Có gì mới?

- Giao diện chia thành Tổng quan (Overview), Cài đặt (Setup), Nâng cao (Advanced)
  và Hoạt động (Activity); cửa sổ co giãn, trạng thái luôn hiển thị ở đầu.
- Các nút khởi động, dừng, kết nối lại tunnel và mở dashboard được gom rõ ràng.
- Có nút bật quyền tối đa bằng xác nhận gõ tay `ENABLE FULL ACCESS`, cùng nút
  khôi phục thiết lập an toàn. Đây không phải quyền Administrator của Windows.
- Sửa lỗi `line 7: cannot unmarshal !!seq into map[string]string`: app ghi
  `extra_headers` đúng dạng bảng khóa–giá trị, tương thích tunnel-client v0.0.14.
- Khi tunnel thoát, app báo mã thoát và lỗi gốc ngay; khóa và ID được che trong
  phần nhật ký tunnel thu thập bởi app.
- Nhận diện SDK .NET 10 cài theo tài khoản người dùng khi build.

## Tải và sử dụng

- `LocalCodingAgentTrayClassic-5.0.2-win-x64.exe`: app C#, đã kèm .NET runtime.
- `build-manifest.json`: tên file, phiên bản, thời điểm build và SHA-256.
- Source code ZIP/TAR do GitHub tạo: mã nguồn tương ứng với nhãn phát hành.

**Nếu đã sử dụng app:** giữ nguyên bản cũ, đóng app bằng Tray → Exit, rồi mở
EXE mới. Không xóa `%APPDATA%\LocalCodingAgent`; thư mục này giữ thiết lập và
khóa được mã hóa bằng DPAPI cho cùng tài khoản Windows. Không gửi thư mục đó
lên GitHub hoặc cho người khác.

**Nếu cài mới:** tải mã nguồn hoặc clone repository, cài Node.js ≥ 18, chạy
`install.ps1` trong thư mục mã nguồn, rồi mở EXE. Chọn đúng `server/`, thư mục
làm việc, file tunnel client, Tunnel ID và khóa runtime. Tunnel client không
được phân phối kèm; EXE này không thay thế Node.js hay server.

Chỉ nên chọn `safe` + `balanced` và một thư mục tin cậy. Quyền tối đa cho phép
đọc/ghi trên các ổ đĩa đã chọn và chạy lệnh nguy hiểm theo quyền tài khoản hiện
tại; app không tạo vùng cách ly. Không mở server qua tunnel công khai nếu chưa
đặt `MCP_AUTH_TOKEN`.

Sau khi khởi động, cần thấy Server ONLINE và Tunnel CONNECTED. Trong ChatGPT,
gọi `workspace_info` để đối chiếu thư mục và chế độ thực tế. Kiểm tra cục bộ
không thay thế kiểm tra đầu-cuối này trên tài khoản của bạn.

## Kiểm thử và giới hạn

Pipeline phát hành riêng kiểm tra ranh giới file công khai, kiểm thử chẩn đoán
Node.js, bốn bộ smoke test C# (quyền, trạng thái, bố cục, cấu hình tunnel), rồi
build EXE self-contained. Gói chỉ được công bố sau khi các bước đó thành công.
Smoke test bố cục không có nghĩa mọi mức DPI hoặc mọi màn hình đã được kiểm tra.

Các lỗi audit thư viện Electron/Studio và kiểm thử Studio Windows ở CI trước
vẫn còn, không được tuyên bố đã sửa trong bản này. Bản EXE chưa ký số;
SmartScreen có thể cảnh báo. SHA-256 giúp đối chiếu file, không thay thế chữ ký
số của nhà phát hành. Tự cập nhật và bộ cài trọn gói chưa được triển khai.

## Hướng phát triển tiếp

Xem [lộ trình nâng cấp app C#](CSHARP_APP_ROADMAP.md): ưu tiên vận hành ổn định,
trình hướng dẫn cài đặt, giao diện Fluent, màn hình công việc và cập nhật an toàn.

---

English: Windows C# maintenance release with a modern WinForms layout,
typed maximum-access opt-in, corrected tunnel header YAML, redacted actionable
startup errors, and a versioned self-contained .NET executable. Requires Node,
repository server/dependencies, and the user's own tunnel client. No new
Electron/macOS/Studio packages or blanket full-CI/security-clearance claim.
