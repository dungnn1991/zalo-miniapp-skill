import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import zaloMiniApp from "zmp-vite-plugin";

// zaloMiniApp() reads ./app-config.json at build time and defaults the output
// directory to "www"; the lab pipeline serves dist/, so pin outDir explicitly.
export default defineConfig({
  plugins: [zaloMiniApp(), react()],
  build: {
    outDir: "dist",
  },
});
