#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "calibrate-package-"));
const consumer = join(temporary, "consumer");
let tarball;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  run("npm", ["run", "build", "--workspace", "usecalibrate"]);

  const packOutput = run(
    "npm",
    [
      "pack",
      "--workspace",
      "usecalibrate",
      "--pack-destination",
      temporary,
      "--json",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const [pack] = JSON.parse(packOutput);
  assert(pack?.filename, "npm pack did not report a tarball");
  tarball = join(temporary, basename(pack.filename));

  const packageJson = JSON.parse(
    readFileSync(join(root, "packages/kit/package.json"), "utf8"),
  );
  const packedFiles = new Set(pack.files.map((file) => file.path));
  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    assert(target.import, `${subpath} is missing an ESM import export`);
    assert(target.types, `${subpath} is missing a types export`);
    assert(
      packedFiles.has(target.import.replace(/^\.\//, "")),
      `${subpath} import is absent from the tarball`,
    );
    assert(
      packedFiles.has(target.types.replace(/^\.\//, "")),
      `${subpath} types are absent from the tarball`,
    );
  }
  for (const [name, target] of Object.entries(packageJson.bin)) {
    assert(
      packedFiles.has(target.replace(/^\.\//, "")),
      `${name} executable is absent from the tarball`,
    );
  }
  for (const required of [
    "README.md",
    "present/index.html",
    "skills/install-calibrate/SKILL.md",
    "skills/install-calibrate/agents/openai.yaml",
    "skills/install-calibrate/references/cli.md",
  ]) {
    assert(packedFiles.has(required), `${required} is absent from the tarball`);
  }

  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "calibrate-package-smoke", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: consumer },
  );

  const agentFixture = join(consumer, "agent-fixture");
  mkdirSync(join(agentFixture, "src"), { recursive: true });
  writeFileSync(
    join(agentFixture, "package.json"),
    JSON.stringify({
      name: "calibrate-agent-fixture",
      private: true,
      type: "module",
      dependencies: { react: "latest" },
      devDependencies: { vite: "latest" },
    }),
  );
  writeFileSync(join(agentFixture, "package-lock.json"), "{}\n");
  writeFileSync(
    join(agentFixture, "src/main.ts"),
    [
      "export const routes = [",
      '  { path: "/signup" },',
      '  { path: "/projects/new" },',
      '  { path: "/success" },',
      "];",
      "",
    ].join("\n"),
  );
  const calibrateBin = join(consumer, "node_modules/.bin/calibrate");
  const planFile = join(agentFixture, "calibrate.plan.json");
  run(calibrateBin, ["detect", "--dir", agentFixture, "--json"], { cwd: agentFixture });
  run(calibrateBin, ["plan", "--dir", agentFixture, "--out", planFile], { cwd: agentFixture });
  run(calibrateBin, ["apply", "--plan", planFile, "--yes", "--no-install"], { cwd: agentFixture });
  run(calibrateBin, ["verify", "--dir", agentFixture, "--json"], { cwd: agentFixture });
  assert(existsSync(join(agentFixture, "calibrate.install.json")), "agent installer did not create its installation record");
  assert(readFileSync(join(agentFixture, "src/main.ts"), "utf8").includes("Calibrate instrumentation"), "agent installer did not connect the host entry point");

  const browserFixture = join(consumer, "browser-fixture.ts");
  const browserBundle = join(consumer, "browser-bundle.js");
  writeFileSync(
    browserFixture,
    [
      'import { defineManifest, calibrate } from "usecalibrate";',
      "",
      "const manifest = defineManifest({",
      '  version: "smoke-v1",',
      '  groups: ["start"],',
      '  steps: [{ id: "welcome", group: "start" }],',
      "});",
      'const client = calibrate({ manifest, writeKey: "smoke-write-key" });',
      'client.view("welcome");',
      "client.destroy();",
      "",
    ].join("\n"),
  );
  const bundle = await build({
    entryPoints: [browserFixture],
    outfile: browserBundle,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true,
    logLevel: "silent",
  });
  const forbidden = /(?:^|[/\\])node:fs|@hono[/\\]node-server|(?:^|[/\\])hono(?:[/\\]|$)/;
  const bundledInputs = Object.keys(bundle.metafile.inputs);
  assert(
    !bundledInputs.some((input) => forbidden.test(input)),
    `browser bundle contains a server dependency: ${bundledInputs.join(", ")}`,
  );
  assert(
    !/node:fs|@hono\/node-server/.test(readFileSync(browserBundle, "utf8")),
    "browser bundle contains a forbidden server import",
  );

  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      browserFixture,
    ],
    { cwd: consumer },
  );

  const serverFixture = join(consumer, "server-fixture.mjs");
  writeFileSync(
    serverFixture,
    [
      'import { createCalibrate } from "usecalibrate/server";',
      "",
      "const server = createCalibrate({",
      '  adminToken: "smoke-token",',
      '  dashboardToken: "smoke-dashboard-token",',
      '  writeKey: "smoke-write-key",',
      "  manifest: {",
      '    version: "smoke-v1",',
      '    groups: ["start"],',
      '    steps: [{ id: "welcome", group: "start" }],',
      "  },",
      "});",
      'const response = await server.routes.request("http://localhost/healthz");',
      "if (response.status !== 200 || !(await response.json()).ok) {",
      '  throw new Error("server health check failed");',
      "}",
      "",
    ].join("\n"),
  );
  run(process.execPath, [serverFixture], { cwd: consumer });

  console.log(
    `package smoke: ok (${pack.files.length} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes)`,
  );
} finally {
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
