import { catalog } from "../data/catalog";

const priceFormatter = new Intl.NumberFormat(catalog.locale, {
  style: "currency",
  currency: catalog.currency,
});

export const formatPrice = (value: number): string => priceFormatter.format(value);
