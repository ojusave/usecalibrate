#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyInstallPlan,
  detectProject,
  planInstall,
  sidecarManifest,
  verifyInstallation,
  type InstallPlan,
} from "./installer.js";
import type { CalibrateRoute } from "./route-observer.js";

interface ParsedArguments {
  command: string;
  dir: string;
  plan?: string;
  out?: string;
  endpoint?: string;
  writeKey?: string;
  routes: CalibrateRoute[];
  yes: boolean;
  install: boolean;
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${JSON.stringify({ v: 1, status: "error", error: message })}\n`);
  process.exit(code);
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseRoute(value: string): CalibrateRoute {
  const equal = value.indexOf("=");
  if (equal < 1) fail('--route must use "/path=step" or "/path=step:shipped"');
  const path = value.slice(0, equal);
  const right = value.slice(equal + 1);
  const shipped = right.endsWith(":shipped");
  const step = shipped ? right.slice(0, -":shipped".length) : right;
  if (!path.startsWith("/") || step === "") fail("route paths must be absolute and step identifiers must be non-empty");
  return { path, step, ...(shipped ? { shipped: true } : {}) };
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const parsed: ParsedArguments = {
    command,
    dir: ".",
    routes: [],
    yes: false,
    install: true,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dir") parsed.dir = valueAfter(argv, index++, flag);
    else if (flag === "--plan") parsed.plan = valueAfter(argv, index++, flag);
    else if (flag === "--out") parsed.out = valueAfter(argv, index++, flag);
    else if (flag === "--endpoint") parsed.endpoint = valueAfter(argv, index++, flag);
    else if (flag === "--write-key") parsed.writeKey = valueAfter(argv, index++, flag);
    else if (flag === "--route") parsed.routes.push(parseRoute(valueAfter(argv, index++, flag)));
    else if (flag === "--yes" || flag === "-y") parsed.yes = true;
    else if (flag === "--no-install") parsed.install = false;
    else if (flag === "--json") continue;
    else fail(`unknown option ${flag ?? ""}`);
  }
  parsed.dir = resolve(parsed.dir);
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function planSummary(plan: InstallPlan, planFile?: string): unknown {
  return {
    v: plan.v,
    command: plan.command,
    status: plan.status,
    planId: plan.planId,
    targetDir: plan.targetDir,
    ...(planFile === undefined ? {} : { planFile }),
    configuration: plan.configuration,
    changes: plan.changes.map(({ path, action, beforeSha256 }) => ({ path, action, beforeSha256 })),
    installCommand: plan.installCommand,
    requiredEnvironment: plan.requiredEnvironment,
    decisions: plan.decisions,
    issues: plan.issues,
  };
}

function help(): void {
  process.stdout.write([
    "Calibrate agent installer",
    "",
    "calibrate detect --dir . --json",
    "calibrate plan --dir . [--route /signup=account] [--route /success=success:shipped] --out calibrate.plan.json",
    "calibrate apply --plan calibrate.plan.json --yes [--no-install]",
    "calibrate verify --dir . [--endpoint http://localhost:8787 --write-key value] --json",
    "calibrate sidecar --dir .",
    "",
  ].join("\n"));
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    help();
    return;
  }
  if (args.command === "detect") {
    const result = detectProject(args.dir);
    print(result);
    process.exitCode = result.status === "supported" ? 0 : 3;
    return;
  }
  if (args.command === "plan") {
    const result = planInstall(args.dir, {
      ...(args.routes.length === 0 ? {} : { routes: args.routes }),
      ...(args.endpoint === undefined ? {} : { endpoint: args.endpoint }),
    });
    if (args.out === undefined) print(planSummary(result));
    else {
      const planFile = resolve(args.out);
      writeFileSync(planFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      print(planSummary(result, planFile));
    }
    process.exitCode = result.status === "ready" ? 0 : 3;
    return;
  }
  if (args.command === "apply") {
    if (args.plan === undefined) fail("apply requires --plan");
    if (!args.yes) fail("apply requires --yes after the plan has been reviewed");
    const plan = JSON.parse(readFileSync(resolve(args.plan), "utf8")) as InstallPlan;
    const result = applyInstallPlan(plan, { install: args.install });
    print(result);
    process.exitCode = result.status === "applied" ? 0 : 4;
    return;
  }
  if (args.command === "verify") {
    const result = await verifyInstallation(args.dir, {
      ...(args.endpoint === undefined ? {} : { endpoint: args.endpoint }),
      ...(args.writeKey === undefined ? {} : { writeKey: args.writeKey }),
    });
    print(result);
    process.exitCode = result.status === "verified" ? 0 : 4;
    return;
  }
  if (args.command === "sidecar") {
    if (process.env.MANIFEST_JSON === undefined && process.env.MANIFEST_URL === undefined) {
      process.env.MANIFEST_JSON = sidecarManifest(args.dir);
    }
    await import("./sidecar.js");
    return;
  }
  fail(`unknown command ${args.command}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error), 1);
});
