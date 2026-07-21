import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { FIRSTMILE_VERSION } from "../src/version.js";

describe("scaffold", () => {
  it("exports a semver-shaped version string", () => {
    expect(FIRSTMILE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships explicit Apache-2.0 package licensing", () => {
    const packageRoot = new URL("../", import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(new URL("package.json", packageRoot), "utf8"),
    ) as { license?: string; files?: string[] };

    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.files).toContain("LICENSE");
    expect(readFileSync(new URL("LICENSE", packageRoot), "utf8")).toContain(
      "Apache License",
    );
  });

  it("pins the Appendix A root toolchain", () => {
    const root = new URL("../../../", import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(new URL("package.json", root), "utf8"),
    ) as {
      name: string;
      engines: { node: string };
      scripts: Record<string, string>;
    };
    // Shared toolchain pins that hold wherever the kit is vendored.
    expect(packageJson.engines.node).toBe(">=20");
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts.lint).toBe("eslint .");
    expect(readFileSync(new URL(".nvmrc", root), "utf8")).toBe("20\n");
    // The workshop scaffold additionally pins the kit build + verify harness.
    // An upstream product root may carry its own toolchain, so only assert
    // these when the workshop harness (scripts.verify) is present.
    if (packageJson.name === "firstmile") {
      expect(packageJson.scripts.build).toBe(
        "npm run build --workspaces --if-present",
      );
      expect(packageJson.scripts.typecheck).toBe("tsc --noEmit -p packages/kit");
      expect(packageJson.scripts["smoke:package"]).toBe(
        "node scripts/smoke-package.mjs",
      );
      expect(packageJson.scripts.verify).toBe("node scripts/verify.mjs");
      expect(existsSync(new URL("LICENSE", root))).toBe(false);
      expect(readFileSync(new URL("README.md", root), "utf8")).toContain(
        "License: to be decided before public release.",
      );
    }
  });

  it("pins both tracker output formats", () => {
    const script = readFileSync(
      new URL("../../../scripts/build-tracker.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain('target: "es2018"');
    expect(script).toContain('format: "iife"');
    expect(script).toContain('globalName: "firstmile"');
    expect(script).toContain('outfile: join(dist, "tracker.min.js")');
    expect(script).toContain('format: "esm"');
    expect(script).toContain('outfile: join(dist, "tracker.mjs")');
  });
});
