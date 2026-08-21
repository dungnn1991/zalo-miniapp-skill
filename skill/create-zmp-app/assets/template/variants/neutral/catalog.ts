// Catalog data — "neutral" variant (generic demo store).
// Bootstrap copies variants/<variant>/catalog.ts over src/data/catalog.ts.
// Every variant must keep this exact shape; src/data/catalog.ts defaults to
// the neutral variant. navItems keys must stay "home", "cart" and "account" —
// the app shell binds tab behaviour to those keys.

export interface CatalogCategory {
  id: string;
  label: string;
}

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  category: string;
  /** Emoji shown on the self-contained product tile (no external images). */
  emoji: string;
  /** Background color of the product tile. */
  accent: string;
}

export interface CatalogNavItem {
  key: string;
  label: string;
  icon: "home" | "cart" | "account";
}

export interface Catalog {
  appTitle: string;
  heroTagline: string;
  /** BCP 47 locale used to format prices. */
  locale: string;
  /** ISO 4217 currency code used to format prices. */
  currency: string;
  allCategoryLabel: string;
  addToCartLabel: string;
  cartTitle: string;
  cartEmptyText: string;
  cartTotalLabel: string;
  categories: CatalogCategory[];
  products: CatalogProduct[];
  navItems: CatalogNavItem[];
}

export const catalog: Catalog = {
  appTitle: "Demo Store",
  heroTagline: "Everyday essentials, picked for you",
  locale: "en-US",
  currency: "USD",
  allCategoryLabel: "All",
  addToCartLabel: "Add to cart",
  cartTitle: "Your cart",
  cartEmptyText: "Your cart is empty. Add something you like!",
  cartTotalLabel: "Subtotal",
  categories: [
    { id: "home", label: "Home" },
    { id: "office", label: "Office" },
    { id: "outdoor", label: "Outdoor" },
    { id: "gadgets", label: "Gadgets" },
  ],
  products: [
    { id: "ceramic-mug", name: "Ceramic mug", price: 8.5, category: "home", emoji: "☕", accent: "#fef3c7" },
    { id: "desk-lamp", name: "Compact desk lamp", price: 24, category: "home", emoji: "💡", accent: "#fde8e8" },
    { id: "potted-plant", name: "Potted mini plant", price: 18, category: "home", emoji: "🪴", accent: "#d1fae5" },
    { id: "dot-grid-notebook", name: "Dot-grid notebook", price: 6, category: "office", emoji: "📓", accent: "#dbeafe" },
    { id: "sticky-notes", name: "Sticky notes set", price: 3.5, category: "office", emoji: "🗒️", accent: "#fce7f3" },
    { id: "daypack-backpack", name: "Daypack backpack", price: 39, category: "outdoor", emoji: "🎒", accent: "#ede9fe" },
    { id: "picnic-basket", name: "Picnic basket", price: 22, category: "outdoor", emoji: "🧺", accent: "#fef3c7" },
    { id: "over-ear-headphones", name: "Over-ear headphones", price: 59, category: "gadgets", emoji: "🎧", accent: "#e0f2fe" },
    { id: "wireless-mouse", name: "Wireless mouse", price: 15.5, category: "gadgets", emoji: "🖱️", accent: "#f3f4f6" },
    { id: "bluetooth-speaker", name: "Bluetooth speaker", price: 45, category: "gadgets", emoji: "🔊", accent: "#dbeafe" },
  ],
  navItems: [
    { key: "home", label: "Home", icon: "home" },
    { key: "cart", label: "Cart", icon: "cart" },
    { key: "account", label: "Tài khoản", icon: "account" },
  ],
};
