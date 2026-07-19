#!/usr/bin/env node

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

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

const gzipBytes = gzipSync(await readFile(join(dist, "tracker.min.js"))).byteLength;
if (gzipBytes >= 10_240) {
  throw new Error(
    `tracker is ${gzipBytes} bytes gzipped, limit is 10239`,
  );
}
