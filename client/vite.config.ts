import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API is the platform Worker under `wrangler dev`, which signs you in from .dev.vars.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
