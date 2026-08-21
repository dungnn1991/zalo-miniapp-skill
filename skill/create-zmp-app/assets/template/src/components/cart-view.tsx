import { catalog } from "../data/catalog";
import { formatPrice } from "../utils/format";

interface CartViewProps {
  cart: Record<string, number>;
}

export default function CartView({ cart }: CartViewProps) {
  const lines = catalog.products
    .filter((product) => (cart[product.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: cart[product.id] ?? 0 }));
  const total = lines.reduce(
    (sum, line) => sum + line.product.price * line.quantity,
    0,
  );

  return (
    <section className="cart-view">
      <h2 className="cart-title">{catalog.cartTitle}</h2>
      {lines.length === 0 ? (
        <p className="cart-empty">{catalog.cartEmptyText}</p>
      ) : (
        <>
          <ul className="cart-lines">
            {lines.map(({ product, quantity }) => (
              <li key={product.id} className="cart-line">
                <span
                  className="cart-line-thumb"
                  style={{ backgroundColor: product.accent }}
                  aria-hidden="true"
                >
                  {product.emoji}
                </span>
                <span className="cart-line-info">
                  <span className="cart-line-name">{product.name}</span>
                  <span className="cart-line-qty">×{quantity}</span>
                </span>
                <span className="cart-line-subtotal">
                  {formatPrice(product.price * quantity)}
                </span>
              </li>
            ))}
          </ul>
          <p className="cart-total">
            <span>{catalog.cartTotalLabel}</span>
            <strong>{formatPrice(total)}</strong>
          </p>
        </>
      )}
    </section>
  );
}
