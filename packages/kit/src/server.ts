import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { validateEventBatch } from "./event-validation.js";
import type { Manifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";
import {
  reduceEvent,
  type SessionState,
  type StoredEvent,
} from "./reducer.js";
import {
  buildSnapshot,
  type DashboardSnapshot,
  type PresenceThresholds,
} from "./snapshot.js";

const presentHtml = readFileSync(
  new URL("../present/index.html", import.meta.url),
  "utf8",
);

function presentResponse(): Response {
  return new Response(presentHtml, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=UTF-8",
    },
  });
}

export interface FirstmileServerOptions {
  manifest: Manifest;
  adminToken: string;
  allowedOrigins?: readonly string[];
  presence?: PresenceThresholds;
  meta?: () => unknown;
}

export interface FirstmileServer {
  routes: Hono;
  snapshot(): DashboardSnapshot;
  exportJsonl(): string;
  sessionCount(): number;
}

function setCorsHeaders(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  setHeader: (name: string, value: string) => void,
): void {
  if (origin !== undefined && allowedOrigins.has(origin)) {
    setHeader("Access-Control-Allow-Origin", origin);
    setHeader("Vary", "Origin");
    setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

/**
 * Creates a synchronous in-memory firstmile server and its Hono routes.
 */
export function createFirstmile(
  options: FirstmileServerOptions,
): FirstmileServer {
  const manifest = validateManifest(options.manifest);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const sessions = new Map<string, SessionState>();
  const events: StoredEvent[] = [];
  const routes = new Hono();
  const meta = options.meta ?? (() => null);

  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.use("/api/*", async (context, next) => {
    setCorsHeaders(
      context.req.header("Origin"),
      allowedOrigins,
      (name, value) => context.header(name, value),
    );
    if (context.req.method === "OPTIONS") {
      return context.body(null, 204);
    }
    await next();
  });

  routes.post("/api/events", async (context) => {
    let batch: ReturnType<typeof validateEventBatch>;
    try {
      batch = validateEventBatch(await context.req.json());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid request body";
      return context.json({ ok: false, error: message }, 400);
    }

    for (const event of batch) {
      const result = reduceEvent(sessions.get(event.sessionId), event, manifest);
      if (result.duplicate) {
        continue;
      }
      sessions.set(event.sessionId, result.session);
      if (result.storedEvent !== null) {
        events.push(result.storedEvent);
        process.stdout.write(`${JSON.stringify(result.storedEvent)}\n`);
      }
    }
    return context.json({ ok: true, meta: meta() });
  });

  routes.get("/api/manifest", (context) => context.json(manifest));
  routes.get("/api/dashboard", (context) => context.json(snapshot()));
  routes.get("/present", () => presentResponse());
  routes.get("/present/", () => presentResponse());
  routes.get("/export", (context) => {
    if (context.req.query("token") !== options.adminToken) {
      return context.json({ ok: false, error: "unauthorized" }, 401);
    }
    return context.body(exportJsonl(), 200, {
      "Content-Type": "application/x-ndjson; charset=UTF-8",
    });
  });
  routes.get("/healthz", (context) => context.json({ ok: true }));

  function snapshot(): DashboardSnapshot {
    return buildSnapshot({
      manifest,
      sessions: sessions.values(),
      events,
      generatedAt: Date.now(),
      meta: meta(),
      ...(options.presence === undefined ? {} : { presence: options.presence }),
    });
  }

  function exportJsonl(): string {
    return events.length === 0
      ? ""
      : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  return {
    routes,
    snapshot,
    exportJsonl,
    sessionCount: () => sessions.size,
  };
}

export type {
  DashboardSnapshot,
  Manifest,
  PresenceThresholds,
  SessionState,
  StoredEvent,
};
export { FIRSTMILE_VERSION } from "./version.js";
