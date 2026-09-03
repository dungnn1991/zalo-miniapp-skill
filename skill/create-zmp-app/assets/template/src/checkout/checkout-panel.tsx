import { useEffect, useMemo, useState } from "react";
import { Button } from "zmp-ui";
import { CheckoutController } from "./controller";
import DemoCodPanel from "./demo-cod-panel";
import { HttpMerchantOrderGateway } from "./merchant-order-gateway";
import { ZaloCheckoutSdkAdapter } from "./sdk-adapter";
import type { DemoCodCartItem } from "./template-cart-adapter";
import type { CheckoutResult, CheckoutState, MerchantOrderItem } from "./types";

interface CheckoutPanelProps {
  items: MerchantOrderItem[];
  demoItems: DemoCodCartItem[];
}

const RESULT_COPY: Record<CheckoutResult, string> = {
  success: "Thanh toán thành công.",
  pending: "Thanh toán đang được xử lý. Chưa ghi nhận là đã thanh toán.",
  failed: "Thanh toán không thành công. Bạn có thể thử lại.",
  cancelled: "Bạn đã hủy thanh toán. Giỏ hàng vẫn được giữ nguyên.",
};

function isBusy(state: CheckoutState): boolean {
  return [
    "creating-order",
    "opening-checkout",
    "awaiting-payment",
    "checking-transaction",
  ].includes(state.status);
}

function statusCopy(state: CheckoutState): string | undefined {
  switch (state.status) {
    case "creating-order":
      return "Đang tạo đơn hàng…";
    case "opening-checkout":
      return "Đang mở Checkout…";
    case "awaiting-payment":
      return "Đang chờ bạn hoàn tất thanh toán…";
    case "checking-transaction":
      return "Đang kiểm tra kết quả thanh toán…";
    case "complete":
      return RESULT_COPY[state.result];
    case "error":
      return state.message;
    default:
      return undefined;
  }
}

function SdkCheckoutPanel({ items }: Pick<CheckoutPanelProps, "items">) {
  const controller = useMemo(
    () =>
      new CheckoutController(
        new HttpMerchantOrderGateway(),
        new ZaloCheckoutSdkAdapter(),
      ),
    [],
  );
  const [state, setState] = useState<CheckoutState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      controller.destroy();
    };
  }, [controller]);

  const message = statusCopy(state);
  const result = state.status === "complete" ? state.result : undefined;
  const retry = state.status === "complete" || state.status === "error";

  return (
    <div className="checkout-panel" data-testid="checkout-panel">
      <Button
        fullWidth
        data-testid="checkout-submit"
        disabled={items.length === 0 || isBusy(state)}
        onClick={() => void controller.start(items)}
      >
        {isBusy(state) ? "Đang xử lý…" : retry ? "Thử thanh toán lại" : "Thanh toán"}
      </Button>

      {message && (
        <p
          className={`checkout-status checkout-status-${result ?? state.status}`}
          data-testid="checkout-status"
          data-result={result}
          role="status"
        >
          {message}
        </p>
      )}

      <p className="checkout-backend-note" data-testid="checkout-backend-required">
        Muốn nhận tiền thật, ứng dụng cần Merchant Order API ở backend; không đặt
        Private Key trong Mini App.
      </p>
    </div>
  );
}

export default function CheckoutPanel({ items, demoItems }: CheckoutPanelProps) {
  return import.meta.env.VITE_CHECKOUT_MODE === "demo-cod" ? (
    <DemoCodPanel items={demoItems} />
  ) : (
    <SdkCheckoutPanel items={items} />
  );
}
