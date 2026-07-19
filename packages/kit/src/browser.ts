import {
  createDashboardOverlay,
  type DashboardOptions,
  type DashboardOverlayHandle,
} from "./dashboard-overlay.js";
import {
  type Manifest,
  type ManifestStep,
  validateManifest,
} from "./manifest.js";
import {
  type FirstmileRoute,
  observeRoutes,
  validateRoutes,
} from "./route-observer.js";
import * as tracker from "./tracker.js";
import { requireIdentifier } from "./value-validation.js";

export type {
  DashboardOptions,
  FirstmileRoute,
  Manifest,
  ManifestStep,
};

export interface FirstmileOptions {
  manifest: Manifest;
  writeKey: string;
  sessionTimeoutMs?: number;
  endpoint?: string;
  app?: string;
  debug?: boolean;
  routes?: readonly FirstmileRoute[];
  dashboard?: DashboardOptions;
}

export interface FirstmileController {
  readonly ready: Promise<void>;
  view(step: string, nav?: "forward" | "back", from?: string): void;
  error(step: string, code: string, attempt: number): void;
  complete(step: string): void;
  copy(artifact: string): void;
  paste(step: string, ok: boolean): void;
  shipped(): void;
  openDashboard(): void;
  closeDashboard(): void;
  destroy(): void;
}

interface BrowserInstance {
  teardown(): void;
}

let activeInstance: BrowserInstance | undefined;

/**
 * Validates a manifest while preserving a convenient typed declaration.
 */
export function defineManifest<const Definition extends Manifest>(
  manifest: Definition,
): Definition {
  validateManifest(manifest);
  return manifest;
}

/**
 * Starts the browser SDK and returns a safe controller immediately.
 */
export function firstmile(options: FirstmileOptions): FirstmileController {
  activeInstance?.teardown();

  let live = true;
  let initialized = false;
  let removeRoutes: (() => void) | undefined;
  let overlay: DashboardOverlayHandle | undefined;
  const pending: Array<() => void> = [];
  let normalizedManifest: Manifest | undefined;
  let endpoint = "/__firstmile";

  const instance: BrowserInstance = {
    teardown(): void {
      if (!live) return;
      live = false;
      pending.length = 0;
      try {
        removeRoutes?.();
      } catch {
        // Continue removing independently owned resources.
      }
      removeRoutes = undefined;
      try {
        overlay?.destroy();
      } catch {
        // Continue removing independently owned resources.
      }
      overlay = undefined;
      if (activeInstance === instance) {
        activeInstance = undefined;
        tracker.destroy();
      }
    },
  };
  activeInstance = instance;

  const invoke = (operation: () => void): void => {
    try {
      if (!live || activeInstance !== instance) return;
      if (initialized) operation();
      else pending.push(operation);
    } catch {
      // Public browser methods never surface instrumentation failures.
    }
  };

  const ready = initialize(options, instance, {
    setConfig(manifest, nextEndpoint): void {
      normalizedManifest = manifest;
      endpoint = nextEndpoint;
    },
    finish(): void {
      if (!live || activeInstance !== instance || normalizedManifest === undefined) {
        return;
      }
      const routes = options.routes ?? [];
      if (routes.length > 0) {
        removeRoutes = observeRoutes(routes, normalizedManifest, tracker);
      }
      overlay = createDashboardOverlay(endpoint, options.dashboard);
      initialized = true;
      const queued = pending.splice(0);
      for (const operation of queued) operation();
    },
  });
  return {
    ready,
    view: (step, nav, from) => invoke(() => tracker.view(step, nav, from)),
    error: (step, code, attempt) =>
      invoke(() => tracker.error(step, code, attempt)),
    complete: (step) => invoke(() => tracker.complete(step)),
    copy: (artifact) => invoke(() => tracker.copy(artifact)),
    paste: (step, ok) => invoke(() => tracker.paste(step, ok)),
    shipped: () => invoke(() => tracker.shipped()),
    openDashboard: () => invoke(() => overlay?.open()),
    closeDashboard: () => invoke(() => overlay?.close()),
    destroy: () => instance.teardown(),
  };
}

interface InitializationHooks {
  setConfig(manifest: Manifest, endpoint: string): void;
  finish(): void;
}

async function initialize(
  options: FirstmileOptions,
  instance: BrowserInstance,
  hooks: InitializationHooks,
): Promise<void> {
  let shouldWarn = false;
  try {
    if (typeof options !== "object" || options === null) {
      throw new Error("options are required");
    }
    const manifest = validateManifest(options.manifest);
    const endpoint =
      options.endpoint === undefined ? "/__firstmile" : options.endpoint;
    if (typeof endpoint !== "string") throw new Error("endpoint must be a string");
    if (typeof options.writeKey !== "string" || options.writeKey.trim() === "") throw new Error("writeKey must be a non-empty string");
    if (options.routes !== undefined && !Array.isArray(options.routes)) {
      throw new Error("routes must be an array");
    }
    validateRoutes(options.routes ?? [], manifest);
    if (options.app !== undefined) requireIdentifier(options.app, "app");
    if (options.debug !== undefined && typeof options.debug !== "boolean") {
      throw new Error("debug must be a boolean");
    }
    if (options.sessionTimeoutMs !== undefined && (!Number.isSafeInteger(options.sessionTimeoutMs) || options.sessionTimeoutMs <= 0)) throw new Error("sessionTimeoutMs must be a positive safe integer");
    if (
      options.dashboard !== undefined &&
      (typeof options.dashboard !== "object" || options.dashboard === null)
    ) {
      throw new Error("dashboard must be an object");
    }
    if (
      options.dashboard?.enabled !== undefined &&
      typeof options.dashboard.enabled !== "boolean"
    ) {
      throw new Error("dashboard enabled must be a boolean");
    }
    if (
      options.dashboard?.defaultOpen !== undefined &&
      typeof options.dashboard.defaultOpen !== "boolean"
    ) {
      throw new Error("dashboard defaultOpen must be a boolean");
    }
    if (options.dashboard?.enabled === true && (typeof options.dashboard.token !== "string" || options.dashboard.token.trim() === "")) throw new Error("dashboard token is required when the overlay is enabled");
    hooks.setConfig(manifest, endpoint);
    await tracker.init({
      endpoint,
      manifest,
      writeKey: options.writeKey,
      ...(options.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: options.sessionTimeoutMs }),
      ...(options.app === undefined ? {} : { app: options.app }),
      ...(options.debug === undefined ? {} : { debug: options.debug }),
    });
    if (activeInstance !== instance) return;
    hooks.finish();
  } catch (error) {
    shouldWarn = options?.debug === true;
    if (activeInstance === instance) instance.teardown();
    if (shouldWarn) {
      try {
        const message =
          error instanceof Error ? error.message : "invalid configuration";
        console.warn(`firstmile browser SDK is disabled: ${message}`);
      } catch {
        // Logging cannot make invalid configuration observable as an exception.
      }
    }
  }
}
