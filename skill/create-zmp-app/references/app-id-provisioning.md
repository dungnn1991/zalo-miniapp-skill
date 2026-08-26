# Lấy Mini App ID — hướng dẫn cho user chưa có ID

Dùng khi bootstrap dừng `needs_input` với `reason: app_id_missing`, hoặc khi user hỏi "lấy
App ID ở đâu" giữa flow. Agent trình bày các bước dưới đây cho user rồi **chờ ID**. Guardrail
giữ nguyên (SKILL.md): skill **không** tự tạo Zalo App/Mini App, không login hộ, không lấy ID
từ account, không đoán — user tự thao tác trên hai hệ thống web của Zalo bằng tài khoản của họ.

> **Attribution:** chưng cất từ Portal docs chính thức (fetch **2026-08-26**):
> [`intro/getting-started.md`](https://docs.zaloplatforms.com/docs/MA/intro/getting-started.md)
> §1.1–1.2 và
> [`intro/intro/mini-app-account.md`](https://docs.zaloplatforms.com/docs/MA/intro/intro/mini-app-account.md).

## 1. Mô hình 2 tầng — vì sao có 2 hệ thống

- **Zalo App** — tạo trên **Zalo For Developers** (https://developers.zalo.me): ứng dụng "cha"
  trên Zalo Platform. Một Zalo App chứa được **nhiều** Mini App; Open API/OAuth đi qua tầng này.
- **Mini App** — tạo trong **Mini App Center** (Trang Quản Lý Zalo Mini App,
  https://mini.zalo.me/developers): app con nằm trong một Zalo App. **Mini App ID sinh ra ở
  bước này** — đây là giá trị skill cần.
- ID người dùng được mã hoá theo Zalo App cha: các Mini App chung một Zalo App thấy cùng một
  user id.

## 2. Bước 1 — Zalo For Developers (bỏ qua nếu đã có Zalo App)

1. Vào https://developers.zalo.me, đăng nhập bằng tài khoản Zalo.
2. Tạo ứng dụng mới trên Zalo Platform (hoặc dùng ứng dụng có sẵn).
3. Vào **Cài đặt → Kích hoạt ứng dụng** — bước hay quên; không kích hoạt thì người dùng ngoài
   không sử dụng được ứng dụng.

## 3. Bước 2 — Mini App Center (nơi nhận Mini App ID)

1. Vào https://mini.zalo.me/developers.
2. Chọn Zalo App sẽ chứa Mini App.
3. Bấm **"Tạo Mini App"**, điền thông tin (tên, logo…). Lưu ý từ Portal: muốn **đổi thông tin
   sau khi tạo** phải mở ticket hỗ trợ và chờ kiểm duyệt xác nhận — kiểm tra kỹ trước khi bấm.
4. Bấm **"Tạo mới"** → hệ thống trả về **Mini App ID**. Copy nguyên văn chuỗi này.

Sau khi tạo, Portal yêu cầu **xác thực Mini App** (qua OA hoặc giấy tờ) trước khi xây dựng —
xem `docs/MA/single-pages/thong-bao-huong-dan-xac-thuc-mini-app` (link trong
`getting-started.md` §2); việc này không chặn bước bind ID của skill.

## 4. Bước 3 — đưa ID cho skill

- Chạy lại đúng lệnh trước đó, thêm `--app-id "<id>"` (hoặc brief chứa `appId=<id>`).
- ID là **chuỗi exact-preserve**: giữ nguyên số 0 ở đầu, không strip/không format lại
  (SKILL.md "App ID resolution").

## 5. Phân biệt hay nhầm

- **`MINI_APP_ID` ≠ `ZALO_APP_ID`** — hai ID khác nhau dù liên hệ trực tiếp; nhầm chỗ này là
  nguồn lỗi CI/CD "Permission denied" (xem `troubleshooting.md` §5).
- Bản Development/Testing chỉ mở được bằng tài khoản **Developer/Admin** của app; tài khoản
  thường gặp "Trang này không tìm thấy hoặc không hợp lệ" (`operations.md` §7).
