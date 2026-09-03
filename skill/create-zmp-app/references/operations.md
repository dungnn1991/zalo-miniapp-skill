# Operations — vận hành, debug bản Live, chính sách xét duyệt

> **Attribution:** Chưng cất từ chuyên mục FAQ công khai của **Hồng Phát (Supporter)** —
> https://miniapp.zaloplatforms.com/community (crawl **2026-08-21**; bản lưu:
> `DX/community-faq-best-practice/` — DX workspace, không ship cùng skill), cộng fact đã pin
> của lab (`config.json` `zmpCli`).
> Đối chiếu official: [Các lỗi kỹ thuật thường gặp](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/frequently-solved-issues.md)
> (fetch **2026-08-26**) — ký hiệu **FSI #N** trỏ mục N của trang đó.
> Lỗi build/deploy cụ thể: xem `troubleshooting.md` + `error-signatures.json`.

## 1. Debug bản Live: `zDebug=true`

Lỗi chỉ xuất hiện trên bản Live → hai cách xem chi tiết:

1. Thêm param **`zDebug=true`** vào deeplink của app, ví dụ
   `https://zalo.me/s/194839900003483517/?zDebug=true` — icon Debug hiện kể cả trên Live:
   xem Console logs, Network requests, Element inspector...
2. **Remote debug qua Chrome**: nối thiết bị Android qua cáp USB, dùng Chrome DevTools
   remote debugging — xem được mã lỗi triệt để hơn, thêm Profiling/Breakpoints.

Nguồn: [Lỗi trên bản Live](https://miniapp.zaloplatforms.com/community/8674910277312018127/loi-tren-ban-live-nhung-khong-biet-do-dau) — Hồng Phát, crawl 2026-08-21 · Official: FSI #6.

## 2. Device Mode: adb + TailwindCSS

- **`command not found: adb`** khi bật "Kết nối trực tiếp" với Device Mode: máy chưa cài
  [Android Debug Bridge](https://developer.android.com/tools/adb) hoặc cài rồi nhưng chưa set
  biến môi trường PATH — đảm bảo gõ `adb` trong terminal chạy được.
  Nguồn: [adb not found](https://miniapp.zaloplatforms.com/community/7954323342185554127/command-not-found-adb-khi-su-dung-ket-noi-truc-tiep-voi-device-mode) · Official: FSI #20.
- **TailwindCSS không apply style mới** ở Device Mode (không bật Kết nối trực tiếp) với dự án
  Vite 2.6.x: nâng Vite (`npm i vite@^2.9`); dùng Extension thì chạy `Developer: Reload
  Window` để có hiệu lực.
  Nguồn: [Tailwind Device Mode](https://miniapp.zaloplatforms.com/community/7882264648585667535/tailwindcss-khong-apply-style-moi-khi-su-dung-che-do-device) · Official: FSI #19.

## 3. Không tìm thấy Mini App trên Store/thanh tìm kiếm Zalo

App đã duyệt + bật hiển thị công khai mà vẫn không tìm thấy = **phía vận hành chủ động tắt tìm
kiếm**. Nguyên nhân điển hình: app dùng form đăng nhập truyền thống username/password (chính
sách 6.4: flow này chỉ dành cho app nội bộ, truy cập qua Deeplink/QR/Shortcut), hoặc app có
vấn đề tại thời điểm xét duyệt và được thoả thuận lên bản nhưng không mở tìm kiếm. Muốn mở
lại: đổi flow đăng nhập/khắc phục vấn đề, submit phiên bản mới và **ghi rõ trong mô tả xét
duyệt là xin mở lại tìm kiếm + hiển thị công khai**.
Nguồn: [Không tìm thấy trên Store](https://miniapp.zaloplatforms.com/community/568306155564108111/khong-tim-thay-mini-app-tren-zalo-mini-app-store-hoac-thanh-tim-kiem-cua-zalo) — Hồng Phát, crawl 2026-08-21 · Official: FSI #10.

## 4. Chính sách Checkout SDK (từ tháng 3/2024)

| Tình huống | Cần Checkout SDK? |
|---|---|
| Hiển thị sản phẩm kèm **giá tiền** | **Cần** |
| Có **giỏ hàng** hoặc **đặt hàng** (kể cả COD) | **Cần** |
| Không hiển thị giá tiền | Không cần |
| Có giá tiền nhưng không giỏ hàng/đặt hàng, chỉ nút "Tư vấn" mở chat OA | Không cần |

> **Ghi chú cho lab:** template lab hiện hiển thị **giá + giỏ hàng** → thuộc diện **cần tích
> hợp Checkout SDK khi đưa lên Live/xét duyệt**. Development/Testing nội bộ không bị chặn,
> nhưng đây là lý do từ chối xét duyệt có thật — gate `checkout_sdk_policy_hint` của verify
> nhắc đúng case này.

Nguồn: [Bị từ chối vì Checkout SDK](https://miniapp.zaloplatforms.com/community/3342285481094226382/mini-app-cua-toi-bi-tu-choi-vi-khong-tich-hop-checkout-sdk-mac-du-khong-co-chuc-nang-thanh-toan) — Hồng Phát, crawl 2026-08-21.

## 5. Quyền phải xin ở "Quản lý quyền" — lỗi chỉ user thường gặp

App dùng các API sau thì **phải xin cấp quyền** cho Mini App ID (Bước 1 khi gửi xét duyệt,
hoặc *Quản lý > Quản lý quyền*):

`getPhoneNumber` · `getLocation` · `openMediaPicker` · `requestCameraPermission` ·
`keepScreen` · nhóm API **Native Storage**

**Điểm nguy hiểm:** Developer/Admin của app dùng các API này **không bao giờ bị lỗi** (để phục
vụ tích hợp) — chỉ **người dùng thường** bị. Tức là test bằng account dev thấy "chạy ngon"
không chứng minh được gì; phải xin quyền trước khi release. Gate `permission_registry_hint`
của verify nhắc khi detect các API này trong code.
Nguồn: [Lỗi chỉ user thường bị](https://miniapp.zaloplatforms.com/community/8746968970844796879/loi-chi-xay-ra-voi-nguoi-dung-binh-thuong-con-developer-admin-thi-khong-bi) — Hồng Phát, crawl 2026-08-21 · Official: FSI #7.
Nhóm quyền, bảng ai-phải-cho-phép và quy trình 6 bước xin quyền trên Mini App Center:
`permissions.md`.

> **Làm rõ cơ chế (platform team, 2026-08-21):** enforcement là theo **môi trường**, không
> theo role: các flow xin quyền KHÔNG chạy trên bản Development/Testing — chỉ khi app **GO
> LIVE** (qua kiểm duyệt) thì permission flows mới áp dụng, và áp cho **toàn bộ user** không
> phân biệt. App live có URL dạng `https://zalo.me/s/<appId>` (không kèm `env`). Hệ quả:
> test bản dev/testing (kể cả trên Zalo thật) không thấy bottomsheet xin quyền — muốn thử
> permission UX trước khi live, dùng **simulator** của skill này; muốn verify flow thật, phải
> test trên app live.

## 6. API chỉ được gọi Server-to-Server

Các API sau được thiết kế gọi **từ server của bạn sang server Zalo** (cần private key /
app secret):

- Decode token ra số điện thoại/vị trí
- Gửi thông báo đến người dùng
- **Toàn bộ nhóm OpenAPI**
- Một số API Checkout SDK: `getOrderStatus`, `updateOrderStatus`

Gọi các API này **từ client Mini App là lỗ hổng bảo mật** (lộ secret), và cũng không hoạt động
ổn do CORS/chặn IP. **Cách fix duy nhất: đưa logic này về server của bạn.** Preflight gate
`server_side_api_scan` của build là blocking đúng vì lý do này.
Nguồn: [API Server-Server](https://miniapp.zaloplatforms.com/community/9107262438710014159/loi-khi-goi-cac-api-server-server-tu-mini-app) — Hồng Phát, crawl 2026-08-21 · Official: FSI #4.

## 7. Vai trò Development / Testing / Live + version semantics

- **Development**: chỉ **một slot** — deploy sau đè bản trước; URL dev (kể cả kèm `zdev-*`)
  luôn trỏ bản mới nhất, **không** phải tham chiếu ổn định. Quota **300 lần / cửa sổ trượt 30 ngày**.
- **Testing**: mỗi lần deploy lưu build lên CDN gắn **version bền** (tham chiếu được — dùng
  cho UAT/regression). Quota **60 lần / cửa sổ trượt 30 ngày**. (Fact pin: quota tại `config.json`
  `zmpCli.deployQuota`; version semantics tại `zmpCli.deploy.versionSemantics`.)
- **Live**: bản cho user thường, qua xét duyệt.
- Ai mở được bản nào: Development/Testing chỉ mở được bằng account **Developer/Admin** — account
  thường gặp *"Trang này không tìm thấy hoặc không hợp lệ"*; mở bản Live khi app **chưa có bản
  Live** gặp *"Ứng dụng đang trong giai đoạn phát triển, vui lòng thử lại sau!"*.

Nguồn: [Quota 30 ngày](https://miniapp.zaloplatforms.com/community/8602851583980566991/you-have-reached-your-30-day-deployment-limit-please-try-again-later) ·
[Đang trong giai đoạn phát triển](https://miniapp.zaloplatforms.com/community/8891086357977462223/ung-dung-dang-trong-giai-doan-phat-trien-vui-long-thu-lai-sau) ·
[Trang không tìm thấy](https://miniapp.zaloplatforms.com/community/8819027664444683471/trang-nay-khong-tim-thay-hoac-khong-hop-le-xin-loi-vi-su-bat-tien-nay) — Hồng Phát, crawl 2026-08-21 · Official: FSI #8, #9, #13.

## 8. FAQ ít gặp (chỉ link, không chưng cất)

- [Xem/tải file PDF trên Mini App](https://miniapp.zaloplatforms.com/community/8314616809715236303/xem-tai-file-pdf-tren-mini-app) — đã chưng cất: `troubleshooting.md` §12 (Official: FSI #17).
- [Import zmp-sdk từ Cocos Creator](https://miniapp.zaloplatforms.com/community/7810205955052888783/cach-import-zmp-sdk-tu-cocos-creator) — đã chưng cất: `troubleshooting.md` §13 (Official: FSI #18).
- [Không tạo được shortcut trên một số thiết bị Android](https://miniapp.zaloplatforms.com/community/7989788639453340237/khong-the-tao-phim-tat-cho-mini-app-tren-mot-so-thiet-bi-android) — user phải tự cấp quyền "Home screen shortcuts" cho Zalo.
- [Không cut/copy/paste được trong Extension](https://miniapp.zaloplatforms.com/community/8458734196847901647/khong-the-cut-copy-paste-noi-dung-ben-trong-extension) — hạn chế iframe VSCode trên macOS; workaround: bôi đen rồi dùng menu **Edit > Copy/Cut/Paste** (Official: FSI #11).

## 9. Phát hành: quy trình xét duyệt + tiêu chí (guidance-only)

Skill **không thực hiện** bước phát hành (production release ngoài scope — SKILL.md); mục này
để agent trả lời đúng khi user hỏi "làm sao đưa app lên Live".

**Quy trình** (trên Mini App Center — https://mini.zalo.me/developers):

1. **Quản lý phiên bản → Danh sách phiên bản**: chỉ bản ở trạng thái **Testing** gửi xét
   duyệt được (deploy Testing: `deploy-workflow.md`).
2. Gửi yêu cầu xét duyệt theo hướng dẫn → trạng thái đổi thành **Chờ xét duyệt**; Zalo Team
   review theo chính sách Zalo Mini App.
3. Bản **Đã duyệt** → bấm **Publish** để phân phối tới người dùng (thành bản Live).

**Tiêu chí kiểm duyệt** (tóm tắt official — bản đầy đủ:
[Thỏa Thuận Chương Trình Zalo Mini App](https://mini.zalo.me/documents/zalo-mini-app-developer-program-agreement/)):

- Tên/Logo/Mô tả thể hiện đúng tính năng, nhất quán, không vi phạm bản quyền/nội dung cấm;
  loại dịch vụ đúng danh mục đã đăng ký; tính năng người dùng thấy phải khớp mô tả.
- Không điều hướng sang liên kết bên thứ ba, không khuyến khích chia sẻ/tải app riêng, không
  quảng cáo — kiếm tiền, không mua bán vật phẩm ảo/nội dung kỹ thuật số — khi chưa có chấp
  thuận từ Zalo.
- Không nội dung sai lệch/gian lận/lừa đảo/giả mạo/bị pháp luật cấm; tuyệt đối không mã độc
  hoặc dẫn link chứa mã độc.
- Hoạt động ổn định, không crash (không gây crash Zalo); đạt chuẩn performance/thời gian tải;
  UI/UX theo tiêu chuẩn Zalo
  ([Design Guidelines](https://docs.zaloplatforms.com/docs/MA/intro/zalo-mini-program-design-guidelines.md)).
- Đảm bảo quyền riêng tư và bảo mật; định danh người dùng theo chuẩn Authentication của Zalo.

Liên quan trực tiếp khi chuẩn bị xét duyệt: §4 (chính sách Checkout SDK — lý do từ chối có
thật), §5 (đăng ký quyền trước khi release), §3 (app bị tắt tìm kiếm và cách xin mở lại).

Nguồn: [`intro/public-mini-program.md`](https://docs.zaloplatforms.com/docs/MA/intro/public-mini-program.md) — fetch 2026-08-26.
