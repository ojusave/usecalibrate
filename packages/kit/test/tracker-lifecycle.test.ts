// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as trackerModule from "../src/tracker.js";
import type { InitOptions } from "../src/tracker.js";

type TestInitOptions = Omit<InitOptions, "writeKey"> & { writeKey?: string };
const tracker = {
  ...trackerModule,
  init: (options: TestInitOptions) =>
    trackerModule.init({ writeKey: "tracker-write-key", ...options }),
};

const manifest = {
  version: "v1",
  groups: ["flow"],
  steps: [{ id: "start", group: "flow" }],
};

function ack(): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, meta: null }),
  } as Response;
}

describe("tracker lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    tracker.destroy();
    localStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  it("destroys timers and listeners without clearing persisted state", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ack());
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    vi.stubGlobal("fetch", fetchMock);
    await tracker.init({ endpoint: "", manifest, app: "destroy" });
    const stored = [...Array(localStorage.length)].map((_, index) => [
      localStorage.key(index),
      localStorage.getItem(localStorage.key(index) ?? ""),
    ]);

    expect(() => tracker.destroy()).not.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWindow).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(
      [...Array(localStorage.length)].map((_, index) => [
        localStorage.key(index),
        localStorage.getItem(localStorage.key(index) ?? ""),
      ]),
    ).toEqual(stored);
  });

  it("invalidates an in-flight flush and keeps its outbox", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await tracker.init({ endpoint: "", manifest, app: "flight" });
    tracker.view("start");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tracker.destroy();
    resolveFetch?.(ack());
    await Promise.resolve();
    await Promise.resolve();

    const queue = JSON.parse(
      localStorage.getItem("fm:flight:queue") ?? "[]",
    ) as unknown[];
    expect(queue).toHaveLength(2);
  });

  it("preserves a resumed event when a late fetch batch succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    await tracker.init({
      endpoint: "",
      manifest,
      app: "late",
    });
    tracker.view("start");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    window.dispatchEvent(pagehide);
    expect(
      JSON.parse(localStorage.getItem("fm:late:queue") ?? "[]"),
    ).not.toEqual([]);

    vi.setSystemTime(6_000);
    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    resolveFirst?.(ack());
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    const queued = JSON.parse(
      localStorage.getItem("fm:late:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const fetchedAfterResume = fetchMock.mock.calls.slice(1).flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    expect([...queued, ...fetchedAfterResume]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_start",
          resumed: true,
          awayMs: 5_000,
        }),
      ]),
    );
  });

  it("prevents a slow URL manifest init from replacing a newer init", async () => {
    let resolveManifest: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "https://host.test/manifest.json") {
        return new Promise<Response>((resolve) => {
          resolveManifest = resolve;
        });
      }
      return Promise.resolve(ack());
    });
    vi.stubGlobal("fetch", fetchMock);

    const stale = tracker.init({
      endpoint: "",
      manifest: "https://host.test/manifest.json",
      app: "old",
    });
    await Promise.resolve();
    await tracker.init({ endpoint: "", manifest, app: "new" });
    resolveManifest?.({
      ok: true,
      json: async () => manifest,
    } as Response);
    await stale;
    tracker.view("start");

    expect(localStorage.getItem("fm:new:sid")).not.toBeNull();
    expect(localStorage.getItem("fm:old:sid")).toBeNull();
  });
});
