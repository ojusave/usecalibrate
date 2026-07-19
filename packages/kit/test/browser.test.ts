// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineManifest,
  firstmile,
  type FirstmileController,
  type FirstmileOptions,
} from "../src/browser.js";

const manifest = defineManifest({
  version: "v1",
  groups: ["flow"],
  steps: [
    { id: "start", group: "flow" },
    { id: "done", group: "flow" },
  ],
});

let controller: FirstmileController | undefined;

function start(
  options: Omit<FirstmileOptions, "manifest" | "writeKey"> = {},
): FirstmileController {
  return firstmile({ manifest, writeKey: "browser-write-key", ...options });
}

(
  window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  }
).happyDOM.settings.disableIframePageLoading = true;

function ack(): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, meta: null }),
  } as Response;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function recorded(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  const sent = fetchMock.mock.calls.flatMap((call) => {
    const body = JSON.parse(String((call[1] as RequestInit).body)) as {
      events: Array<Record<string, unknown>>;
    };
    return body.events;
  });
  const queued = [...Array(localStorage.length)]
    .map((_, index) => localStorage.key(index))
    .filter((key): key is string => key?.endsWith(":queue") === true)
    .flatMap(
      (key) =>
        JSON.parse(localStorage.getItem(key) ?? "[]") as Array<
          Record<string, unknown>
        >,
    );
  return [...sent, ...queued].sort(
    (left, right) => Number(left.seq) - Number(right.seq),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  history.replaceState(null, "", "/");
});

afterEach(() => {
  controller?.destroy();
  controller = undefined;
});

describe("browser facade", () => {
  it("has a browser-only source graph", () => {
    for (const file of [
      "browser.ts",
      "tracker.ts",
      "manifest.ts",
      "value-validation.ts",
      "route-observer.ts",
      "dashboard-overlay.ts",
    ]) {
      const source = readFileSync(`packages/kit/src/${file}`, "utf8");
      expect(source).not.toMatch(/from ["'](?:node:|fs|path|crypto|http)/);
    }
  });

  it("initializes immediately and replays pre-ready methods in order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);

    controller = start();
    controller.view("start");
    controller.complete("start");
    controller.copy("command");
    await expect(controller.ready).resolves.toBeUndefined();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/__firstmile/api/events",
      expect.objectContaining({ method: "POST" }),
    );
    expect(recorded(fetchMock).map((event) => event.type)).toEqual([
      "session_start",
      "page_view",
      "step_complete",
      "copy",
    ]);
  });

  it("replaces the active instance while stale destroy stays harmless", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);
    const first = start({ app: "shared" });
    await first.ready;
    first.copy("command");
    const sessionId = localStorage.getItem("fm:shared:sid");

    controller = start({ app: "shared" });
    await controller.ready;
    first.destroy();
    controller.view("start");
    await settle();

    expect(localStorage.getItem("fm:shared:sid")).toBe(sessionId);
    expect(recorded(fetchMock)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "page_view", step: "start" }),
      ]),
    );
  });

  it("queues dashboard controls and isolates replacement controllers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));
    const first = start({
      app: "overlay",
      dashboard: { enabled: true, token: "dashboard-token" },
    });
    first.openDashboard();
    first.closeDashboard();
    await first.ready;

    let backdrop = document
      .querySelector<HTMLElement>("[data-firstmile-dashboard]")
      ?.shadowRoot?.querySelector<HTMLDivElement>(".backdrop");
    expect(backdrop?.hidden).toBe(true);
    first.openDashboard();
    expect(backdrop?.hidden).toBe(false);
    first.closeDashboard();
    expect(backdrop?.hidden).toBe(true);

    controller = start({
      app: "overlay",
      dashboard: { enabled: true, token: "dashboard-token" },
    });
    await controller.ready;
    backdrop = document
      .querySelector<HTMLElement>("[data-firstmile-dashboard]")
      ?.shadowRoot?.querySelector<HTMLDivElement>(".backdrop");
    first.openDashboard();
    first.destroy();
    expect(backdrop?.hidden).toBe(true);
    controller.openDashboard();
    expect(backdrop?.hidden).toBe(false);
    controller.closeDashboard();
    expect(backdrop?.hidden).toBe(true);
  });

  it("disables invalid config with one debug warning and no throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    controller = start({
      debug: true,
      routes: [
        { path: "/done", step: "done" },
        { path: "/done/", step: "start" },
      ],
    });
    controller.view("start");
    controller.copy("command");
    await expect(controller.ready).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("wires routes and the optional dashboard after tracker init", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));
    history.replaceState(null, "", "/start?private=value");
    controller = start({
      routes: [
        { path: "/start", step: "start" },
        { path: "/done", step: "done", shipped: true },
      ],
      dashboard: { enabled: true, token: "dashboard-token" },
    });
    await controller.ready;
    history.pushState(null, "", "/done#private");

    const events = JSON.parse(
      localStorage.getItem("fm:default:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["step_complete", "shipped"]),
    );
    expect(JSON.stringify(events)).not.toContain("private");
    expect(document.querySelectorAll("[data-firstmile-dashboard]")).toHaveLength(
      1,
    );
  });
});
