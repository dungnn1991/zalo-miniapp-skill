import { catalog } from "../data/catalog";
import type { MerchantOrderItem } from "./types";

export interface DemoCodCartItem extends MerchantOrderItem {
  name: string;
  unitPrice: number;
  emoji: string;
  accent: string;
}

export function cartToMerchantOrderItems(
  cart: Record<string, number>,
): MerchantOrderItem[] {
  return catalog.products.flatMap((product) => {
    const quantity = cart[product.id] ?? 0;
    return Number.isInteger(quantity) && quantity > 0
      ? [{ productId: product.id, quantity }]
      : [];
  });
}

export function cartToDemoCodItems(
  cart: Record<string, number>,
): DemoCodCartItem[] {
  return catalog.products.flatMap((product) => {
    const quantity = cart[product.id] ?? 0;
    return Number.isInteger(quantity) && quantity > 0
      ? [{
          productId: product.id,
          name: product.name,
          unitPrice: product.price,
          quantity,
          emoji: product.emoji,
          accent: product.accent,
        }]
      : [];
  });
}
