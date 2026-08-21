import { Button } from "zmp-ui";
import { catalog, type CatalogProduct } from "../data/catalog";
import { formatPrice } from "../utils/format";

interface ProductGridProps {
  products: CatalogProduct[];
  onAddToCart: (productId: string) => void;
}

export default function ProductGrid({ products, onAddToCart }: ProductGridProps) {
  return (
    <section className="product-grid" data-testid="product-grid">
      {products.map((product) => (
        <article key={product.id} className="product-card" data-testid="product-card">
          <div
            className="product-thumb"
            style={{ backgroundColor: product.accent }}
            aria-hidden="true"
          >
            {product.emoji}
          </div>
          <div className="product-body">
            <h2 className="product-name">{product.name}</h2>
            <p className="product-price">{formatPrice(product.price)}</p>
            <Button
              size="small"
              fullWidth
              data-testid="add-to-cart"
              onClick={() => onAddToCart(product.id)}
            >
              {catalog.addToCartLabel}
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
