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
- Storage: v1 dùng `localStorage` (chạy được ở mọi môi trường kể cả sim). Nâng cấp sau:
  `setStorage`/`getStorage` của zmp-sdk (Native Storage — bền hơn trong Zalo, nhưng thuộc
  nhóm phải đăng ký ở Quản lý quyền khi lên Live, và **sim hiện chưa mock** → gọi trong sim
  sẽ fail rõ; đừng dùng khi user cần test sim).
- Nhớ ranh giới môi trường (operations.md §5): form cấp quyền THẬT chỉ áp dụng khi app LIVE
  cho mọi user; bản dev/testing không có form — vì vậy **verify flow này bằng simulator**
  (mock đúng hành vi live) trước khi gửi xét duyệt.
- Cần số điện thoại/vị trí: cùng pattern với `scope.userPhonenumber`/`scope.userLocation`,
  nhưng hai API đó trả **token decode server-side** (xem sim-mock-data notes + FAQ 22).

**Cách verify sau khi tích hợp:** app lab template → `run.mjs --verify-sim` (accept + deny) +
`--preview-sim` cho user tự bấm; app official template → build + verify browser profile, rồi
`preview.mjs --sim --sim-decision manual` để user bấm nút thật và thấy bottomsheet mock.

## Recipe tiếp theo

Thêm recipe mới vào file này khi user yêu cầu tính năng lặp lại (thanh toán Checkout SDK,
theo dõi OA, chia sẻ...) — mỗi recipe bắt buộc có: nguồn Portal docs + flow chuẩn + code mẫu
+ quy tắc + cách verify. Không thêm recipe không có nguồn.
