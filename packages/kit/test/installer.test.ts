import { createCalibrate } from "../src/server.js";
import {
  applyInstallPlan,
  detectProject,
  planInstall,
  verifyInstallation,
} from "../src/installer.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

function temporaryApp(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `calibrate-${name}-`));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "src"));
  return directory;
}

function writeReactViteApp(directory: string): void {
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    type: "module",
    dependencies: { react: "latest" },
    devDependencies: { vite: "latest" },
  }, null, 2));
  writeFileSync(join(directory, "package-lock.json"), "{}\n");
  writeFileSync(join(directory, "src/main.ts"), [
    "export const routes = [",
    '  { path: "/signup" },',
    '  { path: "/projects/new" },',
    '  { path: "/success" },',
    "];",
    "",
  ].join("\n"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent installer", () => {
  it("detects, plans, applies, and statically verifies a React/Vite app", async () => {
    const directory = temporaryApp("vite");
    writeReactViteApp(directory);

    const detection = detectProject(directory);
    expect(detection).toMatchObject({
      status: "supported",
      projectKind: "react-vite",
      entryFile: "src/main.ts",
    });
    expect(detection.routeCandidates.map((route) => route.path)).toEqual([
      "/signup",
      "/projects/new",
      "/success",
    ]);
    expect(detection.routeCandidates.at(-1)).toMatchObject({ shipped: true });

    const plan = planInstall(directory);
    expect(plan.status).toBe("ready");
    expect(plan.configuration?.manifest.steps.map((step) => step.id)).toEqual([
      "signup",
      "new",
      "success",
    ]);
    const applied = applyInstallPlan(plan);
    expect(applied.status).toBe("applied");
    expect(applied.changedFiles).toEqual(expect.arrayContaining([
      "package.json",
      "calibrate.install.json",
      "src/calibrate.ts",
      "src/main.ts",
    ]));
    expect(readFileSync(join(directory, "src/main.ts"), "utf8").match(/Calibrate instrumentation/g)).toHaveLength(1);

    const verification = await verifyInstallation(directory);
    expect(verification).toMatchObject({ status: "verified", evidence: "artifact" });
    expect(verification.checks.every((check) => check.ok)).toBe(true);

    const secondPlan = planInstall(directory);
    const secondApply = applyInstallPlan(secondPlan);
    expect(secondApply.status).toBe("applied");
    expect(secondApply.changedFiles).toEqual([]);
    expect(readFileSync(join(directory, "src/main.ts"), "utf8").match(/Calibrate instrumentation/g)).toHaveLength(1);
  });

  it("requires route semantics instead of inventing an onboarding flow", () => {
    const directory = temporaryApp("routes");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeFileSync(join(directory, "src/main.js"), "console.log('ready');\n");

    expect(detectProject(directory).status).toBe("needs_human_judgment");
    expect(planInstall(directory)).toMatchObject({
      status: "needs_human_judgment",
      configuration: null,
      decisions: [expect.stringContaining("fixed onboarding routes")],
    });

    const explicit = planInstall(directory, {
      routes: [
        { path: "/start", step: "start" },
        { path: "/done", step: "done", shipped: true },
      ],
    });
    expect(explicit.status).toBe("ready");
  });

  it("returns a blocked plan for unsupported Next.js projects", () => {
    const directory = temporaryApp("next");
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name: "fixture",
      type: "module",
      dependencies: { next: "latest", react: "latest" },
    }));
    writeFileSync(join(directory, "src/main.ts"), 'const path = "/start";\n');

    expect(planInstall(directory, {
      routes: [
        { path: "/start", step: "start" },
        { path: "/done", step: "done", shipped: true },
      ],
    })).toMatchObject({
      status: "blocked",
      configuration: null,
      issues: [expect.stringContaining("Next.js")],
    });
  });

  it("blocks a stale plan instead of overwriting later edits", () => {
    const directory = temporaryApp("conflict");
    writeReactViteApp(directory);
    const plan = planInstall(directory);
    writeFileSync(join(directory, "src/main.ts"), "// user changed this after planning\n");

    expect(applyInstallPlan(plan)).toMatchObject({
      status: "blocked",
      changedFiles: [],
      issues: [expect.stringContaining("src/main.ts")],
    });
  });

  it("rejects tampered plans and paths outside the target", () => {
    const directory = temporaryApp("tampered");
    writeReactViteApp(directory);
    const plan = planInstall(directory);
    const tampered = structuredClone(plan);
    const entryChange = tampered.changes.find((change) => change.path === "src/main.ts");
    if (entryChange === undefined) throw new Error("entry change is missing");
    entryChange.path = "../outside.ts";

    expect(applyInstallPlan(tampered)).toMatchObject({
      status: "blocked",
      changedFiles: [],
      issues: expect.arrayContaining([
        expect.stringContaining("unauthorized path"),
        expect.stringContaining("planId does not match"),
      ]),
    });
  });

  it("verifies a synthetic journey and rejects content-bearing events", async () => {
    const directory = temporaryApp("runtime");
    writeReactViteApp(directory);
    applyInstallPlan(planInstall(directory));
    const configuration = JSON.parse(readFileSync(join(directory, "calibrate.install.json"), "utf8")) as {
      manifest: { version: string; groups: string[]; steps: Array<{ id: string; group: string }> };
    };
    const server = createCalibrate({
      manifest: configuration.manifest,
      adminToken: "admin",
      dashboardToken: "dashboard",
      writeKey: "write-key",
    });
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      return server.routes.request(request);
    });

    const verification = await verifyInstallation(directory, {
      endpoint: "http://collector.test",
      writeKey: "write-key",
    });
    expect(verification).toMatchObject({ status: "verified", evidence: "runtime" });
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "synthetic-journey", ok: true }),
      expect.objectContaining({ name: "privacy-rejection", ok: true }),
    ]));
  });

  it("does not treat static success as runtime success", async () => {
    const directory = temporaryApp("false-success");
    writeReactViteApp(directory);
    applyInstallPlan(planInstall(directory));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("collector unavailable"); }));

    const verification = await verifyInstallation(directory, {
      endpoint: "http://collector.test",
      writeKey: "write-key",
    });
    expect(verification).toMatchObject({ status: "failed", evidence: "runtime" });
    expect(verification.checks).toContainEqual(expect.objectContaining({
      name: "collector-health",
      ok: false,
    }));
  });
});
