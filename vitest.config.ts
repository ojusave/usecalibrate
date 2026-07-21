import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/{contract,browser,collector,kit}/test/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [["packages/browser/**", "happy-dom"]],
  },
});
