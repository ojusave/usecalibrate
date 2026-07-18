#!/usr/bin/env node

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages/kit/src/tracker.ts");
const dist = join(root, "packages/kit/dist");
const shared = {
  entryPoints: [entry],
  bundle: true,
  minify: true,
  platform: "browser",
  target: "es2018",
  legalComments: "none",
};

await Promise.all([
  build({
    ...shared,
    format: "iife",
    globalName: "firstmile",
    outfile: join(dist, "tracker.min.js"),
  }),
  build({
    ...shared,
    format: "esm",
    outfile: join(dist, "tracker.mjs"),
  }),
]);
