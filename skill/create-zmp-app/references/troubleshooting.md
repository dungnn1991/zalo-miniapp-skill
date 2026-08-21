# Troubleshooting — lỗi dev/build/deploy thường gặp

> **Attribution:** Chưng cất từ chuyên mục FAQ công khai của **Hồng Phát (Supporter)** —
> https://miniapp.zaloplatforms.com/community (crawl **2026-08-21**, bản lưu:
> `DX/community-faq-best-practice/`), cộng kinh nghiệm thật của lab. Mỗi mục ghi link nguồn.
> Match log tự động: dùng `references/error-signatures.json` trước; file này để đọc sâu.

## 1. Network Error / CORS (lỗi phổ biến nhất)

- **Triệu chứng:** gọi API thành công bằng Postman/cURL/localhost nhưng fail trên Mini App —
  `Network Error`, `Failed to fetch`, `blocked by CORS policy`, hoặc
  `Response to preflight request doesn't pass access control check`.
- **Nguyên nhân:** CORS (phổ biến nhất); ngoài ra: URL không https, domain hết hạn SSL, gọi IP
  trần, custom header không nằm trong `Access-Control-Allow-Headers`.
- **Fix — ở SERVER, không phải ở Mini App** (các thông tin "lỗi báo ở Mini App thì fix ở Mini
  App" hay "CORS là cơ chế riêng của Zalo" là **không chính xác**):
  - Server trả header `Access-Control-Allow-Origin` với origin của Mini App: `https://h5.zdn.vn`.
  - Trả header này **cả cho preflight request (method `OPTIONS`)** — thiết lập CORS cho request
    chính nhưng quên OPTIONS là biến thể hay gặp nhất.
  - **❌ Không hợp lệ:** không trả `Access-Control-Allow-Origin`; chỉ trả cho GET/POST/PUT/DELETE
    mà không trả cho OPTIONS; trả nhiều origin cách nhau dấu phẩy
    (`Access-Control-Allow-Origin: https://h5.zdn.vn,http://localhost:3000`).
  - **✅ Hợp lệ:** kiểm tra origin của request và trả về đúng **một** giá trị tương ứng
    (`https://h5.zdn.vn` khi gọi từ Mini App; `http://localhost:3000` khi dev localhost).
  - URL gọi API: **✅** `https://my-server.com/api` · **❌** `http://...` (không https),
    `https://118.63.103.143:443` (IP trần) — Mini App chạy trong Secure Context.
- Nguồn: [Network Error](https://miniapp.zaloplatforms.com/community/282604656005284416/network-error) — Hồng Phát, crawl 2026-08-21.

## 2. Minified React error #N

- **Triệu chứng:** console bản build báo `Minified React error #<số>`.
- **Nguyên nhân:** bug React runtime (sai quy tắc hooks, setState trong lúc render, render
  component không hợp lệ...). Bản production minify đã map nội dung lỗi thành mã số.
- **Fix:** mở link trong chính thông báo lỗi để đọc message đầy đủ của mã đó, rồi sửa đúng chỗ
  vi phạm.
- Nguồn: [Minified React error](https://miniapp.zaloplatforms.com/community/8963145051577348815/minified-react-error-ma-loi) — Hồng Phát, crawl 2026-08-21.

## 3. Lỗi ES2015 khi build

- **Triệu chứng:** `Transforming async generator functions to the configured target environment
  ("es2015") is not supported yet` (hoặc `for-await loops ...`).
- **Nguyên nhân:** một thư viện dependency dùng tính năng JS không hạ ngược được về ES2015 —
  target đóng gói mặc định của Zalo Mini App.
- **Fix (2 hướng):**
  1. Nâng target trong `vite.config.js`/`.ts` (build.target `esnext`) — đổi lại **giảm tương
     thích thiết bị cũ**.
  2. Thay thư viện cùng mục đích: `fetch` thay `axios`, ZaUI Components thay `mui/material`...
- Nguồn: [Lỗi ES2015](https://miniapp.zaloplatforms.com/community/8242558116182457551/loi-es2015) — Hồng Phát, crawl 2026-08-21.

## 4. Build xong nhưng deploy fail: "output folder www was not found"

- **Triệu chứng:** build exit 0, deploy báo không tìm thấy thư mục `www` (EN hoặc VN).
- **Nguyên nhân:** dùng Vite 5 nhưng vite config còn thiết lập Vite 2 / thiếu `zmp-vite-plugin`
  (thường do vô tình nâng version hoặc cài lại node_modules không có lock file); hoặc deploy
  không trỏ đúng outDir thật của project.
- **Fix:** cấu hình `zmp-vite-plugin` trong vite config; thiếu thư viện thì
  `npm i -D zmp-vite-plugin`.
- **Kinh nghiệm lab (đã pin trong `config.json` `zmpCli`):**
  - Template lab build ra `dist/` → lệnh deploy phải giữ `-o dist`.
  - `zmp sync-config dist/index.html` là **bắt buộc** sau build, trước deploy `-e`
    (populate `listSyncJS`/`listCSS` trong app-config.json — thiếu là deploy hỏng).
  - Official templates có thể ra outDir `www`/`src/www` — build stage tự detect outDir sau
    build và dùng cho render/deploy.
- Nguồn: [Deploy thất bại — www not found](https://miniapp.zaloplatforms.com/community/5468297315658843471/du-an-duoc-build-thanh-cong-nhung-deploy-that-bai-nguyen-nhan-khong-tim-thay-thu-muc-dich-voi-ten-www-neu-ban-dang-su-dung-vite-5-vui-long-kiem-tra-file-vite-config-va-dam-bao-zmp-vite-plugin-da-duoc-cau-hinh-dung-cach) — Hồng Phát, crawl 2026-08-21.

## 5. CI/CD: "Permission denied. Please login again."

- **Triệu chứng:** deploy trong CI/CD (hoặc local) fail với message trên.
- **Nguyên nhân — 3 bẫy từ FAQ:**
  1. `ZALO_APP_SECRET`/`ZALO_REFRESH_TOKEN` không **khớp** `ZALO_APP_ID` — hay gặp khi sở hữu
     nhiều Zalo App và lấy token từ tool explorer của Zalo for Developers mà chưa chọn đúng app.
  2. Nhầm `MINI_APP_ID` với `ZALO_APP_ID` — **hai ID hoàn toàn khác nhau** (dù liên hệ trực
     tiếp); dùng MINI_APP_ID ở bước cần ZALO_APP_ID là ra đúng lỗi này.
  3. Biến môi trường `ZMP_TOKEN` trong runner **ghi đè** giá trị trong `.env` — ít gặp nhưng
     rất khó nhận biết; đảm bảo runner không set env `ZMP_TOKEN`.
- **Fix:** interactive → login lại theo QR flow của skill (`references/deploy-workflow.md` §3).
  CI/CD → soát 3 điểm trên; có thể test lệnh `npx zmp-developer-token ...` ngay trên máy cá
  nhân thay vì chỉ debug trên runner. **Không retry mù.**
- Nguồn: [Lỗi CI/CD](https://miniapp.zaloplatforms.com/community/8170499422582570959/loi-ci-cd) — Hồng Phát, crawl 2026-08-21.

## 6. Cannot find module '@vitejs/plugin-react-refresh'

- **Triệu chứng:** build fail với message trên.
- **Nguyên nhân:** dependency đã thay plugin cũ `@vitejs/plugin-react-refresh` bằng
  `@vitejs/plugin-react` nhưng vite config vẫn import tên cũ.
- **Fix:** trong `vite.config.js`/`.ts`, đổi `import reactRefresh from
  "@vitejs/plugin-react-refresh"` + `reactRefresh()` → `import react from
  "@vitejs/plugin-react"` + `react()`.
- Nguồn: [plugin-react-refresh](https://miniapp.zaloplatforms.com/community/8530792890447788239/cannot-find-module-vitejs-plugin-react-refresh) — Hồng Phát, crawl 2026-08-21.

## 7. Ảnh hiển thị ở localhost nhưng chết trên CDN

- **Triệu chứng:** ảnh hiện bình thường khi dev localhost, không hiện khi chạy trên Zalo thật.
- **Nguyên nhân:** dùng public path tuyệt đối (`<img src="/coffee.jpg">` hoặc
  `src="../public/coffee.jpg"`) — asset không được Vite đóng gói theo bundle, đường dẫn chết
  khi app serve từ CDN (`h5.zdn.vn`).
- **Fix — import syntax để Vite bundle asset:**
  ```jsx
  // ❌ <img src="/coffee.jpg" />        (chỉ chạy localhost)
  // ✅
  import coffee from "./coffee.jpg";
  <img src={coffee} />
  ```
- Nguồn: [Hình ảnh không hiển thị](https://miniapp.zaloplatforms.com/community/9035203745110127567/hinh-anh-khong-hien-thi) — Hồng Phát, crawl 2026-08-21.

## 8. "The file size is too large." khi deploy

- **Triệu chứng:** deploy fail với message trên.
- **Nguyên nhân:** vượt giới hạn mỗi phiên bản: **10MB tổng cả app, 3MB mỗi file**.
- **Fix:** static resource (ảnh/video) → upload server riêng/CDN; script quá nặng → **code
  splitting** (blog "Giảm kích thước Zalo Mini App và tối ưu hoá thời gian tải" trên
  mini.zalo.me, link trong FAQ nguồn). Preflight gate `size_limit` của pipeline chặn sớm case
  này ngay ở build.
- Nguồn: [File size too large](https://miniapp.zaloplatforms.com/community/8098440729049792207/the-file-size-is-too-large) — Hồng Phát, crawl 2026-08-21.

## 9. API gọi "thành công" nhưng không có dữ liệu khi dev

- **Triệu chứng:** dev bằng Studio/Extension/CLI, gọi `getAccessToken`/`createOrder`... không ra
  dữ liệu thật.
- **Nguyên nhân — không phải bug:** browser/simulator chỉ giúp **xem giao diện**; các flow này
  yêu cầu app chạy trong môi trường thật của Zalo (trong ứng dụng Zalo). Browser harness của
  skill này cũng vậy: verify UI/render, không verify data flow host-specific.
- **Fix:** dùng **Chế độ Device** — Mini App chạy trong Zalo thật nhưng load code từ server hot
  reload trên máy dev → gọi được API thật, nhận dữ liệu thật.
- Nguồn: [API không có dữ liệu khi dev](https://miniapp.zaloplatforms.com/community/9179321132242792911/api-duoc-goi-thanh-cong-nhung-khong-co-du-lieu-khi-dev) — Hồng Phát, crawl 2026-08-21.
