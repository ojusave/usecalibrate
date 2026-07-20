import { afterEach, describe, expect, it, vi } from "vitest";

const { serve } = vi.hoisted(() => ({ serve: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve }));

const validManifest = JSON.stringify({
  version: "v1",
  groups: ["start"],
  steps: [{ id: "one", group: "start" }],
});

async function importSidecar(): Promise<void> {
  await import("../src/sidecar.js");
}

describe("sidecar configuration", () => {
  afterEach(() => {
    delete process.env.PORT;
    delete process.env.ADMIN_TOKEN;
    delete process.env.DASHBOARD_TOKEN;
    delete process.env.WRITE_KEY;
    delete process.env.MANIFEST_JSON;
    delete process.env.MANIFEST_URL;
    serve.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("defaults to port 8787 and lets MANIFEST_JSON win", async () => {
    process.env.ADMIN_TOKEN = "secret";
    process.env.DASHBOARD_TOKEN = "dashboard-secret";
    process.env.WRITE_KEY = "write-secret";
    process.env.MANIFEST_JSON = validManifest;
    process.env.MANIFEST_URL = "https://invalid.example/ignored";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await importSidecar();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "0.0.0.0", port: 8787 }),
      expect.any(Function),
    );
  });

  it.each([
    [undefined, "MANIFEST_JSON or MANIFEST_URL is required"],
    [
      '{"version":1}',
      'manifest version must be a 1-128 character identifier using letters, numbers, ".", "_", ":", "/", or "-"',
    ],
  ])("prints manifest validation errors and exits 1", async (value, message) => {
    process.env.ADMIN_TOKEN = "secret";
    process.env.DASHBOARD_TOKEN = "dashboard-secret";
    process.env.WRITE_KEY = "write-secret";
    if (value !== undefined) process.env.MANIFEST_JSON = value;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(importSidecar()).rejects.toThrow("exit:1");
    expect(stderr).toHaveBeenCalledWith(`${message}\n`);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("clears in-memory state via admin-token-gated POST /admin/reset", async () => {
    process.env.ADMIN_TOKEN = "secret";
    process.env.DASHBOARD_TOKEN = "dashboard-secret";
    process.env.WRITE_KEY = "write-secret";
    process.env.MANIFEST_JSON = validManifest;

    await importSidecar();
    const fetch = serve.mock.calls[0]?.[0]?.fetch as (
      request: Request,
    ) => Promise<Response>;

    await fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Firstmile-Write-Key": "write-secret",
        },
        body: JSON.stringify({
          events: [
            {
              sessionId: "session-1",
              seq: 1,
              ts: Date.now(),
              manifestVersion: "v1",
              type: "session_start",
            },
          ],
        }),
      }),
    );

    const before = await fetch(
      new Request("http://local/api/dashboard", {
        headers: { Authorization: "Bearer dashboard-secret" },
      }),
    );
    expect(((await before.json()) as { totals: { started: number } }).totals.started).toBe(1);

    const denied = await fetch(
      new Request("http://local/admin/reset", { method: "POST" }),
    );
    expect(denied.status).toBe(401);

    const reset = await fetch(
      new Request("http://local/admin/reset", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });

    const after = await fetch(
      new Request("http://local/api/dashboard", {
        headers: { Authorization: "Bearer dashboard-secret" },
      }),
    );
    expect(((await after.json()) as { totals: { started: number } }).totals.started).toBe(0);
  });
});
