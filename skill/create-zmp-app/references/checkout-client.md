# Checkout client capability

Đọc `checkout-environments.md` trước file này. V1.0 có hai mode mock; cả hai đều **không** cấu
hình thanh toán tiền thật. Target V1.1 giữ controller/gateway hiện tại nhưng route runtime theo
môi trường: non-Zalo dùng labelled mock, Zalo-ready dùng native SDK, Zalo-blocked/unknown fail-loud.

## Activation và write set

- Bootstrap bật `VITE_CHECKOUT_ENABLED=true` và ghi `VITE_CHECKOUT_MODE=simulator|demo-cod`;
  safe-rerun nhận lại cả capability lẫn mode từ `.env`.
- Capability marker: `src/checkout/controller.ts`.
- UI được gắn ở cart qua `CheckoutPanel`; app base không bật flag thì hành vi cũ giữ nguyên.
- SDK của fixture được pin `zmp-sdk@2.53.0` để contract simulator có thể kiểm chứng.

Các vai trò được tách như sau:

| File | Vai trò |
|---|---|
| `src/checkout/checkout-panel.tsx` | CTA, loading, kết quả và retry |
| `src/checkout/controller.ts` | Thứ tự listener/order/check, chống double-submit |
| `src/checkout/sdk-adapter.ts` | Biên `CheckoutSDK` và `PaymentDone` |
| `src/checkout/merchant-order-gateway.ts` | Biên backend merchant order |
| `src/checkout/template-cart-adapter.ts` | Map cart template sang product ID + quantity |
| `src/checkout/demo-cod-panel.tsx` | Xác nhận COD mock + lưu local + chi tiết đơn Development |

## Chọn mode

- `simulator` (mặc định): kiểm biên SDK bằng mock merchant/host chỉ được inject lúc serve.
  Không deploy.
- `demo-cod`: custom mock UI trong source Mini App. Mọi surface ghi `BẢN DEMO`; không gọi
  `CheckoutSDK`, `/api/merchant-orders` hay payment network. Sau finding 2026-08-24, chỉ dùng
  non-Zalo/local preview; không dùng Development deploy làm evidence native.

Target V1.1 không chọn mock/native bằng build-time mode. `RuntimeEnvironmentDetector` trả
`non_zalo|zalo|unknown`; `CheckoutReadinessProbe` tách `ready|blocked`. Non-Zalo route mock;
Zalo-ready dùng flow SDK bên dưới; Zalo-blocked/unknown hiển thị toast + inline error, không mock
fallback.

## Contract bắt buộc

Client gọi:

```http
POST /api/merchant-orders
Content-Type: application/json

{
  "items": [{ "productId": "ceramic-mug", "quantity": 2 }],
  "idempotencyKey": "<unique-per-checkout-attempt>"
}
```

Client không gửi price, amount, MAC hay Private Key. Gateway cần nhận:

```json
{
  "merchantOrderId": "merchant-order-123",
  "amount": 170000,
  "currency": "VND",
  "items": [],
  "createOrderInput": {
    "amount": 170000,
    "item": [],
    "desc": "Thanh toán đơn merchant-order-123",
    "mac": "<server-generated>",
    "extradata": { "merchantOrderId": "merchant-order-123" }
  }
}
```

`amount`, `currency` và `items` ngoài `createOrderInput` là metadata để backend/debug
có thể dùng; client V1 chỉ tin `merchantOrderId` và `createOrderInput` đã validate.

Controller luôn chạy theo thứ tự:

```text
events.on(PaymentDone)
→ MerchantOrderGateway.createOrder(items + idempotencyKey)
→ CheckoutSDK.createOrder(createOrderInput)
→ PaymentDone {orderId}
→ CheckoutSDK.checkTransaction({data:{orderId}})
→ 1 success | 0 pending | -1 failed | -2 cancelled
```

Không suy kết quả từ việc sheet đóng. `pending` không được hiển thị là paid. Listener
được gỡ khi có kết quả, lỗi hoặc component unmount.

## UI và acceptance markers

- CTA: `[data-testid="checkout-submit"]`.
- Trạng thái: `[data-testid="checkout-status"]`.
- Kết quả terminal: `data-result="success|pending|failed|cancelled"`.
- Cảnh báo handoff: `[data-testid="checkout-backend-required"]`.

Preview simulator phải giữ cart sau failed/cancelled và cho phép retry. Không thêm
nhánh `if simulator`, mock MAC hay fake result vào source Mini App.

### Contract demo-cod lịch sử/local preview

Flow phải là:

```text
cart → Xác nhận thanh toán (BẢN DEMO, COD) → Xác nhận
→ Đặt hàng thành công
→ orderStatus=processing + paymentStatus=unpaid
→ Xem chi tiết đơn hàng
```

Đơn demo lưu local trên thiết bị để feedback UI; đây không phải merchant ledger. Không dùng copy
“thanh toán thành công” hay trạng thái paid cho COD ngay sau confirm. Marker bắt buộc:
`checkout-demo-sheet`, `checkout-demo-badge`, `checkout-demo-confirm`,
`checkout-demo-order-success`, `checkout-demo-view-order`, `checkout-demo-order-detail`.

## Claim được phép báo

- Build/render pass: `checkout-client-integrated`.
- Bốn scenario simulator pass: `checkout-simulator-verified`.
- Mode simulator giữ `CHECKOUT_BACKEND_REQUIRED`; mode demo-cod giữ `CHECKOUT_DEMO_ONLY`. Sau
  guardrail V1.1, mock không được dùng để unblock Development native Checkout.

Không gọi simulator preview hay demo-cod là giao dịch/UAT thật. Khi user muốn native Development
hoặc nhận tiền, chuyển sang [checkout-backend.md](./checkout-backend.md); nếu runtime V1.1 chưa
ship, báo `CHECKOUT_NATIVE_UAT_NOT_IMPLEMENTED`.

Nguồn contract: Portal Checkout SDK cho
[`createOrder`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/createOrder),
[`checkTransaction`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/apis/checkTransaction)
và
[`kết quả phía Mini App`](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/integration-process/overview/maResult).
