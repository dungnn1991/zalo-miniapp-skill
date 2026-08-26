# Quyền trong Zalo Mini App — nhóm, danh sách, quy trình xin

Reference khi app tích hợp API cần quyền hoặc user hỏi "app cần xin quyền gì/ở đâu". Phân biệt
ngay từ đầu **hai tầng khác nhau**:

1. **Xin quyền cho Mini App** — một lần, trên hệ thống **Mini App Center** — để Mini App ID
   được phép DÙNG nhóm API đó. Thiếu tầng này: chỉ user thường bị lỗi, Developer/Admin không
   bao giờ bị (`operations.md` §5 — bẫy "test bằng account dev thấy chạy ngon").
2. **Xin consent người dùng** — runtime, từng user — `getSetting` → `authorize` → gọi API
   (Recipe 1, `feature-recipes.md`); user từ chối là `-201`, một trạng thái hợp lệ.

> **Attribution:** chưng cất từ Portal official
> [`intro/request-permission.md`](https://docs.zaloplatforms.com/docs/MA/intro/request-permission.md)
> (fetch **2026-08-26**). Enforcement theo môi trường (bản dev/testing không hiện form quyền,
> chỉ bản LIVE áp cho mọi user) đã làm rõ ở `operations.md` §5.

## 1. Bốn nhóm quyền

| Nhóm | Là gì | Ví dụ |
|---|---|---|
| User Device Permission | quyền liên quan thiết bị của user | location, camera, native storage, rung, giữ màn hình bật |
| User Information Permission | thông tin cá nhân của user | số điện thoại |
| Zalo Permission | tính năng của Zalo | scan QR, hiện QR OA, follow OA, mở cửa sổ chat |
| Mini App Permission | tính năng trên chính Mini App | đổi màu/title navigation bar, mở/đóng Mini App |

Riêng **User Information Permission**: quyền chỉ có hiệu lực trong **một khoảng thời gian** rồi
bị thu hồi; platform cung cấp tính năng để user "ghi nhớ lựa chọn".

## 2. Ai phải cho phép — bảng official rút gọn

Cột "Cần sự cho phép từ" của bảng official gom về 3 mức:

- **Mặc định** (không cần đăng ký): mở màn hình cuộc gọi/tin nhắn native, hiển thị toast, ẩn
  bàn phím, chia sẻ lên nhật ký/với bạn bè Zalo, hiện QR OA, **yêu cầu theo dõi/bỏ theo dõi
  OA**, chọn bạn bè, mở profile User/OA, mở cửa sổ chat, đổi màu/title navigation bar,
  mở/đóng Mini App.
- **Zalo duyệt** (đăng ký ở Mini App Center trước): Shortcut, lấy thông tin network device,
  giữ màn hình luôn bật, **Native Storage**, lưu ảnh vào điện thoại, rung, **Camera**,
  **mở Scan QR Code trên Zalo**.
- **Zalo duyệt + user consent runtime**: **Vị trí** (`getLocation`), **Số điện thoại**
  (`getPhoneNumber`).

Bảng đầy đủ từng quyền kèm mô tả: trang official ở phần Attribution.

## 3. Quy trình xin quyền từ Zalo (trên Mini App Center)

1. Vào hệ thống quản lý **Mini App Center** → mục **Quyền Mini App**.
2. Chọn quyền muốn yêu cầu xét duyệt.
3. Mô tả **lý do + hình ảnh** sử dụng quyền (tip official: mô tả rõ → xét duyệt nhanh hơn).
4. (Tuỳ chọn) nhập nội dung mô tả quyền sẽ hiển thị cho người dùng.
5. Gửi xét duyệt — bộ phận kiểm duyệt xét cùng lúc xét duyệt phiên bản mới.
6. Kết quả thông báo qua **OA & Mini App Center**.

Cách khác: xin ngay ở **Bước 1 khi gửi xét duyệt phiên bản** (`operations.md` §5).

## 4. Xin consent từ người dùng (runtime UX)

- Xin **đúng ngữ cảnh** sử dụng; khi mới vào app chỉ xin quyền thật sự cần cho tính năng lõi —
  đừng dồn hết lúc mở app.
- Flow code chuẩn + xử lý từ chối `-201`: Recipe 1 trong `feature-recipes.md`. Số điện thoại
  có 2 case UX hợp lệ (chỉ xin khi dùng tính năng / onboarding giải thích lý do) — official
  `best-practices/authen-user.md`; token → số thật phải decode server-side:
  `phone-number-backend.md`.
- Ranh giới môi trường: form quyền thật chỉ có khi app **LIVE**; muốn thử UX quyền trước đó
  dùng **simulator** (`simulator-workflow.md`).
