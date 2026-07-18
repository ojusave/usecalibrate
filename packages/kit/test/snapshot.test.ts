import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.js";
import type {
  FirstmileEventPayload,
  SessionState,
  StoredEvent,
} from "../src/reducer.js";
import { buildSnapshot, derivePresence } from "../src/snapshot.js";

const manifest: Manifest = {
  version: "v1",
  groups: ["signup", "activate"],
  steps: [
    { id: "email", group: "signup" },
    { id: "plan", group: "signup" },
    { id: "deploy", group: "activate" },
  ],
};

function session(
  id: string,
  values: Partial<SessionState> = {},
): SessionState {
  return {
    sessionId: id,
    step: "email",
    phase: "entered",
    attempt: 0,
    enteredStepAt: 0,
    lastSeen: 1_000,
    startedAt: 0,
    shippedAt: null,
    seqSeen: new Set(),
    anomalies: 0,
    lastVisible: true,
    byeAt: null,
    resumes: 0,
    maxStepIndex: 0,
    backtracks: 0,
    ...values,
  };
}

function event(
  sessionId: string,
  seq: number,
  value: FirstmileEventPayload,
): StoredEvent {
  return {
    sessionId,
    seq,
    ts: seq * 100,
    manifestVersion: "v1",
    ...value,
  } as StoredEvent;
}

describe("derivePresence", () => {
  const now = 200_000;

  it.each([
    ["active", session("a", { lastSeen: now - 19_999 })],
    ["idle", session("i", { lastSeen: now - 20_000 })],
    ["quiet", session("q", { lastSeen: now - 45_000 })],
    [
      "backgrounded",
      session("bg", { lastSeen: now - 10_000, lastVisible: false }),
    ],
    ["closed", session("c", { lastSeen: now - 10_000, byeAt: now - 10_000 })],
    ["bailed", session("b", { lastSeen: now - 150_001 })],
  ] as const)("derives %s with a fake clock", (expected, value) => {
    expect(derivePresence(value, now).presence).toBe(expected);
  });

  it("records closed and silent bail modes", () => {
    expect(
      derivePresence(
        session("closed", {
          lastSeen: now - 150_001,
          byeAt: now - 160_000,
        }),
        now,
      ),
    ).toEqual({ presence: "bailed", bailMode: "closed" });
    expect(
      derivePresence(
        session("silent", { lastSeen: now - 150_001 }),
        now,
      ),
    ).toEqual({ presence: "bailed", bailMode: "silent" });
  });

  it("honors configurable ordered thresholds", () => {
    const value = session("custom", { lastSeen: now - 25 });
    expect(
      derivePresence(value, now, {
        activeMs: 10,
        idleMs: 20,
        quietMs: 30,
      }).presence,
    ).toBe("quiet");
    expect(() =>
      derivePresence(value, now, {
        activeMs: 30,
        idleMs: 20,
      }),
    ).toThrow("presence thresholds must be non-negative and ordered");
  });
});

describe("buildSnapshot", () => {
  it("derives returns from session state when no event stream is provided", () => {
    const snapshot = buildSnapshot({
      manifest,
      sessions: [
        session("returned", {
          step: "email",
          maxStepIndex: 2,
          backtracks: 1,
          phase: "error",
          enteredStepAt: 100,
          lastSeen: 400,
        }),
      ],
      generatedAt: 400,
    });

    expect(snapshot.steps[0]).toMatchObject({
      errorCount: 1,
      returnsTo: 1,
      medianMsInStep: null,
    });
  });

  it("calculates high-water funnels, conversions, returns, and medians", () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      session(`s${index}`, {
        step: index === 0 ? "plan" : "email",
        maxStepIndex: index < 5 ? 2 : index < 8 ? 1 : 0,
        backtracks: index === 0 ? 1 : 0,
        shippedAt: index < 4 ? 1_000 + index * 100 : null,
      }),
    );
    const events: StoredEvent[] = sessions.flatMap((value) => [
      event(value.sessionId, 1, { type: "session_start" }),
      event(value.sessionId, 2, {
        type: "page_view",
        step: "email",
        nav: "forward",
      }),
    ]);
    events.push(
      event("s0", 3, {
        type: "page_view",
        step: "deploy",
        nav: "forward",
      }),
      event("s0", 4, {
        type: "step_complete",
        step: "deploy",
        elapsedMs: 400,
      }),
      event("s0", 5, {
        type: "page_view",
        step: "plan",
        nav: "back",
      }),
      event("s1", 3, {
        type: "step_error",
        step: "email",
        code: "invalid",
        attempt: 1,
      }),
      event("s1", 4, {
        type: "step_complete",
        step: "email",
        elapsedMs: 200,
      }),
      event("s2", 3, {
        type: "step_complete",
        step: "email",
        elapsedMs: 400,
      }),
      event("s1", 5, {
        type: "step_complete",
        step: "plan",
        elapsedMs: 600,
      }),
      event("s2", 4, {
        type: "step_complete",
        step: "plan",
        elapsedMs: 800,
      }),
      event("s0", 6, { type: "shipped", totalMs: 900 }),
      event("s1", 6, { type: "shipped", totalMs: 1_100 }),
      event("s2", 5, { type: "shipped", totalMs: 1_300 }),
      event("s3", 3, { type: "shipped", totalMs: 1_500 }),
    );

    const snapshot = buildSnapshot({
      manifest,
      sessions,
      events,
      generatedAt: 1_000,
      meta: { mode: "live" },
    });

    expect(snapshot.groups).toEqual([
      {
        id: "signup",
        label: "signup",
        count: 10,
        conversionFromPrev: 1,
        conversionFromStart: 1,
        medianMsInGroup: 1_000,
      },
      {
        id: "activate",
        label: "activate",
        count: 5,
        conversionFromPrev: 0.5,
        conversionFromStart: 0.5,
        medianMsInGroup: 400,
      },
    ]);
    expect(snapshot.steps).toEqual([
      {
        id: "email",
        group: "signup",
        count: 10,
        errorCount: 1,
        backtracksFrom: 0,
        returnsTo: 0,
        medianMsInStep: 300,
      },
      {
        id: "plan",
        group: "signup",
        count: 8,
        errorCount: 0,
        backtracksFrom: 0,
        returnsTo: 1,
        medianMsInStep: 700,
      },
      {
        id: "deploy",
        group: "activate",
        count: 5,
        errorCount: 0,
        backtracksFrom: 1,
        returnsTo: 0,
        medianMsInStep: 400,
      },
    ]);
    expect(snapshot.totals).toMatchObject({
      started: 10,
      shipped: 4,
      activeNow: 10,
      backtracksTotal: 1,
    });
    expect(snapshot.medianShipMs).toBe(1_200);
    expect(snapshot.meta).toEqual({ mode: "live" });
  });

  it("counts all lifecycle buckets and humanizes the last events", () => {
    const now = 200_000;
    const sessions = [
      session("active", { lastSeen: now - 1 }),
      session("idle", { lastSeen: now - 20_000 }),
      session("quiet", { lastSeen: now - 45_000 }),
      session("background", { lastSeen: now - 1, lastVisible: false }),
      session("closed", { lastSeen: now - 1, byeAt: now - 1 }),
      session("bailed", { lastSeen: now - 150_001 }),
    ];
    const events: StoredEvent[] = [
      event("active", 0, { type: "session_start" }),
      event("active", 1, {
        type: "page_view",
        step: "email",
        nav: "forward",
      }),
      event("active", 2, {
        type: "page_view",
        step: "plan",
        nav: "forward",
      }),
      event("active", 3, {
        type: "page_view",
        step: "email",
        nav: "back",
        from: "plan",
      }),
      event("active", 4, {
        type: "step_error",
        step: "email",
        code: "invalid",
        attempt: 3,
      }),
      event("active", 5, { type: "bye", persisted: true }),
      event("active", 6, {
        type: "session_start",
        resumed: true,
        awayMs: 94_000,
      }),
      event("active", 7, { type: "shipped", totalMs: 94_000 }),
    ];

    const snapshot = buildSnapshot({
      manifest,
      sessions,
      events,
      generatedAt: now,
    });

    expect(snapshot.totals).toMatchObject({
      activeNow: 2,
      backgrounded: 1,
      closed: 1,
      bailed: 1,
    });
    expect(snapshot.recentEvents).toEqual([
      "someone shipped in 1:34",
      "someone came back after 94s away",
      "someone closed the tab on email",
      "someone failed email, attempt 3",
      "someone went back from plan to email",
      "someone started",
    ]);
  });

  it("does not include anomalous events in historical metrics", () => {
    const anomalous = {
      ...event("s", 1, {
        type: "step_error",
        step: "email",
        code: "late",
        attempt: 1,
      }),
      anomaly: true as const,
    };
    const snapshot = buildSnapshot({
      manifest,
      sessions: [session("s")],
      events: [anomalous],
      generatedAt: 1_000,
    });

    expect(snapshot.steps[0]?.errorCount).toBe(0);
    expect(snapshot.recentEvents).toEqual([]);
  });
});
