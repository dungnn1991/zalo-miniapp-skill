# Checkout environment contract

Đọc file này **trước** các reference Checkout khác khi prompt yêu cầu thanh toán. Mục tiêu là để
user luôn biết app đang chạy mock, native Checkout hay bị block; không dùng một custom sheet để
giả thành UI Checkout thật trong Zalo.

## Phản hồi bắt buộc trước khi làm

Nói ngắn gọn bằng ngôn ngữ của user:

> Browser/simulator sẽ dùng mock có nhãn và không thu tiền. Trong Zalo, app chỉ mở Checkout thật
> khi backend UAT và Mini App Center đã sẵn sàng; nếu thiếu cấu hình/quyền, app hiện lỗi cụ thể và
> không tự chuyển sang mock.

Đây là status một chiều, không phải câu hỏi chặn. Nếu user chỉ cần preview, dùng simulator. Nếu
user yêu cầu Development/native UAT, kiểm tra readiness và nói rõ external setup còn thiếu.

## Ma trận hành vi

| Runtime | Adapter | UI | Network/data | Warning/claim |
|---|---|---|---|---|
| `non_zalo` | labelled mock | Badge cố định `MÔ PHỎNG — KHÔNG THU TIỀN` | mock local/harness; zero Checkout/merchant network thật | `checkout-mock-verified` |
| simulator runner | labelled mock host | Badge `SIMULATOR` trên sheet và result | deterministic mock merchant + SDK host | `checkout-simulator-verified` |
| `zalo` + ready | native | UI do Checkout platform mở | merchant backend + Checkout SDK thật | chỉ claim UAT khi có real-host evidence |
| `zalo` + blocked | error presenter | toast + inline error card bền | không fake order/success; không mock fallback | `checkout-native-blocked` |
| `unknown` | error presenter | lỗi không xác định host | fail-closed | `CHECKOUT_ENV_UNKNOWN` |

Runtime detection phải trả `non_zalo | zalo | unknown` bằng signal host/SDK đã test. Không dùng
user-agent đơn lẻ. `unknown` không được nhập chung với browser.

## Readiness trong Zalo

Native path chỉ chạy khi đồng thời có:

1. Checkout SDK/host bridge khả dụng;
2. `merchantApiBaseUrl` hợp lệ và backend health/order endpoint phản hồi;
3. đúng Mini App ID/environment;
4. method đã cấu hình/active trong Mini App Center;
5. backend giữ Private Key/MAC và trả `createOrderInput` đã ký.

Client không thể đọc hết cấu hình Portal trước khi gọi. Readiness probe chỉ xác nhận phần quan
sát được; lỗi platform khi `createOrder` vẫn phải map sang UI action được.

## Contract lỗi UI

Mỗi lỗi native có:

- toast ngay với một câu dễ hiểu;
- `[data-testid="checkout-error"]` không tự biến mất;
- safe `data-error-code`;
- mô tả việc cần sửa, nút retry và quay lại cart.

Map tối thiểu:

| Error | Mã UI |
|---|---|
| Không xác định host | `CHECKOUT_ENV_UNKNOWN` |
| Backend URL thiếu/timeout/4xx/5xx | `CHECKOUT_BACKEND_UNAVAILABLE` |
| SDK `-2001`/`-2002` | `CHECKOUT_ACCESS_REQUIRED` |
| SDK `-2101`…`-2104` hoặc `-2203` | `CHECKOUT_ORDER_INVALID` |
| SDK `-2201`/`-2301` | `CHECKOUT_METHOD_NOT_READY` |
| SDK `-5000`/khác | `CHECKOUT_UNKNOWN_ERROR` |

Không hiện raw response, secret, MAC, stack trace hoặc PII. Không ghi paid/success khi request bị
block hoặc sheet chỉ đóng.

## Mini App Center checklist

Khi user muốn native UAT, agent hướng dẫn user vào đúng Mini App ID:

1. mở cấu hình Checkout và bật app/method cho môi trường cần thử;
2. với COD/BANK, điền public HTTPS Notify URL và Redirect Path;
3. đặt credential/Private Key vào secret store của backend, không gửi vào chat/client repo;
4. chạy Development trace và lưu evidence đã redact.

Sau `createOrder` hợp lệ, platform tự mở Checkout UI. Nếu trong Zalo vẫn render custom mock sheet,
đó là lỗi adapter routing; không sửa CSS để làm mock “giống native hơn”.

## Trạng thái package hiện tại

V1.0 đã có `simulator` và custom `demo-cod`. `demo-cod` chỉ là UI mock/local order; sau khi phát
hiện nó render trong Zalo như một sheet tự dựng, **không dùng mode này để claim hoặc chứng minh
native Checkout UAT**. Cho đến khi runtime router/native backend V1.1 được implement, yêu cầu
native Development phải fail/report `CHECKOUT_NATIVE_UAT_NOT_IMPLEMENTED` thay vì silent fallback.

Runtime implementation V1.1 là follow-on; reference này chỉ khóa behavior/guardrail để agent
không báo sai khả năng hiện tại.

Nguồn Portal:
[setting](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/integration-process/overview/setting),
[create order flow](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/integration-process/create-order),
[select method](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/select-method/api),
[error codes](https://docs.zaloplatforms.com/docs/MA/checkoutSdk/errorcodes).
