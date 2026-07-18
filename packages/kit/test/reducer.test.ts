import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.js";
import {
  reduceEvent,
  type FirstmileEvent,
  type FirstmileEventPayload,
  type SessionState,
} from "../src/reducer.js";

const manifest: Manifest = {
  version: "v1",
  groups: ["start", "finish"],
  steps: [
    { id: "one", group: "start" },
    { id: "two", group: "start" },
    { id: "three", group: "finish" },
  ],
};

function event(
  seq: number,
  ts: number,
  value: FirstmileEventPayload,
): FirstmileEvent {
  return {
    sessionId: "session-1",
    seq,
    ts,
    manifestVersion: "v1",
    ...value,
  } as FirstmileEvent;
}

function apply(
  session: SessionState | undefined,
  nextEvent: FirstmileEvent,
): SessionState {
  return reduceEvent(session, nextEvent, manifest).session;
}

describe("reduceEvent", () => {
  it("drops a duplicate sequence without changing state", () => {
    const first = event(1, 100, { type: "session_start" });
    const session = apply(undefined, first);
    const result = reduceEvent(session, first, manifest);

    expect(result).toEqual({
      session,
      storedEvent: null,
      duplicate: true,
    });
    expect(result.session).toBe(session);
  });

  it("increments backtracks without lowering the high-water mark", () => {
    let session = apply(
      undefined,
      event(1, 100, { type: "session_start" }),
    );
    session = apply(
      session,
      event(2, 200, { type: "page_view", step: "three", nav: "forward" }),
    );
    session = apply(
      session,
      event(3, 300, {
        type: "page_view",
        step: "one",
        nav: "back",
        from: "three",
      }),
    );

    expect(session.step).toBe("one");
    expect(session.phase).toBe("entered");
    expect(session.attempt).toBe(0);
    expect(session.enteredStepAt).toBe(300);
    expect(session.backtracks).toBe(1);
    expect(session.maxStepIndex).toBe(2);
  });

  it("flags an earlier forward view and applies it to lastSeen only", () => {
    let session = apply(
      undefined,
      event(1, 100, { type: "page_view", step: "three", nav: "forward" }),
    );
    const before = session;
    const replay = event(2, 500, {
      type: "page_view",
      step: "one",
      nav: "forward",
    });
    const result = reduceEvent(session, replay, manifest);
    session = result.session;

    expect(result.storedEvent).toEqual({ ...replay, anomaly: true });
    expect(session).toMatchObject({
      step: before.step,
      phase: before.phase,
      enteredStepAt: before.enteredStepAt,
      maxStepIndex: before.maxStepIndex,
      lastSeen: 500,
      anomalies: 1,
    });
    expect(session.seqSeen).toEqual(new Set([1, 2]));
  });

  it("clears bye state and increments resumes", () => {
    let session = apply(
      undefined,
      event(1, 100, { type: "session_start" }),
    );
    session = apply(
      session,
      event(2, 200, { type: "heartbeat", visible: false }),
    );
    session = apply(session, event(3, 300, { type: "bye", persisted: true }));
    session = apply(
      session,
      event(4, 900, {
        type: "session_start",
        resumed: true,
        awayMs: 600,
      }),
    );

    expect(session.byeAt).toBeNull();
    expect(session.lastVisible).toBe(true);
    expect(session.resumes).toBe(1);
  });

  it("applies phases and lifecycle fields exactly", () => {
    let session = apply(
      undefined,
      event(1, 100, { type: "session_start" }),
    );
    session = apply(
      session,
      event(2, 200, { type: "page_view", step: "one", nav: "forward" }),
    );
    session = apply(
      session,
      event(3, 300, {
        type: "step_error",
        step: "one",
        code: "invalid",
        attempt: 2,
      }),
    );
    expect(session).toMatchObject({ phase: "error", attempt: 2 });

    session = apply(
      session,
      event(4, 400, {
        type: "step_complete",
        step: "one",
        elapsedMs: 200,
      }),
    );
    expect(session.phase).toBe("completed");

    session = apply(
      session,
      event(5, 500, { type: "heartbeat", visible: false }),
    );
    expect(session.lastVisible).toBe(false);

    session = apply(
      session,
      event(6, 600, { type: "shipped", totalMs: 500 }),
    );
    expect(session.shippedAt).toBe(600);
    expect(session.lastSeen).toBe(600);
  });

  it("flags every event after shipped and changes only anomaly bookkeeping", () => {
    let session = apply(
      undefined,
      event(1, 100, { type: "session_start" }),
    );
    session = apply(
      session,
      event(2, 200, { type: "shipped", totalMs: 100 }),
    );
    const late = event(3, 300, {
      type: "page_view",
      step: "two",
      nav: "forward",
    });
    const result = reduceEvent(session, late, manifest);

    expect(result.storedEvent).toEqual({ ...late, anomaly: true });
    expect(result.session).toMatchObject({
      step: null,
      shippedAt: 200,
      maxStepIndex: -1,
      lastSeen: 300,
      anomalies: 1,
    });
  });
});
