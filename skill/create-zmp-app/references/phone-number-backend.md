# Lấy số điện thoại người dùng — vì sao phải có backend

Áp dụng khi app cần **số điện thoại thật** của người dùng Zalo (autofill form đăng ký, xác minh
đơn hàng…). Đây là contract + pseudocode; **backend thật thuộc phần tích hợp của bạn**, skill
không dựng hộ và không giữ credential nào.

## 1. Cái Mini App nhận được KHÔNG phải số điện thoại

`getPhoneNumber()` của `zmp-sdk` chỉ trả về một **token ngắn hạn**, không phải chuỗi số. Muốn
đổi token đó thành số thật phải gọi OpenAPI của Zalo kèm **App Secret**.

Vì vậy:

> **App Secret không bao giờ được nằm trong client.** Mọi thứ trong `src/` đều đi vào bundle và
> ai mở DevTools cũng đọc được. Lộ App Secret nghĩa là bất kỳ ai cũng mạo danh được ứng dụng của
> bạn.

Preflight `server_side_api_scan` của skill chặn đúng pattern này (endpoint server-side hoặc
literal secret trong `src/`), và **không có ngoại lệ cho official template** — `zaui-lucky-wheel`
ở revision `8c692b9` mắc đúng lỗi này nên phải đi qua một compatibility adapter phía DX
(`catalog/adapters/zaui-lucky-wheel.json`) gỡ đoạn code đó ra trước khi build.

## 2. Luồng đúng

```text
Mini App                         Backend của bạn                   Zalo OpenAPI
   │                                    │                                │
   │ 1. user bấm "điền số của tôi"      │                                │
   │    → xin quyền (authorize)         │                                │
   │ 2. getPhoneNumber() → token        │                                │
   │────── POST /phone { token } ──────▶│                                │
   │        (kèm access token của user) │ 3. giữ App Secret ở server     │
   │                                    │───── gọi OpenAPI + secret ────▶│
   │                                    │◀──────── số điện thoại ────────│
   │◀───── { phoneNumber } ─────────────│ 4. log/rate-limit/audit        │
```

Client chỉ biết hai thứ: token nhận từ SDK, và số điện thoại backend trả về.

## 3. Contract tối thiểu giữa app và backend

```ts
// CLIENT — không có secret, không gọi thẳng OpenAPI
type PhoneResponse =
  | { source: "backend"; number: string }
  | { source: "backend-required" };   // backend chưa cấu hình

async function resolvePhoneNumber(): Promise<PhoneResponse> {
  const { token } = await getPhoneNumber();          // zmp-sdk: chỉ có token
  const accessToken = await getAccessToken();
  const res = await fetch(`${import.meta.env.VITE_API_URL}/phone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, accessToken }),
  });
  if (!res.ok) return { source: "backend-required" };
  const data = await res.json();
  return { source: "backend", number: data.phoneNumber };
}
```

```text
SERVER — pseudocode, ngôn ngữ nào cũng được
POST /phone
  input : { token, accessToken }
  steps :
    1. xác thực request đến từ chính user đó (accessToken), rate-limit theo user
    2. đọc APP_SECRET từ secret store của môi trường — KHÔNG hardcode, KHÔNG commit
    3. gọi Zalo OpenAPI để đổi token lấy số
    4. map lỗi upstream sang lỗi của bạn; không trả nguyên văn payload upstream
    5. audit log: ai hỏi, lúc nào — KHÔNG log token và KHÔNG log secret
  output: { phoneNumber }  hoặc lỗi có mã rõ ràng
```

## 4. Những chỗ phải xử lý ở backend, không phải ở app

- **HTTPS + CORS.** Chỉ allow origin Mini App của bạn; đừng để `Access-Control-Allow-Origin: *`
  trên endpoint có thật dữ liệu người dùng. Skill có gate `cors_preflight` cảnh báo giúp.
- **Token hết hạn / dùng lại.** Token từ SDK sống rất ngắn và dùng một lần; hết hạn là trạng
  thái bình thường, không phải bug — trả lỗi có mã để client hiện lại nút thử lại.
- **Lưu và xoay App Secret.** Secret store của môi trường; không `.env` commit, không log.
- **Rate limit + audit.** Endpoint này đổi được token lấy PII, nên phải đếm và ghi lại.
- **Quyền riêng tư.** Chỉ lưu số điện thoại khi thật sự cần, và nói rõ cho người dùng.

## 5. Trong lúc chưa có backend

Skill không tự bịa số. Kết quả run mang một `warnings[]` có cấu trúc, tách rõ bốn ý:

```json
{
  "code": "PHONE_BACKEND_REQUIRED",
  "blockingForPreview": false,
  "blockingForProductionFeature": true,
  "affectedFeature": "phone-number-autofill",
  "fallback": "manual-input",
  "guide": "references/phone-number-backend.md",
  "message": "Preview dùng được bình thường. Riêng tính năng tự động điền số điện thoại chưa production-ready…"
}
```

Nghĩa là: **preview vẫn dùng được**, chỉ riêng autofill là chưa sẵn sàng cho production,
fallback hiện tại là người dùng nhập tay, và hướng dẫn nằm ở file này.

UI tương ứng:

- **Trong simulator** (`window.__ZMP_DX_RUNTIME__.mode === "simulator"`): điền số mẫu kèm nhãn
  bắt buộc *"DỮ LIỆU GIẢ LẬP — số điện thoại này là dữ liệu mẫu, không phải dữ liệu của tài
  khoản Zalo."*
- **Mọi môi trường khác** (kể cả Zalo thật): **không** điền gì, ô để trống, hiện *"Tự động điền
  số điện thoại chưa được cấu hình. Tính năng này cần backend để giải mã token an toàn; bạn vẫn
  có thể nhập số điện thoại thủ công."*

Fail-closed: thiếu marker, sai `schemaVersion` hay sai `mode` đều rơi vào nhánh thứ hai. Không
được nhận biết simulator bằng URL/hostname/user-agent — simulator cố ý dùng đúng hostname thật
để `zmp-sdk` nhận đúng môi trường (xem `references/simulator-workflow.md` §1c).

## 6. Nguồn

- Portal: `getPhoneNumber` — API trả token, decode server-side
  (`https://docs.zaloplatforms.com/docs/MA/api/user/user-information/getPhoneNumber.md`).
- Community FAQ #22 (`references/sim-mock-data.json` notes, `references/troubleshooting.md`):
  không đặt endpoint server-side hay secret trong client.
