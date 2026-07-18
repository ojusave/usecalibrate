import {
  CODE_MAX_LENGTH,
  isIdentifier,
  requireIdentifier,
} from "./value-validation.js";

interface ManifestStep {
  id: string;
  group: string;
  label?: string;
}

interface Manifest {
  version: string;
  groups: string[];
  steps: ManifestStep[];
}

type Nav = "forward" | "back";
type MetaCallback = (meta: unknown) => void;

type EventPayload =
  | { type: "session_start"; resumed?: boolean; awayMs?: number }
  | { type: "page_view"; step: string; nav: Nav; from?: string }
  | { type: "step_error"; step: string; code: string; attempt: number }
  | { type: "step_complete"; step: string; elapsedMs: number }
  | { type: "copy"; artifact: string }
  | { type: "paste_result"; step: string; ok: boolean }
  | { type: "heartbeat"; visible: boolean }
  | { type: "shipped"; totalMs: number }
  | { type: "bye"; persisted: boolean };

type TrackerEvent = EventPayload & {
  sessionId: string;
  seq: number;
  ts: number;
  manifestVersion: string;
};

interface StoredSession {
  sessionId: string;
  seq: number;
  current: string | null;
  enteredAt: number;
  lastSeen: number;
  startedAt: number;
}

export interface InitOptions {
  endpoint?: string;
  manifest: Manifest | string;
  app?: string;
  debug?: boolean;
}

const callbacks = new Set<MetaCallback>();
const retryDelays = [2_000, 4_000, 8_000, 15_000];
let active = false;
let warningSent = false;
let debug = false;
let endpoint = "";
let manifest: Manifest | null = null;
let session: StoredSession | null = null;
let outbox: TrackerEvent[] = [];
let storagePrefix = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let flushing = false;
let retryIndex = 0;
let lastMeta = "";
let removeLifecycle: (() => void) | undefined;
let generation = 0;
let bfcacheHiddenAt: number | null = null;

function warn(): void {
  if (debug && !warningSent) {
    warningSent = true;
    console.warn("firstmile tracker is disabled");
  }
}

function fail(): void {
  active = false;
  warn();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown): Manifest {
  if (!record(value)) throw new Error("manifest must be an object");
  const version = requireIdentifier(value.version, "manifest version");
  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new Error("manifest groups must be a non-empty array");
  }
  const groups = value.groups.map((item, index) =>
    requireIdentifier(item, `manifest group at index ${index}`),
  );
  if (new Set(groups).size !== groups.length) {
    throw new Error("manifest groups must be unique");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("manifest steps must be a non-empty array");
  }
  const ids = new Set<string>();
  const groupSet = new Set(groups);
  const steps = value.steps.map((item, index): ManifestStep => {
    if (!record(item)) {
      throw new Error(`manifest step at index ${index} must be an object`);
    }
    const id = requireIdentifier(item.id, `manifest step id at index ${index}`);
    if (ids.has(id)) throw new Error(`manifest has duplicate step id "${id}"`);
    ids.add(id);
    const group = requireIdentifier(item.group, `manifest step "${id}" group`);
    if (!groupSet.has(group)) {
      throw new Error(
        `manifest step "${id}" references unknown group "${group}"`,
      );
    }
    if (item.label !== undefined && typeof item.label !== "string") {
      throw new Error(`manifest step "${id}" label must be a string`);
    }
    return item.label === undefined ? { id, group } : { id, group, label: item.label };
  });
  return { version, groups, steps };
}

function storageGet<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(storagePrefix + key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

function storageSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(storagePrefix + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomPart(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomId(now: number): string {
  return `fm1.${now.toString(36)}.${randomPart()}`;
}

function startedAtFromSessionId(sessionId: string, fallback: number): number {
  const match = /^fm1\.([0-9a-z]+)\./i.exec(sessionId);
  if (match?.[1] === undefined) return fallback;
  const startedAt = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(startedAt) && startedAt >= 0 ? startedAt : fallback;
}

function persist(): boolean {
  return (
    session !== null &&
    storageSet("sid", session.sessionId) &&
    storageSet("seq", session.seq) &&
    storageSet("step", session.current) &&
    storageSet("lastSeen", session.lastSeen) &&
    storageSet("queue", outbox)
  );
}

function stepIndex(step: string): number {
  return manifest?.steps.findIndex((item) => item.id === step) ?? -1;
}

function scheduleFlush(delay = 2_000): void {
  if (!active || flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, delay);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function acceptMeta(value: unknown): void {
  if (!record(value) || value.ok !== true || !("meta" in value)) return;
  const next = canonical(value.meta);
  if (next === lastMeta) return;
  lastMeta = next;
  for (const callback of callbacks) {
    try {
      callback(value.meta);
    } catch {
      // Host callbacks cannot affect tracking.
    }
  }
}

async function flush(): Promise<void> {
  if (!active || flushing || outbox.length === 0) {
    if (active && outbox.length === 0) scheduleFlush();
    return;
  }
  flushing = true;
  const run = generation;
  const batch = outbox.slice(0, 50);
  try {
    const response = await fetch(`${endpoint}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
    if (!response.ok) throw new Error("ingest failed");
    const result: unknown = await response.json();
    if (run !== generation) return;
    acceptMeta(result);
    outbox.splice(0, batch.length);
    storageSet("queue", outbox);
    retryIndex = 0;
    flushing = false;
    if (outbox.length > 0) void flush();
    else scheduleFlush();
  } catch {
    if (run !== generation) return;
    flushing = false;
    const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)] ?? 15_000;
    retryIndex += 1;
    scheduleFlush(delay);
    warn();
  }
}

function enqueue(payload: EventPayload, immediate = false): void {
  if (!active || session === null || manifest === null) return;
  const now = Date.now();
  const event = {
    sessionId: session.sessionId,
    seq: session.seq,
    ts: now,
    manifestVersion: manifest.version,
    ...payload,
  } as TrackerEvent;
  session.seq += 1;
  session.lastSeen = now;
  outbox.push(event);
  persist();
  if (immediate || outbox.length >= 10) {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    void flush();
  } else {
    scheduleFlush();
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer !== undefined || document.hidden) return;
  heartbeatTimer = setInterval(() => {
    enqueue({ type: "heartbeat", visible: true });
  }, 10_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function attachLifecycle(): void {
  const visibility = (): void => {
    enqueue({ type: "heartbeat", visible: !document.hidden }, true);
    if (document.hidden) stopHeartbeat();
    else startHeartbeat();
  };
  const pagehide = (event: PageTransitionEvent): void => {
    bfcacheHiddenAt = event.persisted ? Date.now() : null;
    enqueue({ type: "bye", persisted: event.persisted });
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    while (outbox.length > 0) {
      const batch = outbox.slice(0, 50);
      const body = new Blob([JSON.stringify({ events: batch })], {
        type: "application/json",
      });
      if (!navigator.sendBeacon(`${endpoint}/api/events`, body)) break;
      outbox.splice(0, batch.length);
    }
    storageSet("queue", outbox);
    stopHeartbeat();
  };
  const pageshow = (event: PageTransitionEvent): void => {
    if (!event.persisted || bfcacheHiddenAt === null || !active) return;
    const awayMs = Math.max(0, Date.now() - bfcacheHiddenAt);
    bfcacheHiddenAt = null;
    enqueue({ type: "session_start", resumed: true, awayMs }, true);
    startHeartbeat();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  removeLifecycle = () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", pageshow);
  };
  startHeartbeat();
}

/**
 * Initializes tracking from a manifest object or URL.
 */
export async function init(options: InitOptions): Promise<void> {
  try {
    generation += 1;
    active = false;
    debug = options?.debug === true;
    warningSent = false;
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    stopHeartbeat();
    removeLifecycle?.();
    removeLifecycle = undefined;
    flushing = false;
    retryIndex = 0;
    lastMeta = "";
    bfcacheHiddenAt = null;
    if (!options || typeof options.endpoint !== "string") {
      throw new Error("endpoint is required");
    }
    endpoint = options.endpoint.trim().replace(/\/+$/, "");
    storagePrefix = `fm:${requireIdentifier(options.app ?? "default", "app")}:`;
    const source =
      typeof options.manifest === "string"
        ? await fetch(options.manifest).then((response) => {
            if (!response.ok) throw new Error("manifest fetch failed");
            return response.json() as Promise<unknown>;
          })
        : options.manifest;
    manifest = validateManifest(source);
    const now = Date.now();
    const savedSid = storageGet<unknown>("sid", null);
    const savedSeq = storageGet<unknown>("seq", null);
    const savedStep = storageGet<unknown>("step", null);
    const savedLastSeen = storageGet<unknown>("lastSeen", null);
    outbox = storageGet<TrackerEvent[]>("queue", []);
    const resumed =
      typeof savedSid === "string" &&
      Number.isInteger(savedSeq) &&
      typeof savedLastSeen === "number";
    session = resumed
      ? {
          sessionId: savedSid,
          seq: savedSeq as number,
          current: typeof savedStep === "string" ? savedStep : null,
          enteredAt: savedLastSeen,
          lastSeen: savedLastSeen,
          startedAt: startedAtFromSessionId(savedSid, savedLastSeen),
        }
      : {
          sessionId: randomId(now),
          seq: 0,
          current: null,
          enteredAt: now,
          lastSeen: now,
          startedAt: now,
        };
    if (!persist()) throw new Error("storage unavailable");
    active = true;
    attachLifecycle();
    enqueue(
      resumed
        ? {
            type: "session_start",
            resumed: true,
            awayMs: Math.max(0, now - savedLastSeen),
          }
        : { type: "session_start" },
    );
  } catch {
    fail();
  }
}

/**
 * Records the current manifest step and navigation direction.
 */
export function view(stepId: string, nav?: Nav, from?: string): void {
  try {
    if (
      !active ||
      session === null ||
      stepIndex(stepId) < 0 ||
      (from !== undefined && stepIndex(from) < 0)
    ) return;
    const prior = session.current;
    const direction =
      nav ??
      (prior !== null && stepIndex(stepId) < stepIndex(prior) ? "back" : "forward");
    if (direction !== "forward" && direction !== "back") return;
    session.current = stepId;
    session.enteredAt = Date.now();
    const payload: EventPayload =
      from === undefined
        ? { type: "page_view", step: stepId, nav: direction }
        : { type: "page_view", step: stepId, nav: direction, from };
    enqueue(payload, true);
  } catch {
    fail();
  }
}

/**
 * Records a retryable error code for a manifest step.
 */
export function error(stepId: string, code: string, attempt: number): void {
  try {
    if (
      !active ||
      stepIndex(stepId) < 0 ||
      !isIdentifier(code, CODE_MAX_LENGTH)
    ) return;
    enqueue({ type: "step_error", step: stepId, code, attempt }, true);
  } catch {
    fail();
  }
}

/**
 * Records completion of a manifest step.
 */
export function complete(stepId: string): void {
  try {
    if (!active || session === null || stepIndex(stepId) < 0) return;
    enqueue({
      type: "step_complete",
      step: stepId,
      elapsedMs: Math.max(0, Date.now() - session.enteredAt),
    });
  } catch {
    fail();
  }
}

/**
 * Records copying a named artifact, never its content.
 */
export function copy(artifactName: string): void {
  try {
    if (!active || !isIdentifier(artifactName)) return;
    enqueue({ type: "copy", artifact: artifactName });
  } catch {
    fail();
  }
}

/**
 * Records whether a paste result was accepted for a step.
 */
export function paste(stepId: string, ok: boolean): void {
  try {
    if (!active || stepIndex(stepId) < 0 || typeof ok !== "boolean") return;
    enqueue({ type: "paste_result", step: stepId, ok });
  } catch {
    fail();
  }
}

/**
 * Records successful completion of the full flow.
 */
export function shipped(): void {
  try {
    if (!active || session === null) return;
    enqueue({
      type: "shipped",
      totalMs: Math.max(0, Date.now() - session.startedAt),
    });
  } catch {
    fail();
  }
}

/**
 * Subscribes to deeply changed ingest metadata.
 */
export function onMeta(callback: MetaCallback): () => void {
  if (typeof callback !== "function") return () => undefined;
  callbacks.add(callback);
  return () => callbacks.delete(callback);
}
