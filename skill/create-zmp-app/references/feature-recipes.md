# Feature recipes — tích hợp tính năng theo chuẩn Portal

Khi user yêu cầu tích hợp một tính năng cụ thể vào app đã sinh ra, agent PHẢI theo recipe ở
đây nếu có (không tự biên pattern); tính năng chưa có recipe → fetch Portal docs tương ứng
(cơ chế portal-fetch) rồi làm theo docs, ghi nguồn. Sau khi sửa code: **bắt buộc** chạy lại
build + verify + mở preview cho user (app lab: `--verify-sim` được; app official: verify
browser profile + `preview --sim` để user tự thử flow quyền).

## Recipe 1 — Đăng nhập / lấy thông tin user Zalo (login → profile → cache)

**Trigger mẫu:** "tích hợp chức năng đăng nhập user Zalo vào nút X", "lấy thông tin tài
khoản user", "login bằng Zalo".

**Nguồn:** [authorize](https://docs.zaloplatforms.com/docs/MA/api/user/authorization/authorize)
(fetch 2026-08-21) — best practice nguyên văn: *"Sử dụng API getSetting trước để lấy trạng
thái cho phép hiện tại của người dùng, sau đó yêu cầu xin cấp thêm các quyền còn thiếu"*;
lỗi từ chối = `-201`. Scope: `scope.userInfo` ↔ `getUserInfo`.

**Flow chuẩn (đúng thứ tự, không đảo):**

```text
mở lại app → có cache local? → CÓ: dùng local, KHÔNG request lại → xong
                             → KHÔNG:
1. getSetting()            — kiểm tra authSetting["scope.userInfo"]
2. chưa granted → authorize({scopes:["scope.userInfo"]})
                             — form cấp quyền hiện ra (simulator: bottomsheet mock có badge;
                               môi trường thật: form thật của Zalo — chỉ áp dụng khi app LIVE)
   user từ chối (-201)     → UI thông báo thân thiện, KHÔNG hỏi lặp lại
                             (trạng thái được platform ghi nhận; muốn bật lại hướng dẫn user
                              qua openPermissionSetting)
3. getUserInfo()           — sim: persona mock; môi trường thật: data thật từ SDK
4. lưu profile vào storage — lần mở sau đi nhánh cache, không request
```

**Code mẫu (TypeScript, zmp-sdk):**

```ts
import { getSetting, authorize, getUserInfo } from "zmp-sdk/apis";

const PROFILE_CACHE_KEY = "zalo-user-profile-v1";

export async function loginZaloUser() {
  // 4→0) Cache-first: lần mở sau chỉ đọc local, không request lại
  try {
    const cached = localStorage.getItem(PROFILE_CACHE_KEY);
    if (cached) return { userInfo: JSON.parse(cached), fromCache: true };
  } catch { /* storage bị chặn → coi như chưa cache */ }

  // 1) getSetting — best practice Portal: kiểm tra quyền TRƯỚC khi xin
  const { authSetting } = await getSetting({});

  // 2) chưa có quyền → authorize (form cấp quyền)
  if (!authSetting["scope.userInfo"]) {
    const granted = await authorize({ scopes: ["scope.userInfo"] });
    if (!granted["scope.userInfo"]) {
      const err: any = new Error("Người dùng từ chối cấp quyền");
      err.code = -201;
      throw err;
    }
  }

  // 3) getUserInfo — sim trả persona mock; app live trả data thật
  const { userInfo } = await getUserInfo({});

  // 4) cache để lần sau không request
  try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(userInfo)); } catch { /* non-fatal */ }
  return { userInfo, fromCache: false };
}
```

Phía UI gọi `loginZaloUser()` trong onClick của nút; catch `code === -201` → hiển thị thông
báo từ chối thân thiện (đừng auto-retry); lỗi khác → message chung + log.

**Quy tắc đi kèm (bắt buộc):**

- KHÔNG gọi authorize/getUserInfo lúc mount — chỉ khi user bấm (trải nghiệm + tránh xin quyền
  vô cớ, đúng best practice "chỉ khởi tạo yêu cầu khi cần thiết, giải thích rõ lý do").
- Deny (`-201`) là trạng thái hợp lệ: UI xử lý đẹp, không loop hỏi lại; gợi ý
  `openPermissionSetting` khi user muốn đổi ý.
- Storage: v1 dùng `localStorage` cho nhánh cache — **chỉ hợp lệ ở browser/sim**: official
  ghi rõ LocalStorage/SessionStorage/Cookie **không được hỗ trợ trong Zalo Mini App**
  (Recipe 4, nguồn `cache-data.md` fetch 2026-08-26). Bản chạy Zalo thật chuyển sang
  `nativeStorage` (`setItem`/`getItem` — Recipe 4); quyền Native Storage phải đăng ký khi lên
  Live, và **sim hiện chưa mock** → gọi trong sim sẽ fail rõ; đừng dùng khi user cần test sim.
- Nhớ ranh giới môi trường (operations.md §5): form cấp quyền THẬT chỉ áp dụng khi app LIVE
  cho mọi user; bản dev/testing không có form — vì vậy **verify flow này bằng simulator**
  (mock đúng hành vi live) trước khi gửi xét duyệt.
- Cần số điện thoại/vị trí: cùng pattern với `scope.userPhonenumber`/`scope.userLocation`,
  nhưng hai API đó trả **token decode server-side** (xem sim-mock-data notes + FAQ 22).

**Định danh với hệ thống backend riêng** (mức sâu hơn — official
[`best-practices/authen-user.md`](https://docs.zaloplatforms.com/docs/MA/intro/best-practices/authen-user.md),
fetch 2026-08-26): khi app phải đăng nhập vào tài khoản trên HỆ THỐNG CỦA BẠN, không chỉ hiển
thị profile:

1. Client: `getAccessToken()` (zmp-sdk) → gửi access token về server của bạn.
2. Server: gọi Zalo Open API `GET https://graph.zalo.me/v2.0/me` với headers `access_token` +
   **`appsecret_proof`** = HMAC-SHA256(access_token, app_secret) — bắt buộc từ 01/01/2024
   (sai/thiếu → signature `invalid-appsecret-proof`); query `fields=id,name,picture,...`.
3. `id` trả về là mã định danh user, **duy nhất theo từng Zalo App** → tạo tài khoản mới hoặc
   map vào tài khoản sẵn có; cấp session token riêng (khuyến nghị JWT) truyền qua **Header**,
   không Cookie (Recipe 4). App Secret luôn ở server, không bao giờ trong client
   (`phone-number-backend.md`). Hệ thống định danh bằng số điện thoại: 2 case UX hợp lệ +
   decode token — `phone-number-backend.md`.

**Cách verify sau khi tích hợp:** app lab template → `run.mjs --verify-sim` (accept + deny) +
`--preview-sim` cho user tự bấm; app official template → build + verify browser profile, rồi
`preview.mjs --sim --sim-decision manual` để user bấm nút thật và thấy bottomsheet mock.

## Recipe 2 — Fullscreen / ẩn action bar host, tự vẽ header (`actionBarHidden`)

**Trigger mẫu:** "làm app full màn hình", "ẩn thanh điều hướng của Zalo", "custom header",
"header riêng bị đè bởi tiêu đề Zalo".

**Nguồn:** [`devtools/app-config.md`](https://docs.zaloplatforms.com/docs/MA/devtools/app-config.md)
(fetch 2026-08-26) — mẹo official nguyên văn: *"set `actionBarHidden: true` để làm trong suốt
thanh điều hướng mặc định của Zalo, sau đó custom lại header của ứng dụng"*; đối chiếu
`zmp-blank-templates` branch `vite-5-typescript` (đọc 2026-08-26).

**Mặc định của template lab (quyết định 2026-08-26, DX note 51):** DÙNG action bar của host
(`app-contract.md` §7) — chỉ áp recipe này khi user yêu cầu fullscreen/custom.

**Các bước:**

1. `app-config.json` → block `app`:

   ```jsonc
   {
     "app": {
       "title": "…",                            // giữ — field bắt buộc duy nhất
       "actionBarHidden": true,                 // ẩn thanh điều hướng host (default false)
       "statusBar": "transparent",              // icon status bar nổi trên app (hoặc "hidden")
       "hideIOSSafeAreaBottom": true,           // bỏ dải safe-area dưới trên iOS (tuỳ chọn)
       "hideAndroidBottomNavigationBar": false, // chỉ bật khi thật sự cần
       "textColor": { "light": "black", "dark": "white" } // màu icon status bar theo theme Zalo
     }
   }
   ```

   `headerTitle`/`headerColor`/`leftButton` chỉ có tác dụng với action bar host — đã ẩn thì bỏ
   đi cho sạch. Dạng object `{light, dark}` của `headerColor`/`textColor` cần Zalo iOS ≥
   22.03.01.r2 / Android ≥ 21.09.01; bản cũ hơn tự dùng giá trị `light`.

2. `index.html`: viewport thêm `viewport-fit=cover` để app vẽ được vào vùng notch/safe-area:

   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
   ```

3. Header tự vẽ (template lab đã có sẵn component `Header`): đệm safe-area để không đè icon
   status bar, và từ đây header này đảm nhận tiêu đề/nút back — chọn MỘT tầng tiêu đề:

   ```css
   .app-header { padding-top: env(safe-area-inset-top); }
   ```

4. Tương thích: `actionBarHidden`/`statusBar: "transparent"`/`hide*` cần API ≥ 2.25.0, Zalo ≥
   23.02.01.r2 (bảng official) — user Zalo quá cũ vẫn thấy action bar như thường; đừng thiết
   kế phụ thuộc tuyệt đối vào việc nó biến mất.

**Quy tắc đi kèm:**

- KHÔNG bật `actionBarHidden` mặc định cho mọi app — chỉ khi user yêu cầu (quyết định DX 51).
- Chỉ cần đổi title/màu ĐỘNG mà vẫn giữ action bar host: dùng nhóm API View
  (`setNavigationBarTitle` / `setNavigationBarColor` / `setNavigationBarLeftButton` — quyền
  Mặc định theo `permissions.md` §2) thay vì ẩn cả thanh.

**Cách verify:** build + render lại qua `run.mjs --existing`, screenshot viewport mobile cho
user xem header mới. Browser harness không có action bar host thật nên không thấy khác biệt
phần host — safe-area/notch thật phải xem trên thiết bị (Device Mode hoặc app live).

## Recipe 3 — Điều hướng & deeplink (mở app từ ngoài, giữa các Mini App, webview)

**Trigger mẫu:** "tạo link mở app", "deeplink", "mở mini app khác", "nhận param khi mở app",
"mở website trong app", "tạo shortcut ra màn hình".

**Nguồn:** official
[`intro/best-practices/interact-with-zalo-app.md`](https://docs.zaloplatforms.com/docs/MA/intro/best-practices/interact-with-zalo-app.md)
+ [`intro/intro/entry-point-access.md`](https://docs.zaloplatforms.com/docs/MA/intro/intro/entry-point-access.md)
(fetch 2026-08-26); API nhóm `api/routing/*`.

**1. Mở app từ NGOÀI Zalo (web/SMS/email):** link theo đúng cấu trúc official

```text
https://zalo.me/s/{miniAppId}/?key=value
```

— user bấm là được điều hướng thẳng vào Mini App trong Zalo; `?key=value` là param tuỳ biến.
Hoặc cho user quét mã QR của app (quét từ camera, QR Scanner của Zalo, hoặc bấm thẳng QR trong
tin nhắn Zalo). Đây cũng là dạng URL mà deploy-workflow parse sau deploy; bản live không kèm
`env` (`operations.md` §5).

**2. Nhận param trong app:** `getRouteParams()` (nhóm routing) trả các param được gửi đến
trang hiện tại — dùng cho campaign tracking hoặc mở thẳng một màn hình cụ thể.

**3. Mở Mini App khác từ Mini App:**

```js
import { openMiniApp } from "zmp-sdk/apis";

openMiniApp({
  appId: "<Mini App ID đích>",
  params: { key: "value" },
  success: () => {},
  fail: (error) => { console.log(error); }
});
```

Quyền "Yêu cầu mở Mini App" = Mặc định (`permissions.md` §2). Chiều ngược lại có
`sendDataToPreviousMiniApp` gửi dữ liệu về app trước đó.

**4. Mở website trong app (webview):**

```js
import { openWebview } from "zmp-sdk/apis";

openWebview({ url: "https://…", success: () => {}, fail: (error) => {} });
```

Riêng link PDF qua webview có hành vi platform-specific — xem `troubleshooting.md` §12.

**5. Các entry point user vào app (để thiết kế luồng):** QR, Shortcut màn hình
(`createShortcut` — quyền cần Zalo duyệt theo `permissions.md` §2; một số máy Android user
phải tự cấp "Home screen shortcuts" cho Zalo — `operations.md` §8), từ Mini App khác, tin
nhắn chia sẻ, menu tuỳ chỉnh OA, Mini App Store, thanh tìm kiếm Zalo.

**Quy tắc đi kèm:**

- Không tự bịa scheme khác `https://zalo.me/s/…` — đây là cấu trúc official cho điều hướng
  từ ngoài.
- App bị tắt tìm kiếm trên Store thì deeplink/QR vẫn hoạt động (`operations.md` §3).

**Cách verify:** các API điều hướng nằm **ngoài mock registry** của simulator — gọi trong sim
fail rõ theo design; flow chéo app/deeplink phải thử trên **Zalo thật** (Device Mode hoặc bản
deploy). Sau khi sửa code vẫn build + verify qua `run.mjs --existing` như mọi recipe.

## Recipe 4 — Cache dữ liệu (Native Storage, không phải localStorage)

**Trigger mẫu:** "lưu dữ liệu local", "cache profile/giỏ hàng", "app nhớ lựa chọn của user".

**Nguồn:** official
[`intro/best-practices/cache-data.md`](https://docs.zaloplatforms.com/docs/MA/intro/best-practices/cache-data.md)
+ [`intro/best-practices/call-restful-api.md`](https://docs.zaloplatforms.com/docs/MA/intro/best-practices/call-restful-api.md)
+ nhóm API `api/native-storage/*` (fetch 2026-08-26).

**Fact chốt từ official:** trong Zalo Mini App, các API mặc định của trình duyệt
**LocalStorage / SessionStorage / Cookie không được hỗ trợ**. Cache dùng **Native Storage**
(`nativeStorage`, cơ chế sync): mỗi app tối đa **5MB**, đầy thì **dữ liệu cũ nhất tự bị xoá**.
Truyền thông tin xác thực lên server bằng **Header, không dùng Cookie** (Recipe 1 phần
backend, `phone-number-backend.md`).

**Code mẫu (theo sample official):**

```js
import { nativeStorage } from "zmp-sdk/apis";

const saveLocation = async (location) => {
  const locations = await loadLocations();
  locations.push(location);
  try {
    nativeStorage.setItem("recentLocations", locations);
  } catch (error) {
    console.log("Failed to save recentLocations:", error);
  }
  return locations;
};
```

API đầy đủ: `setItem` / `getItem` / `getStorageInfo` / `removeItem` / `clear`.

**Họ API async cũ — lỗi thời:** `zmp-sdk` vẫn export luồng storage **bất đồng bộ** viết riêng
cho Mini App thời kỳ đầu (`setStorage` / `getStorage` / `removeStorage` / `clearStorage` /
`getStorageInfo`, Promise-based). `getStorageInfo` gắn hẳn
`@deprecated Use nativeStorage.getStorageInfo() instead` trong typings `zmp-sdk@2.53.0`, và
cả họ đã rút khỏi Portal docs hiện hành (docs chỉ còn nhóm sync `api/native-storage/*`).
Code mới dùng `nativeStorage` sync; gặp code cũ dùng họ async → khuyến nghị migrate
(user xác nhận 2026-08-26; đối chiếu typings + llms index cùng ngày).

**Quy tắc đi kèm:**

- **Quyền:** "Sử dụng native storage" thuộc nhóm cần **Zalo duyệt** (`permissions.md` §2,
  `operations.md` §5) — đăng ký trước khi release; thiếu thì chỉ user thường bị lỗi còn
  account dev "chạy ngon".
- **Ranh giới môi trường:** `nativeStorage` nằm ngoài mock registry của simulator → trong
  sim/browser fail rõ theo design. Code đa môi trường nên bọc một storage adapter nhỏ: Zalo
  thật dùng `nativeStorage`, browser/sim fallback `localStorage` (chỉ phục vụ dev/preview —
  không phải hành vi production).
- Đầy 5MB là trạng thái bình thường (evict oldest) — không dùng làm nơi lưu duy nhất cho dữ
  liệu quan trọng; thứ cần bền đưa về backend.

**Cách verify:** logic cache verify được ở sim qua nhánh fallback; hành vi `nativeStorage`
thật phải thử trên Zalo (Device Mode hoặc bản deploy). Build + verify qua `run.mjs
--existing` như mọi recipe.

## Recipe 5 — Yêu cầu theo dõi Official Account (`followOA`)

**Trigger mẫu:** "thêm nút quan tâm OA", "xin follow OA", "widget theo dõi Official Account".

**Nguồn:** official
[`intro/best-practices/widget-follow-oa.md`](https://docs.zaloplatforms.com/docs/MA/intro/best-practices/widget-follow-oa.md)
(fetch 2026-08-26).

**Điều kiện tiên quyết (official):**

1. **OA đã được liên kết** với Ứng Dụng của bạn (Zalo App).
2. Mini App **được cấp quyền** dùng API "Yêu cầu theo dõi Official Account" — trang official
   hướng dẫn gửi yêu cầu cấp quyền trong phần cài đặt Mini App. Lưu ý: bảng quyền official
   lại xếp quyền này mức "Mặc định" (`permissions.md` §2) — nếu `followOA` fail, kiểm tra mục
   Quyền Mini App trên Mini App Center trước khi debug code.

**Flow:** UI đặt nút "Theo dõi"/"Quan tâm" → onClick gọi `followOA` → ứng dụng Zalo hiển thị
thông báo để user xác nhận (consent thuộc về user, app không tự follow được).

```jsx
import { followOA } from "zmp-sdk/apis";

followOA({
  id: "<ID Official Account>",
  success: (res) => {},
  fail: (err) => {}
});
```

**Quy tắc đi kèm:**

- Gọi khi user chủ động bấm — không auto-popup lúc mở app (cùng nguyên tắc xin-đúng-ngữ-cảnh,
  `permissions.md` §4).
- `id` là ID của Official Account — không phải Mini App ID hay Zalo App ID.

**Cách verify:** `followOA` nằm ngoài mock registry của simulator → trong sim fail rõ theo
design; verify trên Zalo thật (Device Mode hoặc bản deploy) với OA đã liên kết. Build +
verify qua `run.mjs --existing` như mọi recipe.

## Recipe tiếp theo

Thêm recipe mới vào file này khi user yêu cầu tính năng lặp lại (thanh toán Checkout SDK,
theo dõi OA, chia sẻ...) — mỗi recipe bắt buộc có: nguồn Portal docs + flow chuẩn + code mẫu
+ quy tắc + cách verify. Không thêm recipe không có nguồn.
