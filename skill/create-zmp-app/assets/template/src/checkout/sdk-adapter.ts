import { CheckoutSDK, EventName, events } from "zmp-sdk/apis";
import type { CheckTransactionReturns, CreateOrderReturns } from "zmp-sdk";
import type {
  CheckoutCreateOrderInput,
  PaymentDonePayload,
  TransactionResult,
} from "./types";

export interface CheckoutSdkAdapter {
  onPaymentDone(listener: (payload: PaymentDonePayload) => void): () => void;
  createOrder(input: CheckoutCreateOrderInput): Promise<CreateOrderReturns>;
  checkTransaction(orderId: string): Promise<TransactionResult>;
}

function readPaymentDonePayload(value: unknown): PaymentDonePayload | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const orderId = (value as Record<string, unknown>).orderId;
  return typeof orderId === "string" && orderId.length > 0
    ? { orderId }
    : undefined;
}

export class ZaloCheckoutSdkAdapter implements CheckoutSdkAdapter {
  onPaymentDone(listener: (payload: PaymentDonePayload) => void): () => void {
    const handler = (value: unknown) => {
      const payload = readPaymentDonePayload(value);
      if (payload) {
        listener(payload);
      }
    };

    events.on(EventName.PaymentDone, handler);
    return () => {
      events.off(EventName.PaymentDone, handler);
    };
  }

  createOrder(input: CheckoutCreateOrderInput): Promise<CreateOrderReturns> {
    return CheckoutSDK.createOrder(input);
  }

  async checkTransaction(orderId: string): Promise<TransactionResult> {
    const result: CheckTransactionReturns =
      await CheckoutSDK.checkTransaction({ data: { orderId } });

    return { orderId: result.orderId || orderId, resultCode: result.resultCode };
  }
}
