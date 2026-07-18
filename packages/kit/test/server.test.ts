import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstmileEvent } from "../src/reducer.js";
import { createFirstmile } from "../src/server.js";

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

describe("createFirstmile", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, meta: { mode: "live" } });
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([start, start]),
    });

    expect(response.status).toBe(200);
    expect(server.sessionCount()).toBe(1);
    expect(server.exportJsonl()).toBe(`${JSON.stringify(start)}\n`);
    expect(process.stdout.write).toHaveBeenCalledTimes(1);
  });

  it("records schema-valid weird events instead of rejecting them", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });
    const weird = event(8, {
      type: "page_view",
      step: "not-in-manifest",
      nav: "forward",
      manifestVersion: "unexpected",
    });

    const response = await server.routes.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [weird] }),
    });

    expect(response.status).toBe(200);
    expect(server.exportJsonl()).toBe(`${JSON.stringify(weird)}\n`);
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
    expect(await response.json()).toEqual({ ok: true, meta: null });
    expect(
      server
        .exportJsonl()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([start, unknownStep]);
  });

  it("returns manifest, dashboard, health, and projector routes", async () => {
    const server = createFirstmile({ manifest, adminToken: "secret" });

    const manifestResponse = await server.routes.request("/api/manifest");
    const dashboardResponse = await server.routes.request("/api/dashboard");
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
    expect(html).toContain('fetch("/api/dashboard"');
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
          headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([stored]),
    });

    expect((await server.routes.request("/export")).status).toBe(401);
    const response = await server.routes.request(
      "/export?token=a%20token",
    );
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
  });
});
