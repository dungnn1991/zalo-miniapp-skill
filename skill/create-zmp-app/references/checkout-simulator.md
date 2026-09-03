# Checkout simulator V1

Reference cho host agent khi capability `checkout` chạy với provider simulator. Đây là
mock UI + contract test, **không phải giao dịch, UAT trên Zalo hay bằng chứng đã nhận tiền**.
Mode `demo-cod` là flow mock khác nằm trong source Mini App; xem `checkout-client.md` và không
chạy matrix host Checkout của file này. Mock simulator/demo chỉ áp dụng non-Zalo; trong Zalo,
native-ready dùng SDK thật, còn blocked/unknown phải fail-loud theo `checkout-environments.md`.

## Control

- `simDecision=accept|deny|manual` tiếp tục điều khiển permission mock.
- `checkoutResult=success|pending|fail|cancel` chọn kết quả Checkout deterministic;
  mặc định `success`.
- Khi `simDecision=manual`, payment sheet cho người xem tự chọn cả bốn kết quả.

`buildSimManifest(..., { checkoutResult })` inject `checkout.enabled` từ capability đã ghi
trong `input.json` và `checkout.result` chỉ trong bộ nhớ khi serve. Không ghi config này
vào source/dist.

## Mock merchant boundary

Client gọi:

```http
POST /api/merchant-orders
Content-Type: application/json
Idempotency-Key: <stable cart key>

{"items":[{"productId":"ceramic-mug","quantity":2}],"idempotencyKey":"..."}
```

Chỉ `productId` và `quantity` có ý nghĩa. `price`, `amount`, `total` hay field tương tự
từ client bị bỏ qua. Simulator resolve tên/giá từ catalog harness, validate quantity,
tính `lineTotal` + `amount`, rồi trả:

```json
{
  "merchantOrderId": "SIM-MERCHANT-...",
  "orderId": "SIM-MERCHANT-...",
  "amount": 170000,
  "currency": "VND",
  "items": [{ "productId": "ceramic-mug", "quantity": 2, "unitPrice": 85000, "lineTotal": 170000 }],
  "createOrderInput": {
    "amount": 170000,
    "item": [],
    "desc": "Simulator order ...",
    "mac": "SIMULATOR_MAC_V1_...",
    "extradata": { "merchantOrderId": "SIM-MERCHANT-..." }
  },
  "simulator": true
}
```

Giá clothing VND khớp lab catalog. Neutral catalog dùng giá demo nhân 10.000 để amount
là số nguyên VND. Cùng idempotency key + cùng cart trả cùng order; cùng key + cart
khác trả `409 CHECKOUT_IDEMPOTENCY_CONFLICT`. Mock MAC không phải chữ ký thật và không
dùng được ngoài simulator.

## Checkout host flow

Shim mô phỏng đúng các biên SDK v1:

1. Native `MP_SELECT_PAYMENT_METHOD` trả phương thức mock (mặc định `COD`).
2. `payment-mini.../api/order/create-v2` validate mock MAC, tạo ZMP order ID ổn định.
3. Native `OPEN_INAPP` resolve trước.
4. Macrotask kế tiếp mới hiện payment sheet. Như vậy zmp-sdk có thời gian gắn
   listener `WebviewClosed`/`PaymentDone`.
5. Sheet đóng → emit `WebviewClosed`; zmp-sdk emit `PaymentDone {orderId}`.
6. `payment-mini.../api/transaction` trả result ổn định, đọc lặp lại an toàn.

| `checkoutResult` | `resultCode` |
|---|---:|
| `success` | `1` |
| `pending` | `0` |
| `fail` | `-1` |
| `cancel` | `-2` |

Payment sheet luôn ghi `SIMULATOR`. Marker QA:

- `[data-testid="checkout-sim-sheet"]`
- `[data-testid="checkout-sim-badge"]`
- manual buttons `checkout-sim-success|pending|fail|cancel`

## Evidence và giới hạn

`bridge-log.jsonl` chỉ ghi action/decision/error code như `merchant.create-order`,
`checkout.create-order`, `checkout.open-inapp`, `h5.event.webview.close`,
`checkout.check-transaction`; không ghi cart, amount, MAC hay request payload.

Pass simulator chỉ chứng minh client state machine, adapter boundary và bốn UI result chạy
deterministic. Backend thật vẫn phải resolve catalog server-side, quản lý Private Key/MAC,
idempotency, order database và reconciliation; xem `references/checkout-backend.md`.
