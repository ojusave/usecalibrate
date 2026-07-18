import type { Manifest } from "./manifest.js";
import { indexManifest } from "./manifest.js";

export type EventType =
  | "session_start"
  | "page_view"
  | "step_error"
  | "step_complete"
  | "copy"
  | "paste_result"
  | "heartbeat"
  | "shipped"
  | "bye";

interface EventEnvelope {
  sessionId: string;
  seq: number;
  ts: number;
  manifestVersion: string;
}

export type FirstmileEvent =
  | (EventEnvelope & {
      type: "session_start";
      resumed?: boolean;
      awayMs?: number;
    })
  | (EventEnvelope & {
      type: "page_view";
      step: string;
      nav: "forward" | "back";
      from?: string;
    })
  | (EventEnvelope & {
      type: "step_error";
      step: string;
      code: string;
      attempt: number;
    })
  | (EventEnvelope & {
      type: "step_complete";
      step: string;
      elapsedMs: number;
    })
  | (EventEnvelope & {
      type: "copy";
      artifact: string;
    })
  | (EventEnvelope & {
      type: "paste_result";
      step: string;
      ok: boolean;
    })
  | (EventEnvelope & {
      type: "heartbeat";
      visible: boolean;
    })
  | (EventEnvelope & {
      type: "shipped";
      totalMs: number;
    })
  | (EventEnvelope & {
      type: "bye";
      persisted: boolean;
    });

export type FirstmileEventPayload = FirstmileEvent extends infer Event
  ? Event extends FirstmileEvent
    ? Omit<Event, keyof EventEnvelope>
    : never
  : never;

export type SessionPhase = "entered" | "error" | "completed";

export interface SessionState {
  sessionId: string;
  step: string | null;
  phase: SessionPhase;
  attempt: number;
  enteredStepAt: number;
  lastSeen: number;
  startedAt: number;
  shippedAt: number | null;
  seqSeen: Set<number>;
  anomalies: number;
  lastVisible: boolean;
  byeAt: number | null;
  resumes: number;
  maxStepIndex: number;
  backtracks: number;
}

export type StoredEvent = FirstmileEvent & { anomaly?: true };

export interface ReducerResult {
  session: SessionState;
  storedEvent: StoredEvent | null;
  duplicate: boolean;
}

/**
 * Creates the exact initial session document for the first observed event.
 */
export function createSessionState(event: FirstmileEvent): SessionState {
  return {
    sessionId: event.sessionId,
    step: null,
    phase: "entered",
    attempt: 0,
    enteredStepAt: event.ts,
    lastSeen: event.ts,
    startedAt: event.ts,
    shippedAt: null,
    seqSeen: new Set<number>(),
    anomalies: 0,
    lastVisible: true,
    byeAt: null,
    resumes: 0,
    maxStepIndex: -1,
    backtracks: 0,
  };
}

/**
 * Checks the session-local sequence set used by the ingest boundary.
 */
export function isDuplicateEvent(
  session: SessionState,
  event: FirstmileEvent,
): boolean {
  return (
    session.sessionId === event.sessionId && session.seqSeen.has(event.seq)
  );
}

function isEarlierForwardView(
  session: SessionState,
  event: FirstmileEvent,
  stepIndexes: ReadonlyMap<string, number>,
): boolean {
  if (event.type !== "page_view" || event.nav === "back") {
    return false;
  }
  const currentIndex =
    session.step === null ? undefined : stepIndexes.get(session.step);
  const nextIndex = stepIndexes.get(event.step);
  return (
    currentIndex !== undefined &&
    nextIndex !== undefined &&
    nextIndex < currentIndex
  );
}

function copyWithSeen(
  session: SessionState,
  event: FirstmileEvent,
): SessionState {
  const seqSeen = new Set(session.seqSeen);
  seqSeen.add(event.seq);
  return { ...session, seqSeen, lastSeen: event.ts };
}

/**
 * Reduces one event without mutating the prior session.
 */
export function reduceEvent(
  current: SessionState | undefined,
  event: FirstmileEvent,
  manifest: Manifest,
): ReducerResult {
  const session = current ?? createSessionState(event);
  if (session.sessionId !== event.sessionId) {
    throw new Error("event sessionId does not match the session document");
  }
  if (isDuplicateEvent(session, event)) {
    return { session, storedEvent: null, duplicate: true };
  }

  const { stepIndexes } = indexManifest(manifest);
  const anomalous =
    session.shippedAt !== null ||
    isEarlierForwardView(session, event, stepIndexes);
  let next = copyWithSeen(session, event);

  if (anomalous) {
    next = { ...next, anomalies: next.anomalies + 1 };
    return {
      session: next,
      storedEvent: { ...event, anomaly: true },
      duplicate: false,
    };
  }

  switch (event.type) {
    case "session_start":
      if (event.resumed === true) {
        next = {
          ...next,
          byeAt: null,
          lastVisible: true,
          resumes: next.resumes + 1,
        };
      }
      break;
    case "page_view": {
      const stepIndex = stepIndexes.get(event.step);
      next = {
        ...next,
        step: event.step,
        phase: "entered",
        attempt: 0,
        enteredStepAt: event.ts,
        backtracks:
          next.backtracks + (event.nav === "back" ? 1 : 0),
        maxStepIndex:
          event.nav === "forward" && stepIndex !== undefined
            ? Math.max(next.maxStepIndex, stepIndex)
            : next.maxStepIndex,
      };
      break;
    }
    case "step_error":
      next = { ...next, phase: "error", attempt: event.attempt };
      break;
    case "step_complete":
      next = { ...next, phase: "completed" };
      break;
    case "heartbeat":
      next = { ...next, lastVisible: event.visible };
      break;
    case "shipped":
      next = { ...next, shippedAt: event.ts };
      break;
    case "bye":
      next = { ...next, byeAt: event.ts };
      break;
    case "copy":
    case "paste_result":
      break;
  }

  return { session: next, storedEvent: event, duplicate: false };
}
