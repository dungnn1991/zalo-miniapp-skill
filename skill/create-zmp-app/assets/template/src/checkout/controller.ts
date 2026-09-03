import type { CheckoutSdkAdapter } from "./sdk-adapter";
import type { MerchantOrderGateway } from "./merchant-order-gateway";
import type {
  CheckoutResult,
  CheckoutState,
  MerchantOrderItem,
  PaymentDonePayload,
} from "./types";

export type CheckoutStateListener = (state: CheckoutState) => void;

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `checkout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapResultCode(resultCode: number): CheckoutResult {
  switch (resultCode) {
    case 1:
      return "success";
    case 0:
      return "pending";
    case -1:
      return "failed";
    case -2:
      return "cancelled";
    default:
      throw new Error(`Checkout trả resultCode chưa được hỗ trợ: ${resultCode}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Không thể bắt đầu thanh toán. Vui lòng thử lại.";
}

export class CheckoutController {
  private state: CheckoutState = { status: "idle" };
  private readonly listeners = new Set<CheckoutStateListener>();
  private paymentDoneCleanup?: () => void;
  private runId = 0;
  private active = false;

  constructor(
    private readonly gateway: MerchantOrderGateway,
    private readonly sdk: CheckoutSdkAdapter,
  ) {}

  getState(): CheckoutState {
    return this.state;
  }

  subscribe(listener: CheckoutStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(items: MerchantOrderItem[]): Promise<void> {
    if (this.active) {
      return;
    }
    if (items.length === 0) {
      this.setState({ status: "error", message: "Giỏ hàng đang trống." });
      return;
    }

    const currentRun = ++this.runId;
    this.active = true;
    this.clearPaymentDoneListener();

    // The listener must exist before the merchant request and createOrder call.
    this.paymentDoneCleanup = this.sdk.onPaymentDone((payload) => {
      void this.handlePaymentDone(currentRun, payload);
    });

    this.setState({ status: "creating-order" });
    try {
      const merchantOrder = await this.gateway.createOrder({
        items,
        idempotencyKey: createIdempotencyKey(),
      });
      if (!this.isActiveRun(currentRun)) {
        return;
      }

      this.setState({ status: "opening-checkout" });
      const checkoutOrder = await this.sdk.createOrder(
        merchantOrder.createOrderInput,
      );
      if (!this.isActiveRun(currentRun)) {
        return;
      }

      this.setState({
        status: "awaiting-payment",
        orderId: checkoutOrder.orderId,
      });
    } catch (error) {
      if (this.isActiveRun(currentRun)) {
        this.finishWithError(error);
      }
    }
  }

  destroy(): void {
    this.runId += 1;
    this.active = false;
    this.clearPaymentDoneListener();
    this.listeners.clear();
  }

  private async handlePaymentDone(
    currentRun: number,
    payload: PaymentDonePayload,
  ): Promise<void> {
    if (!this.isActiveRun(currentRun)) {
      return;
    }

    this.clearPaymentDoneListener();
    this.setState({
      status: "checking-transaction",
      orderId: payload.orderId,
    });

    try {
      const transaction = await this.sdk.checkTransaction(payload.orderId);
      if (!this.isActiveRun(currentRun)) {
        return;
      }

      this.active = false;
      this.setState({
        status: "complete",
        orderId: payload.orderId,
        result: mapResultCode(transaction.resultCode),
      });
    } catch (error) {
      if (this.isActiveRun(currentRun)) {
        this.finishWithError(error);
      }
    }
  }

  private finishWithError(error: unknown): void {
    this.active = false;
    this.clearPaymentDoneListener();
    this.setState({ status: "error", message: errorMessage(error) });
  }

  private isActiveRun(currentRun: number): boolean {
    return this.active && currentRun === this.runId;
  }

  private clearPaymentDoneListener(): void {
    this.paymentDoneCleanup?.();
    this.paymentDoneCleanup = undefined;
  }

  private setState(state: CheckoutState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }
}
