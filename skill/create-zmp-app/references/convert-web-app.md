# Chuyển đổi Web App có sẵn thành Zalo Mini App

Reference guidance khi user đã có web app chạy tốt trên mobile/tablet và muốn đưa lên Zalo.
**Ngoài scope thực thi của skill:** bootstrap chỉ scaffold app mới từ template (`--existing`
là bind ID/tiếp tục app do chính skill sinh ra — không phải convert web app ngoài). Dùng file
này để tư vấn đúng theo official; tự động hoá convert là việc lớn, cần plan riêng
(DX note 51 §5-C4).

> **Attribution:** chưng cất từ Portal official
> [`intro/getting-started/convert-web-app-to-mini-app.md`](https://docs.zaloplatforms.com/docs/MA/intro/getting-started/convert-web-app-to-mini-app.md)
> (fetch **2026-08-26**).

## 1. Chuẩn bị

Web app đảm bảo trải nghiệm mobile/tablet, và đã tạo Mini App để có ID
(`app-id-provisioning.md`).

## 2. Phía client — 7 điểm hay vấp

1. **Khởi tạo trên project sẵn có:** cài `zmp-cli`, chạy `zmp init` tại root project, login,
   chọn **"Using ZMP to deploy only"** → sinh `.env` (biến môi trường phục vụ deploy) +
   `app-config.json` (block `app` cấu hình status bar/action bar + `listCSS`/`listSyncJS`/
   `listAsyncJS`).
2. **Root element:** sau deploy, app dùng file index do hệ thống Zalo sinh ra (không phải
   `index.html` bạn build); root element mặc định có id **`app`** → đổi selector mount về
   `document.getElementById("app")`.
3. **Module bundler / public path:** source sau build được đặt trên CDN Zalo theo folder
   `<miniAppId>/<version>`:
   - **Vite:** `base: "./"` + rollup output `entryFileNames`/`chunkFileNames` =
     `assets/[name].[hash].module.js`.
   - **Webpack:** `__webpack_public_path__ = ` `` `./${window.APP_VERSION}/` `` (global
     `window.APP_VERSION` = version Mini App đang chạy).
4. **Dynamic import không tải được trên iOS (Vite):** tắt polyfill —
   `build.polyfillModulePreload: false`.
5. **Router:** app được serve dưới base **`/zapps/<MINI_APP_ID>`** → set basename/base href
   theo path đó. Angular: provider `APP_BASE_HREF` với value `/zapps/[ZALO_MINI_APP_ID]`.
   react-router/Reach-router: cùng nguyên tắc set basename — hai code block này trong trang
   nguồn hiện **rỗng**, đừng trích dẫn như thể có sample.
6. **Xác thực khi gọi API:** định danh bằng Access Token hoặc JWT riêng;
   **LocalStorage/SessionStorage/Cookie không được hỗ trợ** → truyền token qua **Header**
   (Recipe 4, `feature-recipes.md`).
7. **Khai báo assets trong `app-config.json`:** vì index do Zalo sinh, phải tự liệt kê các
   file js/css mà `index.html` build ra cần: điền vào `listCSS` + `listSyncJS`
   (+ `listAsyncJS` cho script async).

## 3. Phía server

CORS: trả `Access-Control-Allow-Origin: https://h5.zdn.vn` — Node dùng package `cors` với
`origin: "https://h5.zdn.vn"`; Nginx `add_header 'Access-Control-Allow-Origin'
'https://h5.zdn.vn' always;`. Biến thể preflight/nhiều-origin: `troubleshooting.md` §1.

## 4. Deploy

`zmp deploy` → chọn **"Deploy your existing project"** → điền build folder → quét QR để trải
nghiệm thử.

## 5. Đối chiếu với pipeline của skill

App do skill sinh dùng `zmp-vite-plugin`: plugin tự ép `base: "./"` khi build và tự sinh
`app-config.json` trong outDir với `listSyncJS`/`listCSS` lấy từ bundle — nên KHÔNG phải khai
tay bước 7. Project convert tự build thì phải khai tay, hoặc dùng
`zmp sync-config <outDir>/index.html` như deploy-workflow của skill.
