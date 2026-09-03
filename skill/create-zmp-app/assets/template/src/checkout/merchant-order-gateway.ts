import type {
  CheckoutCreateOrderInput,
  MerchantOrder,
  MerchantOrderItem,
} from "./types";

export interface CreateMerchantOrderRequest {
  items: MerchantOrderItem[];
  idempotencyKey: string;
}

export interface MerchantOrderGateway {
  createOrder(request: CreateMerchantOrderRequest): Promise<MerchantOrder>;
}

interface MerchantOrderApiResponse {
  merchantOrderId?: unknown;
  createOrderInput?: unknown;
}

function isCreateOrderInput(value: unknown): value is CheckoutCreateOrderInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    (typeof input.amount === "string" || typeof input.amount === "number") &&
    Array.isArray(input.item) &&
    typeof input.desc === "string" &&
    typeof input.mac === "string" &&
    input.mac.length > 0
  );
}

function parseMerchantOrder(value: unknown): MerchantOrder {
  if (!value || typeof value !== "object") {
    throw new Error("Merchant Order API trả dữ liệu không hợp lệ.");
  }

  const response = value as MerchantOrderApiResponse;
  if (
    typeof response.merchantOrderId !== "string" ||
    !isCreateOrderInput(response.createOrderInput)
  ) {
    throw new Error("Merchant Order API thiếu merchantOrderId hoặc createOrderInput.");
  }

  return {
    merchantOrderId: response.merchantOrderId,
    createOrderInput: response.createOrderInput,
  };
}

export class HttpMerchantOrderGateway implements MerchantOrderGateway {
  constructor(private readonly endpoint = "/api/merchant-orders") {}

  async createOrder(request: CreateMerchantOrderRequest): Promise<MerchantOrder> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: request.items,
        idempotencyKey: request.idempotencyKey,
      }),
    });

    if (!response.ok) {
      throw new Error(`Merchant Order API lỗi (${response.status}).`);
    }

    return parseMerchantOrder(await response.json());
  }
}
