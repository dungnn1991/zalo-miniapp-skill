/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHECKOUT_ENABLED?: string;
  readonly VITE_CHECKOUT_MODE?: "simulator" | "demo-cod";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
