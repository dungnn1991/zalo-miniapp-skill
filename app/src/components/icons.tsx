// Self-contained inline SVG icons. zmp-ui's Icon component renders glyphs from
// an icon font fetched from h5.zadn.vn; this POC must not make external network
// requests at runtime, so navigation/header icons are drawn locally instead.

interface IconProps {
  size?: number;
}

export function HomeIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CartIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 4h2.2l.9 2m0 0 1.3 7.6a1 1 0 0 0 1 .9h8.6a1 1 0 0 0 .95-.7L20 7H6.1Zm2.3 10.5-1 3h13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="20.4" r="1.4" fill="currentColor" />
      <circle cx="16.5" cy="20.4" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function AccountIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      <path
        d="M4.6 20.1c.9-3.4 3.9-5.6 7.4-5.6s6.5 2.2 7.4 5.6a.95.95 0 0 1-.93 1.2H5.53a.95.95 0 0 1-.93-1.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function NavIcon({ name }: { name: "home" | "cart" | "account" }) {
  if (name === "cart") return <CartIcon />;
  if (name === "account") return <AccountIcon />;
  return <HomeIcon />;
}
