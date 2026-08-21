import { useMemo, useState } from "react";
import { App } from "zmp-ui";
import AccountView from "./components/account-view";
import BottomNav from "./components/bottom-nav";
import CartView from "./components/cart-view";
import CategoryFilter from "./components/category-filter";
import Header from "./components/header";
import ProductGrid from "./components/product-grid";
import { catalog } from "./data/catalog";

const ALL_CATEGORY = "all";

export default function StoreApp() {
  // Tab keys are bound to catalog.navItems keys: "home", "cart" and "account".
  const [activeTab, setActiveTab] = useState<string>("home");
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CATEGORY);
  const [cart, setCart] = useState<Record<string, number>>({});

  const cartCount = useMemo(
    () => Object.values(cart).reduce((sum, quantity) => sum + quantity, 0),
    [cart],
  );

  const visibleProducts = useMemo(
    () =>
      activeCategory === ALL_CATEGORY
        ? catalog.products
        : catalog.products.filter((product) => product.category === activeCategory),
    [activeCategory],
  );

  const addToCart = (productId: string) => {
    setCart((current) => ({
      ...current,
      [productId]: (current[productId] ?? 0) + 1,
    }));
  };

  return (
    <App>
      <div className="app-shell" data-testid="app-root">
        <Header cartCount={cartCount} />
        <main className="app-main">
          {activeTab === "cart" ? (
            <CartView cart={cart} />
          ) : activeTab === "account" ? (
            <AccountView />
          ) : (
            <>
              <CategoryFilter
                activeCategory={activeCategory}
                allCategoryId={ALL_CATEGORY}
                onSelect={setActiveCategory}
              />
              <ProductGrid products={visibleProducts} onAddToCart={addToCart} />
            </>
          )}
        </main>
        <BottomNav activeKey={activeTab} onChange={setActiveTab} />
      </div>
    </App>
  );
}
