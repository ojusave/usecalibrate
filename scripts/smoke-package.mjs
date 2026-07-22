#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "calibrate-package-"));
const consumer = join(temporary, "consumer");
let tarball;
let sidecarProcess;

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

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a package-smoke port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("package-smoke sidecar did not become healthy");
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
    "dashboard/dashboard.js",
    "dashboard/index.html",
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

  const guidedFixture = join(consumer, "guided-fixture");
  mkdirSync(join(guidedFixture, "src"), { recursive: true });
  writeFileSync(
    join(guidedFixture, "package.json"),
    JSON.stringify({
      name: "calibrate-guided-fixture",
      private: true,
      type: "module",
      dependencies: { react: "latest" },
      devDependencies: { vite: "latest" },
    }),
  );
  writeFileSync(join(guidedFixture, "package-lock.json"), "{}\n");
  writeFileSync(
    join(guidedFixture, "src/main.ts"),
    [
      "export const routes = [",
      '  { path: "/signup" },',
      '  { path: "/projects/new" },',
      '  { path: "/success" },',
      "];",
      "",
    ].join("\n"),
  );
  const port = await availablePort();
  const collectorUrl = `http://127.0.0.1:${port}`;
  const writeKey = "package-smoke-write-key";
  sidecarProcess = spawn(join(consumer, "node_modules/.bin/calibrate-sidecar"), [], {
    cwd: guidedFixture,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TOKEN: "package-smoke-admin",
      DASHBOARD_TOKEN: "package-smoke-dashboard",
      WRITE_KEY: writeKey,
      MANIFEST_JSON: JSON.stringify({
        version: "guided-smoke-v1",
        groups: ["onboarding"],
        steps: [
          { id: "signup", group: "onboarding" },
          { id: "new", group: "onboarding" },
          { id: "success", group: "onboarding" },
        ],
      }),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth(collectorUrl);

  const unapproved = spawnSync(calibrateBin, [
    "install",
    "--dir",
    guidedFixture,
    "--url",
    collectorUrl,
    "--json",
    "--no-install",
  ], { cwd: guidedFixture, encoding: "utf8" });
  assert(unapproved.status === 3, "noninteractive guided install did not require --yes");
  const unapprovedResult = JSON.parse(unapproved.stdout);
  assert(unapprovedResult.plan?.changes?.every((change) => typeof change.content === "string"), "unapproved guided install did not return reviewable generated contents");
  assert(!existsSync(join(guidedFixture, "calibrate.install.json")), "unapproved guided install changed project files");

  const guidedOutput = run(calibrateBin, [
    "install",
    "--dir",
    guidedFixture,
    "--url",
    collectorUrl,
    "--yes",
    "--json",
    "--no-install",
  ], {
    cwd: guidedFixture,
    env: { ...process.env, CALIBRATE_WRITE_KEY: writeKey },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const guidedResult = JSON.parse(guidedOutput);
  assert(guidedResult.status === "installed", "guided installer did not report installed");
  assert(guidedResult.evidence === "runtime", "guided installer did not perform runtime verification");
  assert(guidedResult.dashboardUrl === `${collectorUrl}/dashboard`, "guided installer returned the wrong dashboard URL");
  assert(!guidedOutput.includes(writeKey), "guided installer printed the write key");
  for (const file of guidedResult.changedFiles) {
    assert(!readFileSync(join(guidedFixture, file), "utf8").includes(writeKey), `guided installer persisted the write key in ${file}`);
  }

  const verifyOutput = run(calibrateBin, [
    "verify",
    "--dir",
    guidedFixture,
    "--endpoint",
    collectorUrl,
    "--json",
  ], {
    cwd: guidedFixture,
    env: { ...process.env, CALIBRATE_WRITE_KEY: writeKey },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const verifyResult = JSON.parse(verifyOutput);
  assert(verifyResult.status === "verified", "standalone verification did not report verified");
  assert(verifyResult.evidence === "runtime", "standalone verification did not read CALIBRATE_WRITE_KEY from the environment");
  assert(!verifyOutput.includes(writeKey), "standalone verification printed the write key");

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
  if (sidecarProcess !== undefined) sidecarProcess.kill("SIGTERM");
  if (tarball) rmSync(tarball, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
