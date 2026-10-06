# Lộ trình nâng cấp Local Coding Agent C#

Ngày lập: 06/10/2026. Đây là kế hoạch đề xuất, không phải danh sách tính năng
đã triển khai hoặc cam kết ngày hoàn thành.

## Mục tiêu

Làm một app Windows gọn, đẹp và đáng tin: người dùng chọn dự án, bấm kết nối,
thấy rõ agent đang làm gì và có thể dừng ngay. Giao diện dùng tiếng Việt tự
nhiên, ít thuật ngữ; các thiết lập kỹ thuật vẫn có nhưng không lấn át màn hình chính.

## Điểm xuất phát

App hiện dùng C#/.NET 10 và WinForms. Có bốn tab, quản lý quyền theo thư mục,
lưu khóa bằng DPAPI, khởi động server trước tunnel, kiểm tra kênh main, kết nối
lại và nhật ký. Bản C# 5.0.2 sửa lỗi YAML và hiển thị nguyên nhân tunnel thoát.

Chưa có bộ cài trọn gói, tự cập nhật có xác minh, trải nghiệm công việc tích
hợp, giao diện Fluent hoàn chỉnh, hay kiểm thử đầy đủ ở nhiều mức DPI. Electron
và Studio còn lỗi CI riêng; không coi chúng là nền tảng phát hành đã ổn định.

## Hướng kỹ thuật

Đề xuất tách lõi C# khỏi giao diện trước: cấu hình, kho khóa, vòng đời tiến
trình, health check, chẩn đoán và quản lý quyền trở thành các dịch vụ có kiểm thử.
Server MCP vẫn là Node.js; không viết lại server sang C# trong kế hoạch này.

Giao diện mới thử nghiệm bằng **WinUI 3 + XAML + MVVM**: dùng thành phần Fluent
và phân tách dữ liệu, xử lý, hiển thị. Microsoft có hướng dẫn WinUI, bố cục,
binding/MVVM và chuyển giao diện hiện có trong [tài liệu Windows chính thức](https://learn.microsoft.com/en-us/windows/apps/get-started/).
Đây là lựa chọn đề xuất cho prototype, chưa phải thay đổi framework đã thực hiện.

Giữ app WinForms hiện tại làm bản dùng ổn định. Chỉ chuyển giao diện chính khi
prototype qua được bài kiểm tra tray, đóng/mở lại, DPI, bàn phím, khả năng truy
cập và đóng gói trên máy sạch. Nếu chi phí hoặc độ ổn định chưa đạt, tiếp tục
cải tiến WinForms; không bỏ app đang dùng chỉ để đổi công nghệ.

## Các giai đoạn

| Giai đoạn | Việc cần làm | Điều kiện hoàn tất |
| --- | --- | --- |
| 1. Vận hành tin cậy | Tách lõi dịch vụ; một instance app; chỉ quản lý đúng PID/server/tunnel của cấu hình hiện tại; kiểm tra port; retry có hủy; chẩn đoán YAML/auth/mạng | Lặp start/stop/reconnect 20 lần không còn process hoặc port bị bỏ lại; không dừng tiến trình dự án khác; test lỗi giữ được nguyên nhân |
| 2. Cài đặt dễ dùng | Wizard chọn dự án → kiểm tra Node/server/client → nhập khóa → kiểm tra kết nối; sao lưu/migrate cấu hình; xuất báo cáo đã che bí mật | Máy Windows sạch theo wizard kết nối được; thiếu thành phần thì báo cách xử lý, không tự tải tunnel client; import không mang theo khóa DPAPI của máy khác |
| 3. Giao diện đẹp | Prototype WinUI; sidebar; chế độ sáng/tối/theo hệ thống; tiếng Việt/Anh; trạng thái từng bước; thông báo không chặn; icon nhất quán | Kiểm tra 100/125/150/200% DPI, bàn phím và screen reader; không cắt chữ; tray và đóng gói ổn định; chỉ sau đó thay UI chính |
| 4. Không gian làm việc | Danh sách dự án; quyền từng dự án; công việc và kết quả; diff file; duyệt hành động; tìm/lọc nhật ký | Không trộn dữ liệu giữa dự án; UI hiển thị đúng quyền đang áp dụng trên server; mở dashboard khi chưa có API native phù hợp, không giả lập tính năng |
| 5. Phân phối bền vững | Gói server/dependencies sạch; cân nhắc Node runtime có license; bộ cài; kiểm tra phiên bản; tải có xác minh; rollback; ký số khi có chứng thư | Máy sạch chạy được theo tài liệu; update thất bại vẫn chạy bản cũ; manifest có chữ ký tin cậy, không chỉ hash; config/khóa không nằm trong gói phát hành |

Số phiên bản tiếp theo sẽ được chốt theo phạm vi thực tế, không gán trước một
tính năng chưa làm cho bản 5.1 hoặc 6.0. Mỗi giai đoạn có bản thử riêng và bằng
chứng kiểm thử trước khi đưa vào bản ổn định.

## Bố cục đề xuất

Sidebar: Tổng quan · Dự án · Công việc · Quyền truy cập · Nhật ký · Cài đặt.

Màn hình Tổng quan gồm dự án đang dùng, trạng thái Server/Tunnel/ChatGPT,
một nút chính “Kết nối”, nút “Dừng”, và việc gần nhất. Không gọi kết nối ChatGPT
là thành công chỉ vì process tunnel đang chạy: cần kiểm tra transport và lời gọi
MCP thực tế, nếu thiếu bằng chứng thì hiển thị “Chưa xác minh”.

Quyền nâng cao nằm ở một màn hình riêng. Luôn nhìn thấy quyền đang chạy, không
chỉ giá trị vừa lưu. Đổi quyền khi đang kết nối phải nói rõ cần khởi động lại hay
đã áp dụng trực tiếp. “Toàn bộ máy” có cảnh báo, xác nhận gõ tay, nút thu hồi;
không tự kích hoạt sau nâng cấp và không gọi nó là quyền root/Administrator.

## Ranh giới dữ liệu và bảo mật

- Cấu hình, khóa DPAPI và nhật ký vận hành giữ trên máy. Nội dung từ tool MCP
  có thể được gửi cho ChatGPT để xử lý; app không được quảng cáo là hoàn toàn offline.
- Mặc định chỉ một dự án, `safe` + `balanced`; quyền tối đa và shutdown là
  lựa chọn riêng, có xác nhận và khả năng thu hồi rõ ràng.
- Trước xuất báo cáo, che khóa, token, ID và thông tin nhạy cảm; người dùng
  xem trước và tự quyết định chia sẻ. Không bật telemetry mặc định.
- Nội dung file/web/log là dữ liệu không tin cậy, không được tự nâng quyền
  hay đổi cấu hình vì trong đó có câu lệnh.
- Nâng quyền Windows qua UAC, nếu sau này cần, phải là thao tác riêng do người
  dùng đồng ý. Không dùng để bỏ qua chính sách công cụ hoặc cơ chế bảo vệ hệ thống.

## Việc nên triển khai đầu tiên

Ưu tiên giai đoạn 1 và wizard cơ bản của giai đoạn 2. Đây là phần giảm lỗi
thực tế nhiều nhất trước khi thay UI. Sau đó làm prototype giao diện với dữ
liệu giả được ghi nhãn, rồi nối từng dịch vụ thật. Không triển khai toàn bộ
roadmap trong một đợt và không phát hành mockup như app đã chạy.

Trước mỗi release: test lõi, test tool MCP trên thư mục thử riêng, kiểm tra
live kết nối, kiểm tra UI thực tế, rà gói không có bí mật và công bố đúng phần
còn hạn chế. Lỗi audit Electron/Studio được theo dõi riêng và phải xử lý trước
khi phát hành lại các sản phẩm đó.
