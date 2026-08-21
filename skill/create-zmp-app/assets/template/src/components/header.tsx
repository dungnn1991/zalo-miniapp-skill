import { catalog } from "../data/catalog";
import { CartIcon } from "./icons";

interface HeaderProps {
  cartCount: number;
}

export default function Header({ cartCount }: HeaderProps) {
  return (
    <header className="app-header" data-testid="app-header">
      <div className="app-header-inner">
        <div>
          <h1 className="app-title">{catalog.appTitle}</h1>
          <p className="app-tagline">{catalog.heroTagline}</p>
        </div>
        <div className="cart-indicator">
          <CartIcon size={20} />
          <span className="cart-badge" data-testid="cart-badge">
            {cartCount}
          </span>
        </div>
      </div>
    </header>
  );
}
