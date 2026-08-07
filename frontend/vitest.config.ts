import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // Next.js resolves `server-only` through a built-in alias, so it is not a
      // real dependency and vitest cannot find it. It is a compile-time marker
      // with no runtime behaviour; an empty module is a faithful stand-in and
      // keeps the guard in the source rather than deleting it to suit the tests.
      "server-only": path.resolve(__dirname, "./test/server-only-stub.ts"),
    },
  },
});
