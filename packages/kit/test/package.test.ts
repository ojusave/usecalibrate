import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve("packages/kit");
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as {
  name: string;
  type: string;
  sideEffects: boolean;
  main: string;
  types: string;
  exports: Record<string, { types: string; import: string }>;
  bin: Record<string, string>;
};

function collectGraph(entry: string): string[] {
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(
      /(?:from\s*|import\s*)["'](\.[^"']+)["']/g,
    );
    for (const match of imports) {
      const specifier = match[1];
      if (specifier !== undefined) {
        const imported = resolve(dirname(file), specifier);
        visit(
          existsSync(imported)
            ? imported
            : imported.replace(/\.js$/, ".ts"),
        );
      }
    }
  };
  visit(entry);
  return [...visited];
}

describe("package contract", () => {
  it("publishes an ESM-only browser default with explicit subpaths", () => {
    expect(packageJson).toMatchObject({
      name: "@firstmile/sdk",
      type: "module",
      sideEffects: false,
      main: "./dist/browser.js",
      types: "./dist/browser.d.ts",
      bin: { "firstmile-sidecar": "./dist/sidecar.js" },
    });
    expect(Object.keys(packageJson.exports)).toEqual([
      ".",
      "./browser",
      "./server",
      "./manifest",
      "./reducer",
      "./snapshot",
      "./tracker",
      "./version",
    ]);
    for (const target of Object.values(packageJson.exports)) {
      expect(Object.keys(target).sort()).toEqual(["import", "types"]);
      expect(target.import).toMatch(/^\.\/dist\/.+\.(?:js|mjs)$/);
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
    }
  });

  it("keeps source and compiled browser graphs free of Node dependencies", () => {
    const forbidden = /(?:node:|@hono\/node-server|from ["']hono["'])/;
    for (const entry of [
      join(packageRoot, "src/browser.ts"),
      join(packageRoot, "dist/browser.js"),
    ]) {
      expect(existsSync(entry), `${entry} must be generated`).toBe(true);
      const graph = collectGraph(entry);
      expect(graph.map((file) => file.replace(`${packageRoot}/`, ""))).not.toContain(
        "dist/server.js",
      );
      for (const file of graph) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
      }
    }
  });
});
