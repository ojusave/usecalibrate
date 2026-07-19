import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { FirstmileEvent } from "../src/reducer.js";
import {
  createFirstmile as createServer,
  type FirstmileServerOptions,
} from "../src/server.js";

const manifest = {
  version: "v1",
  groups: ["start", "finish"],
  steps: [
    { id: "one", group: "start" },
    { id: "two", group: "finish", label: "Second step" },
  ],
};

function event(
  seq: number,
  values: Partial<FirstmileEvent> & Pick<FirstmileEvent, "type">,
): FirstmileEvent {
  return {
    sessionId: "session-1",
    seq,
    ts: 1_000 + seq,
    manifestVersion: "v1",
    ...values,
  } as FirstmileEvent;
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

const writeHeaders = {
  "Content-Type": "application/json",
  "X-Firstmile-Write-Key": "write-secret",
};
const dashboardHeaders = { Authorization: "Bearer dashboard-secret" };

function createFirstmile(
  options: Omit<FirstmileServerOptions, "dashboardToken" | "writeKey">,
) {
  return createServer({
    dashboardToken: "dashboard-secret",
    writeKey: "write-secret",
    ...options,
  });
}

describe("createFirstmile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ingests a batch synchronously and exposes its snapshot", async () => {
    const server = createFirstmile({
      manifest,
      adminToken: "secret",
      meta: () => ({ mode: "live" }),
    });
    const batch = [
      event(1, { type: "session_start" }),
      event(2, { type: "page_view", step: "one", nav: "forward" }),
      event(3, { type: "step_complete", step: "one", elapsedMs: 75 }),
      event(4, { type: "page_view", step: "two", nav: "forward" }),
    ];

    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ events: batch }),
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      accepted: 4,
      rejected: 0,
      duplicates: 0,
      meta: { mode: "live" },
    });
    expect(server.sessionCount()).toBe(1);
    expect(server.snapshot()).toMatchObject({
      manifestVersion: "v1",
      meta: { mode: "live" },
      totals: { started: 1 },
      groups: [{ id: "start", count: 1 }, { id: "finish", count: 1 }],
    });
    expect(process.stdout.write).toHaveBeenCalledTimes(4);
    expect(vi.mocked(process.stdout.write).mock.calls[0]?.[0]).toBe(
      `${JSON.stringify(batch[0])}\n`,
    );
  });

  it("dedupes by session and sequence before storage and reduction", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const start = event(1, { type: "session_start" });
    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify([start, start]),
    });

    expect(response.status).toBe(200);
    expect(server.sessionCount()).toBe(1);
    expect(server.exportJsonl()).toBe(`${JSON.stringify(start)}\n`);
    expect(process.stdout.write).toHaveBeenCalledTimes(1);
  });

  it("rejects events for another manifest or an unknown step", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const weird = event(8, {
      type: "page_view",
      step: "not-in-manifest",
      nav: "forward",
      manifestVersion: "unexpected",
    });

    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ events: [weird] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect(server.exportJsonl()).toBe("");
    expect(server.snapshot().totals.started).toBe(0);
  });

  it("flags reducer anomalies while still storing and acknowledging them", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const batch = [
      event(1, { type: "page_view", step: "two", nav: "forward" }),
      event(2, { type: "page_view", step: "one", nav: "forward" }),
    ];
    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ events: batch }),
    });

    expect(response.status).toBe(200);
    expect(
      server
        .exportJsonl()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([batch[0], { ...batch[1], anomaly: true }]);
  });

  it("rejects a non-array events envelope", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ events: "nope" }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("request body must be");
    expect(server.sessionCount()).toBe(0);
  });

  it.each([
    {
      events: [
        {
          ...event(1, { type: "session_start" }),
          content: "must never be accepted",
        },
      ],
    },
    { events: [{ ...event(1, { type: "session_start" }), seq: 1.5 }] },
    { events: [{ ...event(1, { type: "page_view" }), step: "one" }] },
  ])(
    "omits invalid siblings without failing the batch %#",
    async (body) => {
      const server = createFirstmile({ manifest, adminToken: "secret" });
      const response = await server.routes.request("/api/events", {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
      expect(server.sessionCount()).toBe(0);
      expect(process.stdout.write).not.toHaveBeenCalled();
    },
  );

  it("records valid mixed-batch siblings and blocks prose channels", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const start = event(1, { type: "session_start" });
    const unknownStep = event(4, {
      type: "page_view",
      step: "unknown-step",
      nav: "forward",
    });
    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        events: [
          start,
          { ...event(2, { type: "copy", artifact: "safe-id" }), content: "typed prose" },
          event(3, { type: "copy", artifact: "typed prose" }),
          unknownStep,
          event(5, {
            type: "step_error",
            step: "one",
            code: "<script>",
            attempt: 1,
          }),
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: 1,
      rejected: 4,
      duplicates: 0,
      meta: null,
    });
    expect(
      server
        .exportJsonl()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([start]);
  });

  it("returns manifest, dashboard, health, and projector routes", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });

    const manifestResponse = await server.routes.request("/api/manifest");
    expect((await server.routes.request("/api/dashboard")).status).toBe(401);
    const dashboardResponse = await server.routes.request("/api/dashboard", {
      headers: dashboardHeaders,
    });
    const healthResponse = await server.routes.request("/healthz");
    const presentResponse = await server.routes.request("/present");

    expect(await json(manifestResponse)).toEqual(manifest);
    expect(await json(dashboardResponse)).toMatchObject({
      manifestVersion: "v1",
      totals: { started: 0, shipped: 0 },
    });
    expect(await json(healthResponse)).toEqual({ ok: true });
    expect(presentResponse.headers.get("content-type")).toContain("text/html");
    expect(presentResponse.headers.get("cache-control")).toBe("no-store");
    const html = await presentResponse.text();
    expect(html).toContain("window.location.pathname");
    expect(html).toContain("fetch(dashboardPath()");
    expect(html).not.toContain('"/__firstmile"');
    expect(html).toContain("setInterval(poll, 1000)");
    expect(html).toContain('event.key.toLowerCase() === "d"');
    expect(html).toContain("age > 5");
    for (const color of [
      "#0e1116",
      "#e8e8e8",
      "#9aa0a6",
      "#34d399",
      "#fbbf24",
      "#f87171",
    ]) {
      expect(html).toContain(color);
    }
    expect(html).toContain("font-size: 72px");
    expect(html).toContain("font-size: 56px");
    expect(html).toContain("font-size: 24px");
    expect(html).toContain("font-size: 20px");
    expect(html).toContain("font-size: 14px");
    expect(html).toContain('["id", "count", "errors", "backFrom", "returnsTo", "median"]');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect((await server.routes.request("/present/")).status).toBe(200);
  });

  it("works when mounted under a Hono prefix", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const app = new Hono();
    app.route("/__firstmile", server.routes);
    const start = event(1, { type: "session_start" });

    const ingest = await app.request("/__firstmile/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ events: [start] }),
    });
    const dashboard = await app.request("/__firstmile/api/dashboard", {
      headers: dashboardHeaders,
    });
    const present = await app.request("/__firstmile/present");

    expect(ingest.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      totals: { started: 1 },
    });
    expect(present.status).toBe(200);
    expect(await present.text()).toContain("window.location.pathname");
  });

  it("sets no-store on every response", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const requests: Array<[string, RequestInit?]> = [
      ["/api/manifest"],
      ["/api/dashboard"],
      ["/healthz"],
      ["/present"],
      ["/export"],
      ["/missing"],
      [
        "/api/events",
        {
          method: "POST",
          headers: writeHeaders,
          body: "{}",
        },
      ],
      ["/api/events", { method: "OPTIONS" }],
    ];
    for (const [path, init] of requests) {
      const response = await server.routes.request(path, init);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("gates JSONL export with the exact admin token", async () => {
    const server = createFirstmile({ manifest, adminToken: "a token" });
    const stored = event(1, { type: "session_start" });
    await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify([stored]),
    });

    expect((await server.routes.request("/export")).status).toBe(401);
    expect((await server.routes.request("/export?token=a%20token")).status).toBe(401);
    const response = await server.routes.request("/export", {
      headers: { Authorization: "Bearer a token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(await response.text()).toBe(`${JSON.stringify(stored)}\n`);
  });

  it("sets CORS only for allowed origins and answers preflight", async () => {
    const server = createFirstmile({
      manifest,
      adminToken: "secret",
      allowedOrigins: ["https://allowed.example"],
    });
    const allowed = await server.routes.request("/api/manifest", {
      headers: { Origin: "https://allowed.example" },
    });
    const denied = await server.routes.request("/api/manifest", {
      headers: { Origin: "https://denied.example" },
    });
    const preflight = await server.routes.request("/api/events", {
      method: "OPTIONS",
      headers: { Origin: "https://allowed.example" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example",
    );
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "X-Firstmile-Write-Key",
    );
  });

  it("requires distinct credentials and enforces request limits", async () => {
    expect(() =>
      createServer({
        manifest,
        adminToken: "same",
        dashboardToken: "same",
        writeKey: "different",
      }),
    ).toThrow(/must be distinct/);

    const server = createFirstmile({
      manifest,
      adminToken: "secret",
      limits: { maxBodyBytes: 80, maxRequestsPerWindow: 2 },
    });
    const start = event(1, { type: "session_start" });
    expect((await server.routes.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([start]),
    })).status).toBe(401);
    expect((await server.routes.request("/api/events", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify([start, start]),
    })).status).toBe(413);
    expect((await server.routes.request("/api/manifest")).status).toBe(429);
  });
});
