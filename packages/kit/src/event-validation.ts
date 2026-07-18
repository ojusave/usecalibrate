import type { FirstmileEvent } from "./reducer.js";
import {
  CODE_MAX_LENGTH,
  requireIdentifier,
} from "./value-validation.js";

type EventShape = Readonly<Record<string, "string" | "number" | "boolean">>;

const envelope: EventShape = {
  sessionId: "string",
  seq: "number",
  ts: "number",
  manifestVersion: "string",
  type: "string",
};

const shapes = {
  session_start: { resumed: "boolean", awayMs: "number" },
  page_view: { step: "string", nav: "string", from: "string" },
  step_error: { step: "string", code: "string", attempt: "number" },
  step_complete: { step: "string", elapsedMs: "number" },
  copy: { artifact: "string" },
  paste_result: { step: "string", ok: "boolean" },
  heartbeat: { visible: "boolean" },
  shipped: { totalMs: "number" },
  bye: { persisted: "boolean" },
} as const satisfies Record<string, EventShape>;

const requiredPayloadKeys: Readonly<Record<keyof typeof shapes, readonly string[]>> = {
  session_start: [],
  page_view: ["step", "nav"],
  step_error: ["step", "code", "attempt"],
  step_complete: ["step", "elapsedMs"],
  copy: ["artifact"],
  paste_result: ["step", "ok"],
  heartbeat: ["visible"],
  shipped: ["totalMs"],
  bye: ["persisted"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasExpectedType(
  value: unknown,
  expected: "string" | "number" | "boolean",
): boolean {
  return expected === "number"
    ? isFiniteNumber(value)
    : typeof value === expected;
}

/**
 * Validates the closed position-only event vocabulary at the HTTP boundary.
 */
export function validateEvent(value: unknown): FirstmileEvent {
  if (!isRecord(value)) {
    throw new Error("event must be an object");
  }
  if (
    typeof value.type !== "string" ||
    !Object.prototype.hasOwnProperty.call(shapes, value.type)
  ) {
    throw new Error("event type is not recognized");
  }

  const type = value.type as keyof typeof shapes;
  const shape: EventShape = { ...envelope, ...shapes[type] };
  const allowedKeys = new Set(Object.keys(shape));
  const extraKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (extraKey !== undefined) {
    throw new Error(`event contains unknown field "${extraKey}"`);
  }

  for (const key of Object.keys(envelope)) {
    if (!hasExpectedType(value[key], envelope[key] ?? "string")) {
      throw new Error(`event field "${key}" has the wrong type`);
    }
  }
  for (const key of requiredPayloadKeys[type]) {
    const expected = shape[key];
    if (expected === undefined || !hasExpectedType(value[key], expected)) {
      throw new Error(`event field "${key}" has the wrong type`);
    }
  }
  for (const [key, expected] of Object.entries(shapes[type])) {
    if (
      value[key] !== undefined &&
      !hasExpectedType(value[key], expected)
    ) {
      throw new Error(`event field "${key}" has the wrong type`);
    }
  }

  if (!Number.isInteger(value.seq) || (value.seq as number) < 0) {
    throw new Error('event field "seq" must be a non-negative integer');
  }
  if (type === "page_view" && value.nav !== "forward" && value.nav !== "back") {
    throw new Error('event field "nav" must be "forward" or "back"');
  }
  requireIdentifier(value.sessionId, 'event field "sessionId"');
  requireIdentifier(value.manifestVersion, 'event field "manifestVersion"');
  if ("step" in value) {
    requireIdentifier(value.step, 'event field "step"');
  }
  if ("from" in value && value.from !== undefined) {
    requireIdentifier(value.from, 'event field "from"');
  }
  if ("artifact" in value) {
    requireIdentifier(value.artifact, 'event field "artifact"');
  }
  if ("code" in value) {
    requireIdentifier(value.code, 'event field "code"', CODE_MAX_LENGTH);
  }

  return value as unknown as FirstmileEvent;
}

/**
 * Accepts a structurally valid batch and returns each schema-valid event.
 * Invalid siblings are omitted so valid events are still recorded.
 */
export function validateEventBatch(value: unknown): FirstmileEvent[] {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value) &&
        Object.keys(value).length === 1 &&
        Array.isArray(value.events)
      ? value.events
      : null;
  if (candidates === null) {
    throw new Error("request body must be an event array or { events: [] }");
  }
  const valid: FirstmileEvent[] = [];
  for (const event of candidates) {
    try {
      valid.push(validateEvent(event));
    } catch {
      // Record-never-reject applies independently to each valid sibling.
    }
  }
  return valid;
}
