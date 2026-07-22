#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  applyInstallPlan,
  completeGuidedInstall,
  detectProject,
  planInstall,
  prepareGuidedInstall,
  sidecarManifest,
  verifyInstallation,
  type GuidedInstallPreparation,
  type GuidedInstallResult,
  type InstallPlan,
} from "./installer.js";
import type { CalibrateRoute } from "./route-observer.js";

interface ParsedArguments {
  command: string;
  dir: string;
  plan?: string;
  out?: string;
  url?: string;
  endpoint?: string;
  writeKey?: string;
  routes: CalibrateRoute[];
  yes: boolean;
  install: boolean;
  json: boolean;
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
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dir") parsed.dir = valueAfter(argv, index++, flag);
    else if (flag === "--plan") parsed.plan = valueAfter(argv, index++, flag);
    else if (flag === "--out") parsed.out = valueAfter(argv, index++, flag);
    else if (flag === "--url") parsed.url = valueAfter(argv, index++, flag);
    else if (flag === "--endpoint") parsed.endpoint = valueAfter(argv, index++, flag);
    else if (flag === "--write-key") parsed.writeKey = valueAfter(argv, index++, flag);
    else if (flag === "--route") parsed.routes.push(parseRoute(valueAfter(argv, index++, flag)));
    else if (flag === "--yes" || flag === "-y") parsed.yes = true;
    else if (flag === "--no-install") parsed.install = false;
    else if (flag === "--json") parsed.json = true;
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

function installPreview(preparation: GuidedInstallPreparation): void {
  const plan = preparation.plan;
  process.stdout.write([
    "Calibrate installation plan",
    `Collector: ${preparation.collector.endpoint ?? "unavailable"}`,
    `Dashboard: ${preparation.collector.dashboardUrl ?? "unavailable"}`,
    `Manifest: ${preparation.collector.manifest?.version ?? "unavailable"}`,
    "Routes:",
    ...(plan?.configuration?.routes.map((route) =>
      `  ${route.path} -> ${route.step}${route.shipped === true ? " (shipped)" : ""}`
    ) ?? ["  none"]),
    "File changes:",
    ...(plan?.changes.map((change) => `  ${change.action}: ${change.path}`) ?? ["  none"]),
    `Dependency install: ${plan?.installCommand?.join(" ") ?? "none"}`,
    `Required environment names: ${plan?.requiredEnvironment.join(", ") || "none"}`,
    "Hosting: the SDK is bundled with this application; the collector and its /dashboard route remain hosted at the collector URL.",
    "",
  ].join("\n"));
}

function installText(result: GuidedInstallResult): void {
  const verification = result.status !== "installed"
    ? result.evidence === "none"
      ? "Verification did not run."
      : `${result.evidence === "runtime" ? "Runtime" : "Static"} verification did not complete successfully.`
    : result.evidence === "runtime"
      ? "Runtime verification passed with a synthetic privacy-safe journey."
      : "Static installation verification passed. Runtime verification was skipped because CALIBRATE_WRITE_KEY was not supplied.";
  process.stdout.write([
    `Calibrate install: ${result.status}`,
    `Evidence: ${result.evidence}`,
    result.dashboardUrl === null ? "Dashboard: unavailable" : `Dashboard: ${result.dashboardUrl}`,
    verification,
    `Changed files: ${result.changedFiles.join(", ") || "none"}`,
    ...(result.issues.length === 0 ? [] : ["Issues:", ...result.issues.map((issue) => `  ${issue}`)]),
    "Hosting: the SDK ships with your app. The collector stores the data and serves the dashboard.",
    "",
  ].join("\n"));
}

function help(): void {
  process.stdout.write([
    "Calibrate installer",
    "",
    "calibrate install --url https://collector.example [--route /signup=account] [--route /success=success:shipped] [--yes] [--json]",
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
  if (args.command === "install") {
    if (args.url === undefined) fail("install requires --url");
    const preparation = await prepareGuidedInstall(
      args.dir,
      args.url,
      args.routes.length === 0 ? undefined : args.routes,
    );
    if (preparation.status !== "ready") {
      if (args.json) print(preparation);
      else {
        installPreview(preparation);
        for (const issue of [
          ...preparation.collector.issues,
          ...(preparation.plan?.issues ?? []),
          ...(preparation.plan?.decisions ?? []),
        ]) process.stderr.write(`Blocked: ${issue}\n`);
      }
      process.exitCode = 3;
      return;
    }

    if (!args.json) installPreview(preparation);
    if (!args.yes) {
      if (args.json || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        const blocked = {
          ...preparation,
          status: "blocked",
          changedFiles: [],
          issues: ["noninteractive installation requires --yes after reviewing the plan"],
        };
        if (args.json) print(blocked);
        else process.stderr.write("Blocked: noninteractive installation requires --yes after reviewing the plan.\n");
        process.exitCode = 3;
        return;
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question("Apply this plan? [y/N] ");
      prompt.close();
      if (!/^(?:y|yes)$/i.test(answer.trim())) {
        process.stdout.write("No files changed.\n");
        process.exitCode = 3;
        return;
      }
    }

    const writeKey = args.writeKey ?? process.env.CALIBRATE_WRITE_KEY;
    const result = await completeGuidedInstall(preparation, {
      install: args.install,
      quiet: args.json,
      ...(writeKey === undefined ? {} : { writeKey }),
    });
    if (args.json) print(result);
    else installText(result);
    process.exitCode = result.status === "installed" ? 0 : 4;
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
    const writeKey = args.writeKey ?? process.env.CALIBRATE_WRITE_KEY;
    const result = await verifyInstallation(args.dir, {
      ...(args.endpoint === undefined ? {} : { endpoint: args.endpoint }),
      ...(writeKey === undefined ? {} : { writeKey }),
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
