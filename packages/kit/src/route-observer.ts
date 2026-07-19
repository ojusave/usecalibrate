import type { Manifest } from "./manifest.js";

export interface FirstmileRoute {
  path: string;
  step: string;
  shipped?: boolean;
}

export interface RouteActions {
  view(step: string, nav?: "forward" | "back", from?: string): void;
  complete(step: string): void;
  shipped(): void;
}

/**
 * Normalizes a configured or current pathname for exact route matching.
 */
export function normalizePathname(path: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("route path must be an absolute pathname");
  }
  return path === "/" ? path : path.replace(/\/+$/, "");
}

/**
 * Rejects route declarations that cannot be matched without collecting URLs.
 */
export function validateRoutes(
  routes: readonly FirstmileRoute[],
  manifest: Manifest,
): void {
  const steps = new Set(manifest.steps.map((step) => step.id));
  const paths = new Set<string>();
  for (const route of routes) {
    if (typeof route !== "object" || route === null) {
      throw new Error("route must be an object");
    }
    const path = normalizePathname(route.path);
    if (!steps.has(route.step)) {
      throw new Error(`route references unknown step "${route.step}"`);
    }
    if (route.shipped !== undefined && typeof route.shipped !== "boolean") {
      throw new Error("route shipped must be a boolean");
    }
    if (paths.has(path)) throw new Error(`duplicate route path "${path}"`);
    paths.add(path);
  }
}

/**
 * Observes History API navigation and maps pathnames to manifest steps.
 */
export function observeRoutes(
  routes: readonly FirstmileRoute[],
  manifest: Manifest,
  actions: RouteActions,
): () => void {
  validateRoutes(routes, manifest);
  const stepIndexes = new Map(
    manifest.steps.map((step, index) => [step.id, index]),
  );
  const routeMap = new Map<string, FirstmileRoute>();
  for (const route of routes) {
    const path = normalizePathname(route.path);
    routeMap.set(path, { ...route, path });
  }

  let currentStep: string | undefined;
  let shipped = false;
  let active = true;

  const visit = (): void => {
    if (!active) return;
    let path: string;
    try {
      path = normalizePathname(window.location.pathname);
    } catch {
      return;
    }
    const route = routeMap.get(path);
    if (route === undefined || route.step === currentStep) return;

    const previous = currentStep;
    if (previous === undefined) {
      actions.view(route.step);
    } else {
      const previousIndex = stepIndexes.get(previous);
      const nextIndex = stepIndexes.get(route.step);
      if (previousIndex === undefined || nextIndex === undefined) return;
      if (nextIndex > previousIndex) {
        actions.complete(previous);
        actions.view(route.step, "forward", previous);
      } else {
        actions.view(route.step, "back", previous);
      }
    }
    currentStep = route.step;
    if (route.shipped === true && !shipped) {
      shipped = true;
      actions.shipped();
    }
  };

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const pushState: History["pushState"] = function (
    this: History,
    ...args: Parameters<History["pushState"]>
  ): ReturnType<History["pushState"]> {
    const result = originalPushState.apply(this, args);
    visit();
    return result;
  };
  const replaceState: History["replaceState"] = function (
    this: History,
    ...args: Parameters<History["replaceState"]>
  ): ReturnType<History["replaceState"]> {
    const result = originalReplaceState.apply(this, args);
    visit();
    return result;
  };
  const popstate = (): void => visit();

  history.pushState = pushState;
  history.replaceState = replaceState;
  window.addEventListener("popstate", popstate);
  visit();

  return () => {
    active = false;
    window.removeEventListener("popstate", popstate);
    if (history.pushState === pushState) history.pushState = originalPushState;
    if (history.replaceState === replaceState) {
      history.replaceState = originalReplaceState;
    }
  };
}
