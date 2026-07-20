import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { validateEventBatchDetailed } from "./event-validation.js";
import type { Manifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";
import {
  reduceEvent,
  type FirstmileEvent,
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
  dashboardToken: string;
  writeKey: string;
  allowedOrigins?: readonly string[];
  presence?: PresenceThresholds;
  limits?: FirstmileLimits;
  meta?: () => unknown;
}

export interface FirstmileLimits {
  maxBodyBytes?: number;
  maxBatchSize?: number;
  maxSessions?: number;
  maxEvents?: number;
  maxEventsPerSession?: number;
  retentionMs?: number;
  maxFutureSkewMs?: number;
  rateLimitWindowMs?: number;
  maxRequestsPerWindow?: number;
}

export const DEFAULT_FIRSTMILE_LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxBatchSize: 50,
  maxSessions: 10_000,
  maxEvents: 100_000,
  maxEventsPerSession: 5_000,
  retentionMs: 24 * 60 * 60 * 1_000,
  maxFutureSkewMs: 5 * 60 * 1_000,
  rateLimitWindowMs: 60_000,
  maxRequestsPerWindow: 120,
} as const;

export interface FirstmileServer {
  routes: Hono;
  snapshot(): DashboardSnapshot;
  exportJsonl(): string;
  sessionCount(): number;
  reset(): void;
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
    setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firstmile-Write-Key");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretsMatch(candidate: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(candidate ?? ""), digest(expected));
}

function bearerToken(value: string | undefined): string | undefined {
  return /^Bearer[ \t]+(.+)$/i.exec(value ?? "")?.[1];
}

class BodyTooLargeError extends Error {}

async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  if (request.body === null) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError("request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function referencesKnownSteps(event: FirstmileEvent, stepIds: ReadonlySet<string>): boolean {
  if ((event.type === "page_view" || event.type === "step_error" || event.type === "step_complete" || event.type === "paste_result") && !stepIds.has(event.step)) return false;
  return event.type !== "page_view" || event.from === undefined || stepIds.has(event.from);
}

/**
 * Creates a synchronous in-memory firstmile server and its Hono routes.
 */
export function createFirstmile(
  options: FirstmileServerOptions,
): FirstmileServer {
  const manifest = validateManifest(options.manifest);
  const credentials = [options.adminToken, options.dashboardToken, options.writeKey];
  if (credentials.some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("adminToken, dashboardToken, and writeKey must be non-empty");
  if (new Set(credentials).size !== 3) throw new Error("adminToken, dashboardToken, and writeKey must be distinct");
  const limits = { ...DEFAULT_FIRSTMILE_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const stepIds = new Set(manifest.steps.map((step) => step.id));
  const sessions = new Map<string, SessionState>();
  const events: StoredEvent[] = [];
  const routes = new Hono();
  const meta = options.meta ?? (() => null);
  let windowStartedAt = Date.now();
  let requestsInWindow = 0;

  function prune(now = Date.now()): void {
    const cutoff = now - limits.retentionMs;
    for (const [sessionId, session] of sessions) if (session.lastSeen < cutoff) sessions.delete(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if ((events[index]?.ts ?? now) < cutoff) events.splice(index, 1);
    }
  }

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
    const now = Date.now();
    if (now - windowStartedAt >= limits.rateLimitWindowMs) {
      windowStartedAt = now;
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    if (requestsInWindow > limits.maxRequestsPerWindow) return context.json({ ok: false, error: "rate limit exceeded" }, 429);
    await next();
  });

  routes.post("/api/events", async (context) => {
    if (!secretsMatch(context.req.header("X-Firstmile-Write-Key"), options.writeKey)) return context.json({ ok: false, error: "unauthorized" }, 401);
    let batch: ReturnType<typeof validateEventBatchDetailed>;
    try {
      const declared = Number(context.req.header("Content-Length"));
      if (Number.isFinite(declared) && declared > limits.maxBodyBytes) return context.json({ ok: false, error: "request body is too large" }, 413);
      const body = await readLimitedText(context.req.raw, limits.maxBodyBytes);
      batch = validateEventBatchDetailed(JSON.parse(body) as unknown, limits.maxBatchSize);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid request body";
      return context.json({ ok: false, error: message }, error instanceof BodyTooLargeError ? 413 : 400);
    }

    prune();
    const now = Date.now();
    let accepted = 0;
    let rejected = batch.rejected;
    let duplicates = 0;
    for (const event of batch.events) {
      const current = sessions.get(event.sessionId);
      if (event.manifestVersion !== manifest.version || !referencesKnownSteps(event, stepIds) || event.ts < now - limits.retentionMs || event.ts > now + limits.maxFutureSkewMs || event.seq >= limits.maxEventsPerSession || (current === undefined && sessions.size >= limits.maxSessions) || (current !== undefined && current.seqSeen.size >= limits.maxEventsPerSession)) {
        rejected += 1;
        continue;
      }
      const result = reduceEvent(current, event, manifest);
      if (result.duplicate) {
        duplicates += 1;
        continue;
      }
      sessions.set(event.sessionId, result.session);
      if (result.storedEvent !== null) {
        events.push(result.storedEvent);
        if (events.length > limits.maxEvents) events.splice(0, events.length - limits.maxEvents);
        process.stdout.write(`${JSON.stringify(result.storedEvent)}\n`);
      }
      accepted += 1;
    }
    return context.json({ ok: true, accepted, rejected, duplicates, meta: meta() });
  });

  routes.get("/api/manifest", (context) => context.json(manifest));
  routes.get("/api/dashboard", (context) => {
    if (!secretsMatch(bearerToken(context.req.header("Authorization")), options.dashboardToken)) return context.json({ ok: false, error: "unauthorized" }, 401);
    return context.json(snapshot());
  });
  routes.get("/present", () => presentResponse());
  routes.get("/present/", () => presentResponse());
  routes.get("/export", (context) => {
    if (!secretsMatch(bearerToken(context.req.header("Authorization")), options.adminToken)) {
      return context.json({ ok: false, error: "unauthorized" }, 401);
    }
    return context.body(exportJsonl(), 200, {
      "Content-Type": "application/x-ndjson; charset=UTF-8",
    });
  });
  routes.get("/healthz", (context) => context.json({ ok: true }));

  function snapshot(): DashboardSnapshot {
    prune();
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
    prune();
    return events.length === 0
      ? ""
      : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  function reset(): void {
    sessions.clear();
    events.length = 0;
  }

  return {
    routes,
    snapshot,
    exportJsonl,
    sessionCount: () => {
      prune();
      return sessions.size;
    },
    reset,
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
