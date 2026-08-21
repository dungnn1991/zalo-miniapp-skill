// Catalog data — "clothing-store" variant (shop quần áo, tiếng Việt).
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
  appTitle: "Shop Quần Áo",
  heroTagline: "Thời trang mỗi ngày, giá hợp lý",
  locale: "vi-VN",
  currency: "VND",
  allCategoryLabel: "Tất cả",
  addToCartLabel: "Thêm vào giỏ",
  cartTitle: "Giỏ hàng của bạn",
  cartEmptyText: "Giỏ hàng đang trống. Thêm sản phẩm bạn thích nhé!",
  cartTotalLabel: "Tạm tính",
  categories: [
    { id: "ao", label: "Áo" },
    { id: "quan", label: "Quần" },
    { id: "vay-dam", label: "Váy đầm" },
    { id: "phu-kien", label: "Phụ kiện" },
  ],
  products: [
    { id: "ao-thun-cotton", name: "Áo thun cotton trơn", price: 129000, category: "ao", emoji: "👕", accent: "#dbeafe" },
    { id: "ao-so-mi", name: "Áo sơ mi tay dài", price: 259000, category: "ao", emoji: "👔", accent: "#e0f2fe" },
    { id: "ao-khoac-gio", name: "Áo khoác gió nhẹ", price: 329000, category: "ao", emoji: "🧥", accent: "#ede9fe" },
    { id: "quan-jean-slim", name: "Quần jean slim-fit", price: 349000, category: "quan", emoji: "👖", accent: "#dbeafe" },
    { id: "quan-short-kaki", name: "Quần short kaki", price: 199000, category: "quan", emoji: "🩳", accent: "#fef3c7" },
    { id: "vay-hoa-mua-he", name: "Váy hoa mùa hè", price: 289000, category: "vay-dam", emoji: "👗", accent: "#fce7f3" },
    { id: "dam-maxi-dao-pho", name: "Đầm maxi dạo phố", price: 399000, category: "vay-dam", emoji: "👗", accent: "#fde8e8" },
    { id: "tui-tote-canvas", name: "Túi tote canvas", price: 149000, category: "phu-kien", emoji: "👜", accent: "#d1fae5" },
    { id: "mu-luoi-trai", name: "Mũ lưỡi trai", price: 99000, category: "phu-kien", emoji: "🧢", accent: "#dbeafe" },
    { id: "kinh-ram", name: "Kính râm thời trang", price: 159000, category: "phu-kien", emoji: "🕶️", accent: "#f3f4f6" },
  ],
  navItems: [
    { key: "home", label: "Trang chủ", icon: "home" },
    { key: "cart", label: "Giỏ hàng", icon: "cart" },
    { key: "account", label: "Tài khoản", icon: "account" },
  ],
};
