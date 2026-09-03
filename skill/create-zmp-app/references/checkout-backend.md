# Checkout backend — UAT nhanh và handoff thương mại

V1.0 chưa dựng backend thật. Mode simulator giữ `CHECKOUT_BACKEND_REQUIRED` và không deploy;
`demo-cod` chỉ là local/non-Zalo mock với `CHECKOUT_DEMO_ONLY`. Không dùng custom demo sheet làm
native Checkout trong Zalo. V1.1 bổ sung một backend UAT tối thiểu để user thấy platform Checkout
UI sớm, sau đó mới nâng lên backend thương mại.

## Backend UAT nhanh: Cloudflare Worker + D1 tùy chọn

Mặc định đề xuất Cloudflare Worker vì có local dev, public HTTPS deployment và free tier phù hợp
demo nhỏ theo chính sách hiện tại. D1 là SQLite serverless để order sống qua nhiều invocation;
không giữ merchant ledger trong biến memory của Worker.

Agent có thể scaffold `backend/checkout-uat-worker/`, cài và test local. Đăng nhập Cloudflare,
tạo resource/D1 và deploy là external side effect: chỉ làm khi user cho phép. User không phải gửi
Private Key vào chat; nhập nó bằng secret prompt/binding của nền tảng.

Endpoint tối thiểu:

```text
POST /api/merchant-orders
POST /api/checkout/notify
GET  /api/merchant-orders/:merchantOrderId
POST /api/merchant-orders/:merchantOrderId/mark-collected
```

- `merchant-orders`: server resolve catalog/price/amount, idempotent create, persist rồi ký MAC.
- `notify`: verify MAC, ghi method selection, trả success response nhanh; không ghi paid.
- `mark-collected`: UAT-admin-authenticated, mô phỏng merchant đã thu COD/BANK rồi gọi
  `updateOrderStatus`; không để public unauthenticated.
- D1 lưu order, line items, payment/method state, idempotency và event history.

Secrets tối thiểu: `CHECKOUT_PRIVATE_KEY`, `UAT_ADMIN_TOKEN`. App ID/environment là config không
secret. Không commit `.dev.vars`, không log secret/MAC/full payload. Free-tier pricing/limits có
thể đổi; agent phải kiểm tra docs chính thức trước khi hướng dẫn setup mới và không hứa “miễn phí
vĩnh viễn”.

Flow user không chuyên:

1. user đăng nhập/tạo Cloudflare account khi agent yêu cầu;
2. agent scaffold, test và — sau consent — deploy Worker/D1;
3. agent trả `API base URL`, `Notify URL`, `Redirect Path` để user dán vào Mini App Center;
4. user mở Mini App Development trong Zalo để thử COD;
5. agent ghi rõ resource UAT, quota/cleanup và cách rollback, không tự xóa resource.

Nguồn:
[Workers quick start](https://developers.cloudflare.com/workers/get-started/guide/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[D1](https://developers.cloudflare.com/d1/get-started/) và
[pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Endpoint phải giữ ổn định

Backend triển khai `POST /api/merchant-orders` theo schema trong
[checkout-client.md](./checkout-client.md). Với mỗi request, server phải:

1. xác thực user/merchant và kiểm tra quyền trên cart;
2. validate `productId`, quantity và tình trạng bán;
3. tự đọc catalog/price server-side, tự tính amount và currency;
4. tạo merchant order bằng `idempotencyKey` có scope theo merchant/user;
5. tạo MAC bằng Private Key ở secret store;
6. lưu order trước khi trả `createOrderInput` cho client.

Không nhận amount/MAC do Mini App gửi. Không cung cấp endpoint "ký MAC hộ" nhận payload
tùy ý. Private Key, provider key và webhook secret không được xuất hiện trong client,
log hoặc repo.

## Dữ liệu tối thiểu cần lưu

Nên có database độc lập cho:

- merchant order, user/merchant, line items, đơn giá và tổng tiền tại thời điểm mua;
- Zalo order ID, provider transaction ID, method, currency;
- trạng thái merchant và trạng thái payment tách riêng;
- callback/notify payload đã redact, thời gian nhận và lịch sử chuyển trạng thái;
- idempotency key, retry/reconciliation attempt và audit actor;
- dữ liệu hóa đơn/đối soát cần export cho kế toán.

Không coi trạng thái UI Mini App là sổ thanh toán. `checkTransaction` giúp UI phản hồi,
còn database + callback/notify/reconciliation server-side mới là nguồn vận hành và đối
soát. Yêu cầu lưu trữ/hóa đơn/thuế cụ thể cần được kế toán hoặc tư vấn pháp lý xác nhận
theo mô hình kinh doanh.

Order local của `demo-cod` cũng không phải sổ đơn. Khi làm backend, giữ UI/state model nhưng thay
local store bằng Merchant Order API và database authoritative.

## Khác nhau theo phương thức

- Phương thức online: nhận kết quả server qua callback theo contract của Checkout/provider,
  verify request rồi cập nhật order idempotently.
- COD/BANK: `notify` chỉ báo user đã chọn phương thức; kết quả cuối do merchant xử lý và
  chủ động đẩy bằng `updateOrderStatus`. Không đánh dấu paid chỉ từ `notify`.

Mọi phương thức cần reconciliation định kỳ và xử lý callback trùng, đảo thứ tự hoặc đến
muộn.

## Gate trước native real-host UAT

- Mini App Center/Checkout đã được cấu hình đúng app và môi trường.
- Private Key Development nằm trong secret binding; không có trong client/repo/log.
- HTTPS notify verify MAC và trả đúng response; endpoint tester có auth/rate limit tối thiểu.
- Amount/order/method khớp giữa merchant DB, Checkout và provider.
- Flow success/pending/failed/cancelled cùng retry/idempotency đã test.
- COD/BANK đã test cả `notify → merchant processing → updateOrderStatus`.
- Dùng catalog/test account UAT, không đưa PII hoặc giao dịch khách thật vào backend demo; có TTL
  hoặc cleanup procedure.

Chỉ sau real-host evidence mới được báo `checkout-uat-verified`; simulator evidence không
nâng claim này.

## Boundary backend thương mại

Backend UAT không mặc nhiên đủ để bán hàng thật. Production còn cần authentication/authorization,
catalog/order authoritative, credential tách Dev/Live và rotation, callback/notify verification,
rate limit/audit/monitoring, reconciliation, backup/incident response, PII retention và export
đơn/giao dịch cho kế toán. Quy tắc hóa đơn/thuế phải được người làm kế toán hoặc tư vấn pháp lý
xác nhận theo mô hình kinh doanh.

Nguồn tiếp tục triển khai: Portal Checkout SDK cho
[`callback`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/webhooks/callback),
[`notify`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/webhooks/notify) và
[`updateOrderStatus`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/updateOrderStatus).
