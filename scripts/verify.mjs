#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(fileURLToPath(import.meta.url), "..", "..");

function run(label, command) {
  console.log(`\n==> ${label}`);
  console.log(`$ ${command}`);
  execSync(command, { cwd: root, stdio: "inherit" });
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".git" ||
      entry === ".loop" ||
      entry === "coverage" ||
      entry === "package-lock.json"
    ) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

function grepForbidden(label, pattern, directory) {
  console.log(`\n==> ${label}`);
  const hits = [];
  for (const file of walk(directory)) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) hits.push(relative(root, file));
    pattern.lastIndex = 0;
  }
  if (hits.length > 0) {
    console.error(`FAIL: found matches in:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  console.log("ok");
}

console.log("calibrate verification");
run("lint", "npm run lint");
run("contract build", "npm run build -w @usecalibrate/contract");
run("typecheck", "npm run typecheck");
run("SDK build", "npm run build -w usecalibrate");
run("test", "npm run test");
grepForbidden(
  "wall: no fakesaaspi under packages/kit",
  /fakesaaspi/i,
  join(root, "packages/kit"),
);
grepForbidden("no em dash or en dash in tracked source", /[\u2013\u2014]/, root);
grepForbidden("no emoji in tracked source", /\p{Extended_Pictographic}/u, root);
const tracker = readFileSync(join(root, "packages/kit/dist/tracker.min.js"));
const gzipBytes = gzipSync(tracker).byteLength;
console.log(
  `\n==> tracker size\n${tracker.byteLength} raw bytes\n${gzipBytes} gzip bytes`,
);
if (gzipBytes >= 10_240) {
  console.error(`FAIL: tracker is ${gzipBytes} bytes gzipped, limit is 10239`);
  process.exit(1);
}

console.log("\nverify: ok");
