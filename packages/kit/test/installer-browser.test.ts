// @vitest-environment happy-dom
import { build } from "esbuild";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInstallPlan, planInstall } from "../src/installer.js";

let temporary: string | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

describe("generated browser integration", () => {
  it("reaches Calibrate from the host entry and emits a completed route journey", async () => {
    vi.useFakeTimers();
    temporary = mkdtempSync(join(tmpdir(), "calibrate-browser-"));
    mkdirSync(join(temporary, "src"));
    mkdirSync(join(temporary, "node_modules"));
    symlinkSync(resolve("packages/kit"), join(temporary, "node_modules/usecalibrate"), "dir");
    writeFileSync(join(temporary, "package.json"), JSON.stringify({
      name: "browser-fixture",
      private: true,
      type: "module",
      dependencies: { react: "latest" },
      devDependencies: { vite: "latest" },
    }, null, 2));
    writeFileSync(join(temporary, "package-lock.json"), "{}\n");
    writeFileSync(join(temporary, "src/main.ts"), [
      'export { calibrateClient } from "./calibrate";',
      "export const routes = [",
      '  { path: "/signup" },',
      '  { path: "/projects/new" },',
      '  { path: "/success" },',
      "];",
      "",
    ].join("\n"));

    const applied = applyInstallPlan(planInstall(temporary));
    expect(applied.status).toBe("applied");

    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> };
      batches.push(batch);
      return new Response(JSON.stringify({
        ok: true,
        accepted: batch.events.length,
        rejected: 0,
        duplicates: 0,
        meta: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    history.replaceState({}, "", "/signup");

    const bundle = join(temporary, "bundle.js");
    await build({
      entryPoints: [join(temporary, "src/main.ts")],
      outfile: bundle,
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "CalibrateFixture",
      target: "es2022",
      logLevel: "silent",
      define: {
        "import.meta.env.VITE_CALIBRATE_WRITE_KEY": JSON.stringify("browser-write-key"),
        "import.meta.env.VITE_CALIBRATE_ENDPOINT": JSON.stringify("http://collector.test"),
      },
    });

    const module = runInThisContext(`${readFileSync(bundle, "utf8")}\nCalibrateFixture;`) as {
      calibrateClient?: { destroy(): void };
    };
    await vi.advanceTimersByTimeAsync(2_100);
    history.pushState({}, "", "/projects/new");
    await vi.advanceTimersByTimeAsync(2_100);
    history.pushState({}, "", "/success");
    await vi.advanceTimersByTimeAsync(2_100);

    const events = batches.flatMap((batch) => batch.events);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session_start",
      "page_view",
      "step_complete",
      "shipped",
    ]));
    expect(events.filter((event) => event.type === "page_view").map((event) => event.step)).toEqual([
      "signup",
      "new",
      "success",
    ]);
    expect(events.some((event) => "email" in event || "value" in event)).toBe(false);
    module.calibrateClient?.destroy();
  });
});
