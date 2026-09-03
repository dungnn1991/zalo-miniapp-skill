export interface MerchantOrderItem {
  productId: string;
  quantity: number;
}

export interface CheckoutCreateOrderInput {
  amount: string | number;
  item: Record<string, unknown>[];
  desc: string;
  mac: string;
  extradata?: unknown;
  payload?: unknown;
  method?: string | { id: string; isCustom: boolean };
}

export interface MerchantOrder {
  merchantOrderId: string;
  createOrderInput: CheckoutCreateOrderInput;
}

export interface PaymentDonePayload {
  orderId: string;
}

export interface TransactionResult {
  orderId: string;
  resultCode: number;
}

export type CheckoutResult = "success" | "pending" | "failed" | "cancelled";

export type CheckoutState =
  | { status: "idle" }
  | { status: "creating-order" }
  | { status: "opening-checkout" }
  | { status: "awaiting-payment"; orderId: string }
  | { status: "checking-transaction"; orderId: string }
  | { status: "complete"; orderId: string; result: CheckoutResult }
  | { status: "error"; message: string };
