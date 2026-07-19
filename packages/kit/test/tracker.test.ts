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
  groups: ["start", "finish"],
  steps: [
    { id: "one", group: "start", privateConfig: "ignored" },
    { id: "two", group: "finish" },
  ],
};

function ack(meta: unknown = null): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, meta }),
  } as Response;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("browser tracker", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    localStorage.clear();
    vi.restoreAllMocks();
    await tracker.init({
      manifest,
    });
  });

  it("never throws or fetches before successful init", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => tracker.view("one")).not.toThrow();
    expect(() => tracker.error("one", "invalid", 1)).not.toThrow();
    expect(() => tracker.complete("one")).not.toThrow();
    expect(() => tracker.copy("command")).not.toThrow();
    expect(() => tracker.paste("one", false)).not.toThrow();
    expect(() => tracker.shipped()).not.toThrow();
    expect(() => tracker.onMeta(() => undefined)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("silently disables failed init and warns at most once in debug mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tracker.init({
        endpoint: "https://collector.test",
        manifest: "https://host.test/manifest.json",
        debug: true,
      }),
    ).resolves.toBeUndefined();
    tracker.view("one");
    tracker.error("one", "invalid", 1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an empty endpoint as same-origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);

    await tracker.init({ endpoint: "", manifest });
    tracker.view("one");
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("silently disables omitted and non-string endpoints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tracker.init({ manifest })).resolves.toBeUndefined();
    await expect(
      tracker.init({ endpoint: 42, manifest } as unknown as TestInitOptions),
    ).resolves.toBeUndefined();
    tracker.view("one");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates object manifests, infers navigation, and emits closed events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "host=value";

    await tracker.init({ endpoint: "https://collector.test/", manifest, app: "product" });
    tracker.view("two");
    await settle();
    tracker.view("one");
    await settle();
    tracker.error("one", "invalid_email", 2);
    await settle();
    tracker.complete("one");
    tracker.copy("api_key");
    tracker.paste("one", true);
    tracker.shipped();

    const posted = fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    expect(posted.map((event) => event.type)).toEqual([
      "session_start",
      "page_view",
      "page_view",
      "step_error",
    ]);
    expect(posted[1]).toMatchObject({ step: "two", nav: "forward" });
    expect(posted[2]).toMatchObject({ step: "one", nav: "back" });

    const queued = JSON.parse(
      localStorage.getItem("fm:product:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(queued.map((event) => event.type)).toEqual([
      "step_complete",
      "copy",
      "paste_result",
      "shipped",
    ]);
    expect(Object.keys(queued[0] ?? {})).not.toContain("content");
    expect(document.cookie).toBe("host=value");
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)).sort()).toEqual([
      "fm:product:lastSeen",
      "fm:product:queue",
      "fm:product:seq",
      "fm:product:shipped",
      "fm:product:sid",
      "fm:product:step",
    ]);
  });

  it("calls meta subscribers only when metadata deeply changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ack({ mode: "a", nested: { count: 1 } }))
      .mockResolvedValueOnce(ack({ nested: { count: 1 }, mode: "a" }))
      .mockResolvedValueOnce(ack({ mode: "b", nested: { count: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const callback = vi.fn();
    const unsubscribe = tracker.onMeta(callback);

    await tracker.init({ endpoint: "https://collector.test", manifest });
    tracker.view("one");
    await settle();
    tracker.view("two");
    await settle();
    tracker.error("two", "retry", 1);
    await settle();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith({
      mode: "b",
      nested: { count: 1 },
    });
    unsubscribe();
  });

  it("restores session markers and reports resume away time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);

    await tracker.init({ endpoint: "https://collector.test", manifest, app: "resume" });
    tracker.view("two");
    await settle();
    const first = {
      sessionId: JSON.parse(localStorage.getItem("fm:resume:sid") ?? '""') as string,
      seq: JSON.parse(localStorage.getItem("fm:resume:seq") ?? "0") as number,
      current: JSON.parse(localStorage.getItem("fm:resume:step") ?? "null") as string,
    };

    vi.setSystemTime(6_000);
    await tracker.init({ endpoint: "https://collector.test", manifest, app: "resume" });
    await vi.advanceTimersByTimeAsync(2_000);

    const events = fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    const second = {
      sessionId: JSON.parse(localStorage.getItem("fm:resume:sid") ?? '""') as string,
      seq: JSON.parse(localStorage.getItem("fm:resume:seq") ?? "0") as number,
      current: JSON.parse(localStorage.getItem("fm:resume:step") ?? "null") as string,
    };
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_start",
          resumed: true,
          awayMs: 5_000,
        }),
      ]),
    );
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionId).toMatch(/^fm1\.[0-9a-z]+\.[0-9a-f-]{32,36}$/);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.current).toBe("two");
  });

  it("starts a new session after shipment or the idle timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));

    await tracker.init({ endpoint: "", manifest, app: "shipped-session" });
    const beforeShip = localStorage.getItem("fm:shipped-session:sid");
    tracker.shipped();
    await tracker.init({ endpoint: "", manifest, app: "shipped-session" });
    expect(localStorage.getItem("fm:shipped-session:sid")).not.toBe(beforeShip);

    await tracker.init({ endpoint: "", manifest, app: "stale-session" });
    const beforeTimeout = localStorage.getItem("fm:stale-session:sid");
    vi.setSystemTime(31 * 60 * 1_000);
    await tracker.init({ endpoint: "", manifest, app: "stale-session" });
    expect(localStorage.getItem("fm:stale-session:sid")).not.toBe(beforeTimeout);
  });

  it("preserves original startedAt through the encoded session id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));

    await tracker.init({ endpoint: "https://collector.test", manifest, app: "timed" });
    const sessionId = JSON.parse(
      localStorage.getItem("fm:timed:sid") ?? '""',
    ) as string;
    expect(sessionId).toMatch(/^fm1\.[0-9a-z]+\.[0-9a-f-]{32,36}$/);

    vi.setSystemTime(6_000);
    await tracker.init({ endpoint: "https://collector.test", manifest, app: "timed" });
    vi.setSystemTime(7_000);
    tracker.shipped();

    const queued = JSON.parse(
      localStorage.getItem("fm:timed:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(queued).toContainEqual(
      expect.objectContaining({ type: "shipped", totalMs: 6_000 }),
    );
  });

  it("uses saved lastSeen for legacy UUID sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));
    localStorage.setItem(
      "fm:legacy:sid",
      JSON.stringify("123e4567-e89b-12d3-a456-426614174000"),
    );
    localStorage.setItem("fm:legacy:seq", "4");
    localStorage.setItem("fm:legacy:step", "null");
    localStorage.setItem("fm:legacy:lastSeen", "5000");
    localStorage.setItem("fm:legacy:queue", "[]");

    await tracker.init({ endpoint: "https://collector.test", manifest, app: "legacy" });
    vi.setSystemTime(7_000);
    tracker.shipped();

    const queued = JSON.parse(
      localStorage.getItem("fm:legacy:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(queued).toContainEqual(
      expect.objectContaining({ type: "shipped", totalMs: 2_000 }),
    );
  });

  it("silently drops prose and unsafe tracker string values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ack()));
    await tracker.init({ endpoint: "https://collector.test", manifest, app: "bounded" });
    const before = localStorage.getItem("fm:bounded:queue");

    tracker.copy("copied secret prose");
    tracker.error("one", "<script>", 1);
    tracker.view("two", "forward", "unsafe origin");

    expect(localStorage.getItem("fm:bounded:queue")).toBe(before);
  });

  it("retries at 2, 4, and 8 seconds before recovering", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);

    await tracker.init({ endpoint: "https://collector.test", manifest });
    tracker.view("one");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      JSON.parse(localStorage.getItem("fm:default:queue") ?? "[]"),
    ).toEqual([]);
  });

  it("emits visibility heartbeats and drains pagehide with bye", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);
    const added: string[] = [];
    const add = vi.spyOn(window, "addEventListener");
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    Object.defineProperty(document, "hidden", { configurable: true, value: false });

    await tracker.init({ endpoint: "https://collector.test", manifest, app: "life" });
    expect(add.mock.calls.map((call) => call[0])).not.toContain("beforeunload");
    expect(add.mock.calls.map((call) => call[0])).not.toContain("unload");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    const heartbeatEvents = fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    expect(heartbeatEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "heartbeat", visible: true }),
      ]),
    );

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.addEventListener("visibilitychange", () => added.push("seen"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(added).toEqual(["seen"]);

    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    const hiddenAt = Date.now();
    window.dispatchEvent(pagehide);
    await settle();
    const fetched = fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    expect(fetched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "heartbeat", visible: true }),
        expect.objectContaining({ type: "heartbeat", visible: false }),
        expect.objectContaining({ type: "bye", persisted: true }),
      ]),
    );
    expect(
      JSON.parse(localStorage.getItem("fm:life:queue") ?? "[]"),
    ).toEqual([]);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.setSystemTime(hiddenAt + 5_000);
    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    const resumedEvents = fetchMock.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: Array<Record<string, unknown>>;
      };
      return body.events;
    });
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_start",
          resumed: true,
          awayMs: 5_000,
        }),
      ]),
    );
    expect(
      resumedEvents.filter(
        (value) => value.type === "heartbeat" && value.visible === true,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("fetches URL manifests and sends no batch over 50 events", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => manifest,
      } as Response)
      .mockResolvedValue(ack());
    vi.stubGlobal("fetch", fetchMock);

    await tracker.init({
      endpoint: "https://collector.test",
      manifest: "https://host.test/manifest.json",
      app: "url",
    });
    const stored = JSON.parse(
      localStorage.getItem("fm:url:queue") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const seed = stored[0] as Record<string, unknown>;
    localStorage.setItem(
      "fm:url:queue",
      JSON.stringify(
        Array.from({ length: 55 }, (_, seq) => ({
          ...seed,
          seq,
          type: "copy",
          artifact: "artifact",
        })),
      ),
    );
    await tracker.init({
      endpoint: "https://collector.test",
      manifest,
      app: "url",
    });
    await vi.advanceTimersByTimeAsync(2_000);

    const batchSizes = fetchMock.mock.calls.slice(1).map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        events: unknown[];
      };
      return body.events.length;
    });
    expect(batchSizes).toEqual([50, 6]);
  });
});
