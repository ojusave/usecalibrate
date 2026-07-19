// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePathname,
  observeRoutes,
  validateRoutes,
} from "../src/route-observer.js";

const manifest = {
  version: "v1",
  groups: ["flow"],
  steps: [
    { id: "start", group: "flow" },
    { id: "details", group: "flow" },
    { id: "done", group: "flow" },
  ],
};

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  history.replaceState(null, "", "/");
});

describe("route observer", () => {
  it("normalizes pathnames and rejects unsafe or duplicate routes", () => {
    expect(normalizePathname("/details///")).toBe("/details");
    expect(normalizePathname("/")).toBe("/");
    expect(() => normalizePathname("/details?email=private")).toThrow();
    expect(() =>
      validateRoutes(
        [
          { path: "/details", step: "details" },
          { path: "/details/", step: "done" },
        ],
        manifest,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      validateRoutes([{ path: "/missing", step: "unknown" }], manifest),
    ).toThrow(/unknown step/);
  });

  it("observes initial, push, replace, and popstate navigation", () => {
    history.replaceState(null, "", "/start?secret=one#private");
    const actions = {
      view: vi.fn(),
      complete: vi.fn(),
      shipped: vi.fn(),
    };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    stop = observeRoutes(
      [
        { path: "/start", step: "start" },
        { path: "/details", step: "details" },
        { path: "/done", step: "done", shipped: true },
      ],
      manifest,
      actions,
    );

    expect(actions.view).toHaveBeenNthCalledWith(1, "start");
    expect(history.length).toBeGreaterThan(0);
    expect(history.pushState({ value: 1 }, "", "/details?private=value")).toBe(
      undefined,
    );
    history.replaceState({ value: 2 }, "", "/done#secret");
    history.replaceState(null, "", "/details");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(actions.complete).toHaveBeenNthCalledWith(1, "start");
    expect(actions.complete).toHaveBeenNthCalledWith(2, "details");
    expect(actions.view).toHaveBeenNthCalledWith(
      2,
      "details",
      "forward",
      "start",
    );
    expect(actions.view).toHaveBeenNthCalledWith(
      3,
      "done",
      "forward",
      "details",
    );
    expect(actions.view).toHaveBeenNthCalledWith(
      4,
      "details",
      "back",
      "done",
    );
    expect(actions.shipped).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(actions.view.mock.calls)).not.toContain("private");
    expect(JSON.stringify(actions.view.mock.calls)).not.toContain("secret");

    stop();
    stop = undefined;
    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
  });

  it("ignores unmapped and repeated steps and preserves newer wrappers", () => {
    history.replaceState(null, "", "/start");
    const originalPush = history.pushState;
    const actions = {
      view: vi.fn(),
      complete: vi.fn(),
      shipped: vi.fn(),
    };
    stop = observeRoutes(
      [
        { path: "/start", step: "start" },
        { path: "/alias", step: "start" },
      ],
      manifest,
      actions,
    );
    history.pushState(null, "", "/unknown");
    history.pushState(null, "", "/alias");
    expect(actions.view).toHaveBeenCalledTimes(1);

    const newer = vi.fn(history.pushState);
    history.pushState = newer;
    stop();
    stop = undefined;
    expect(history.pushState).toBe(newer);
    const viewCount = actions.view.mock.calls.length;
    history.pushState(null, "", "/alias");
    expect(actions.view).toHaveBeenCalledTimes(viewCount);
    history.pushState = originalPush;
  });

  it("returns original history results and deactivates retained wrappers", () => {
    history.replaceState(null, "", "/start");
    const nativePush = history.pushState;
    const result = { preserved: true };
    history.pushState = function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ): object {
      nativePush.apply(this, args);
      return result;
    };
    const actions = {
      view: vi.fn(),
      complete: vi.fn(),
      shipped: vi.fn(),
    };
    stop = observeRoutes(
      [
        { path: "/start", step: "start" },
        { path: "/details", step: "details" },
      ],
      manifest,
      actions,
    );
    const retained = history.pushState;

    expect(
      (
        retained as unknown as (
          this: History,
          data: unknown,
          unused: string,
          url: string,
        ) => unknown
      ).call(history, null, "", "/details"),
    ).toBe(result);
    const viewCount = actions.view.mock.calls.length;
    stop();
    stop = undefined;
    retained.call(history, null, "", "/start");
    expect(actions.view).toHaveBeenCalledTimes(viewCount);
    history.pushState = nativePush;
  });
});
