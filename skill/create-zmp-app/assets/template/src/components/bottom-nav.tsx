import { catalog } from "../data/catalog";
import { NavIcon } from "./icons";

// Own markup instead of zmp-ui's BottomNavigation: its Item component drops
// data-* props, and the simulator demo contract requires data-testid on nav
// items (nav-account). Styles in app.css mirror the zaui bottom nav look.

interface BottomNavProps {
  activeKey: string;
  onChange: (key: string) => void;
}

export default function BottomNav({ activeKey, onChange }: BottomNavProps) {
  return (
    <nav className="bottom-nav" data-testid="bottom-nav">
      {catalog.navItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={
            item.key === activeKey
              ? "bottom-nav-item bottom-nav-item-active"
              : "bottom-nav-item"
          }
          data-testid={`nav-${item.key}`}
          onClick={() => onChange(item.key)}
        >
          <NavIcon name={item.icon} />
          <span className="bottom-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
