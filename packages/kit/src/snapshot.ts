import type { Manifest } from "./manifest.js";
import type {
  FirstmileEvent,
  SessionState,
  StoredEvent,
} from "./reducer.js";

export const DEFAULT_PRESENCE_THRESHOLDS = {
  activeMs: 20_000,
  idleMs: 45_000,
  quietMs: 150_000,
} as const;

export interface PresenceThresholds {
  activeMs?: number;
  idleMs?: number;
  quietMs?: number;
}

export type Presence =
  | "active"
  | "idle"
  | "quiet"
  | "backgrounded"
  | "closed"
  | "bailed";

export type PresenceResult =
  | {
      presence: Exclude<Presence, "bailed">;
    }
  | {
      presence: "bailed";
      bailMode: "closed" | "silent";
    };

export interface SnapshotGroup {
  id: string;
  label: string;
  count: number;
  conversionFromPrev: number;
  conversionFromStart: number;
  medianMsInGroup: number | null;
}

export interface SnapshotStep {
  id: string;
  group: string;
  count: number;
  errorCount: number;
  backtracksFrom: number;
  returnsTo: number;
  medianMsInStep: number | null;
}

export interface DashboardSnapshot {
  manifestVersion: string;
  generatedAt: number;
  meta: unknown;
  totals: {
    started: number;
    shipped: number;
    activeNow: number;
    backgrounded: number;
    closed: number;
    bailed: number;
    backtracksTotal: number;
  };
  medianShipMs: number | null;
  groups: SnapshotGroup[];
  steps: SnapshotStep[];
  recentEvents: string[];
}

export interface SnapshotInput {
  manifest: Manifest;
  sessions: Iterable<SessionState>;
  events?: readonly StoredEvent[];
  generatedAt: number;
  meta?: unknown;
  presence?: PresenceThresholds;
}

/**
 * Derives lifecycle presence from a session and a caller-provided clock.
 */
export function derivePresence(
  session: SessionState,
  now: number,
  thresholds: PresenceThresholds = {},
): PresenceResult {
  const activeMs =
    thresholds.activeMs ?? DEFAULT_PRESENCE_THRESHOLDS.activeMs;
  const idleMs = thresholds.idleMs ?? DEFAULT_PRESENCE_THRESHOLDS.idleMs;
  const quietMs = thresholds.quietMs ?? DEFAULT_PRESENCE_THRESHOLDS.quietMs;

  if (activeMs < 0 || idleMs < activeMs || quietMs < idleMs) {
    throw new Error(
      "presence thresholds must be non-negative and ordered activeMs, idleMs, quietMs",
    );
  }

  const elapsed = Math.max(0, now - session.lastSeen);
  if (elapsed > quietMs) {
    return {
      presence: "bailed",
      bailMode: session.byeAt === null ? "silent" : "closed",
    };
  }
  if (session.byeAt !== null) {
    return { presence: "closed" };
  }
  if (!session.lastVisible) {
    return { presence: "backgrounded" };
  }
  if (elapsed < activeMs) {
    return { presence: "active" };
  }
  if (elapsed < idleMs) {
    return { presence: "idle" };
  }
  return { presence: "quiet" };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

interface EventMetrics {
  errors: Map<string, number>;
  backtracksFrom: Map<string, number>;
  returnsTo: Map<string, number>;
  stepDurations: Map<string, number[]>;
  groupDurations: Map<string, number[]>;
  shipDurations: number[];
}

function add(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function collectEventMetrics(
  manifest: Manifest,
  events: readonly StoredEvent[],
): EventMetrics {
  const errors = new Map<string, number>();
  const backtracksFrom = new Map<string, number>();
  const returnsTo = new Map<string, number>();
  const stepDurations = new Map<string, number[]>();
  const groupDurationBySession = new Map<string, Map<string, number>>();
  const completedBySession = new Map<string, Map<string, Set<string>>>();
  const shipDurations: number[] = [];
  const currentStep = new Map<string, string>();
  const groupByStep = new Map(
    manifest.steps.map((step) => [step.id, step.group]),
  );

  for (const event of events) {
    if (event.anomaly === true) {
      continue;
    }
    if (event.type === "page_view") {
      if (event.nav === "back") {
        const from = event.from ?? currentStep.get(event.sessionId);
        if (from !== undefined) {
          add(backtracksFrom, from);
        }
        add(returnsTo, event.step);
      }
      currentStep.set(event.sessionId, event.step);
    } else if (event.type === "step_error") {
      add(errors, event.step);
    } else if (event.type === "step_complete") {
      const durations = stepDurations.get(event.step) ?? [];
      durations.push(event.elapsedMs);
      stepDurations.set(event.step, durations);

      const group = groupByStep.get(event.step);
      if (group !== undefined) {
        const byGroup =
          groupDurationBySession.get(event.sessionId) ?? new Map<string, number>();
        byGroup.set(group, (byGroup.get(group) ?? 0) + event.elapsedMs);
        groupDurationBySession.set(event.sessionId, byGroup);
        const completedGroups =
          completedBySession.get(event.sessionId) ??
          new Map<string, Set<string>>();
        const completedSteps = completedGroups.get(group) ?? new Set<string>();
        completedSteps.add(event.step);
        completedGroups.set(group, completedSteps);
        completedBySession.set(event.sessionId, completedGroups);
      }
    } else if (event.type === "shipped") {
      shipDurations.push(event.totalMs);
    }
  }

  const groupDurations = new Map<string, number[]>();
  const stepsByGroup = new Map(
    manifest.groups.map((group) => [
      group,
      manifest.steps.filter((step) => step.group === group).map((step) => step.id),
    ]),
  );
  for (const [sessionId, byGroup] of groupDurationBySession) {
    for (const [group, duration] of byGroup) {
      const required = stepsByGroup.get(group) ?? [];
      const completed = completedBySession.get(sessionId)?.get(group);
      if (!required.every((step) => completed?.has(step) === true)) continue;
      const durations = groupDurations.get(group) ?? [];
      durations.push(duration);
      groupDurations.set(group, durations);
    }
  }

  return {
    errors,
    backtracksFrom,
    returnsTo,
    stepDurations,
    groupDurations,
    shipDurations,
  };
}

function collectSessionMetrics(
  manifest: Manifest,
  sessions: readonly SessionState[],
): EventMetrics {
  const errors = new Map<string, number>();
  const backtracksFrom = new Map<string, number>();
  const returnsTo = new Map<string, number>();
  const stepDurations = new Map<string, number[]>();
  const groupDurations = new Map<string, number[]>();
  const shipDurations: number[] = [];
  const stepIndexes = new Map(
    manifest.steps.map((step, index) => [step.id, index]),
  );
  for (const session of sessions) {
    if (session.step === null) {
      continue;
    }
    if (session.phase === "error") {
      add(errors, session.step);
    }
    const currentIndex = stepIndexes.get(session.step);
    if (
      currentIndex !== undefined &&
      currentIndex < session.maxStepIndex &&
      session.backtracks > 0
    ) {
      add(returnsTo, session.step);
    }

  }

  return {
    errors,
    backtracksFrom,
    returnsTo,
    stepDurations,
    groupDurations,
    shipDurations,
  };
}

function humanizeRecentEvents(
  events: readonly StoredEvent[],
  limit = 12,
): string[] {
  const messages: string[] = [];
  const currentStep = new Map<string, string>();

  for (const event of events) {
    if (event.anomaly === true) {
      continue;
    }
    let message: string | null = null;
    if (event.type === "page_view") {
      if (event.nav === "back") {
        const from = event.from ?? currentStep.get(event.sessionId);
        if (from !== undefined) {
          message = `someone went back from ${from} to ${event.step}`;
        }
      }
      currentStep.set(event.sessionId, event.step);
    } else if (event.type === "session_start" && event.resumed !== true) {
      message = "someone started";
    } else if (event.type === "step_error") {
      message = `someone failed ${event.step}, attempt ${event.attempt}`;
    } else if (event.type === "bye") {
      const step = currentStep.get(event.sessionId);
      if (step !== undefined) {
        message = `someone closed the tab on ${step}`;
      }
    } else if (
      event.type === "session_start" &&
      event.resumed === true &&
      event.awayMs !== undefined
    ) {
      message = `someone came back after ${Math.round(event.awayMs / 1000)}s away`;
    } else if (event.type === "shipped") {
      const seconds = Math.round(event.totalMs / 1000);
      message = `someone shipped in ${Math.floor(seconds / 60)}:${String(
        seconds % 60,
      ).padStart(2, "0")}`;
    }
    if (message !== null) {
      messages.push(message);
    }
  }

  return messages.slice(-limit).reverse();
}

/**
 * Builds a deterministic dashboard snapshot from state and stored events.
 */
export function buildSnapshot(input: SnapshotInput): DashboardSnapshot {
  const sessions = [...input.sessions];
  const events = input.events ?? [];
  const metrics =
    events.length === 0
      ? collectSessionMetrics(input.manifest, sessions)
      : collectEventMetrics(input.manifest, events);
  const startedSessionIds = new Set(
    events
      .filter(
        (event): event is Extract<FirstmileEvent, { type: "session_start" }> =>
          event.type === "session_start",
      )
      .map((event) => event.sessionId),
  );
  const started =
    events.length === 0 ? sessions.length : startedSessionIds.size;

  const presenceCounts = new Map<Presence, number>();
  for (const session of sessions) {
    const value = derivePresence(
      session,
      input.generatedAt,
      input.presence,
    ).presence;
    presenceCounts.set(value, (presenceCounts.get(value) ?? 0) + 1);
  }

  const stepCounts = input.manifest.steps.map((_, stepIndex) =>
    sessions.filter((session) => session.maxStepIndex >= stepIndex).length,
  );
  const firstStepByGroup = new Map<string, number>();
  input.manifest.steps.forEach((step, index) => {
    if (!firstStepByGroup.has(step.group)) {
      firstStepByGroup.set(step.group, index);
    }
  });

  let previousCount = started;
  const groups = input.manifest.groups.map((group): SnapshotGroup => {
    const firstStepIndex = firstStepByGroup.get(group);
    const count =
      firstStepIndex === undefined
        ? 0
        : sessions.filter(
            (session) => session.maxStepIndex >= firstStepIndex,
          ).length;
    const snapshotGroup = {
      id: group,
      label: group,
      count,
      conversionFromPrev: ratio(count, previousCount),
      conversionFromStart: ratio(count, started),
      medianMsInGroup: median(metrics.groupDurations.get(group) ?? []),
    };
    previousCount = count;
    return snapshotGroup;
  });

  return {
    manifestVersion: input.manifest.version,
    generatedAt: input.generatedAt,
    meta: input.meta ?? null,
    totals: {
      started,
      shipped: sessions.filter((session) => session.shippedAt !== null).length,
      activeNow:
        (presenceCounts.get("active") ?? 0) +
        (presenceCounts.get("idle") ?? 0),
      backgrounded: presenceCounts.get("backgrounded") ?? 0,
      closed: presenceCounts.get("closed") ?? 0,
      bailed: presenceCounts.get("bailed") ?? 0,
      backtracksTotal: sessions.reduce(
        (total, session) => total + session.backtracks,
        0,
      ),
    },
    medianShipMs: median(metrics.shipDurations),
    groups,
    steps: input.manifest.steps.map((step, index): SnapshotStep => ({
      id: step.id,
      group: step.group,
      count: stepCounts[index] ?? 0,
      errorCount: metrics.errors.get(step.id) ?? 0,
      backtracksFrom: metrics.backtracksFrom.get(step.id) ?? 0,
      returnsTo: metrics.returnsTo.get(step.id) ?? 0,
      medianMsInStep: median(metrics.stepDurations.get(step.id) ?? []),
    })),
    recentEvents: humanizeRecentEvents(events),
  };
}

export const createSnapshot = buildSnapshot;
