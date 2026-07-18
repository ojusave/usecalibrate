import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "packages/kit",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
