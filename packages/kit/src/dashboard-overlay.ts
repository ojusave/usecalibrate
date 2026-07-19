export interface DashboardOptions {
  enabled?: boolean;
  defaultOpen?: boolean;
  token?: string;
}

export interface DashboardOverlayHandle {
  open(): void;
  close(): void;
  destroy(): void;
}

let activeOverlay: DashboardOverlayHandle | undefined;

const disabledOverlay: DashboardOverlayHandle = {
  open: () => undefined,
  close: () => undefined,
  destroy: () => undefined,
};

/**
 * Builds the dashboard presentation URL without adding credentials.
 */
export function dashboardUrl(endpoint: string, token?: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  const path = base === "" ? "/present" : `${base}/present`;
  return token === undefined ? path : `${path}#token=${encodeURIComponent(token)}`;
}

/**
 * Injects an isolated dashboard launcher and modal iframe.
 */
export function createDashboardOverlay(
  endpoint: string,
  options: DashboardOptions = {},
): DashboardOverlayHandle {
  activeOverlay?.destroy();
  if (options.enabled !== true) {
    activeOverlay = undefined;
    return disabledOverlay;
  }
  if (typeof options.token !== "string" || options.token.trim() === "") throw new Error("dashboard token is required when the overlay is enabled");
  const host = document.createElement("div");
  host.dataset.firstmileDashboard = "";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { font: 14px/1.4 system-ui, sans-serif; }
      button { font: inherit; }
      .launch {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
        min-height: 44px; padding: 0 16px; border: 0; border-radius: 8px;
        color: white; background: #111; cursor: pointer;
      }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483647; padding: 24px;
        display: grid; place-items: center; background: rgb(0 0 0 / 55%);
      }
      .backdrop[hidden] { display: none; }
      .panel {
        width: min(1100px, 100%); height: min(760px, 100%);
        display: grid; grid-template-rows: auto 1fr; overflow: hidden;
        border-radius: 10px; background: white; box-shadow: 0 20px 60px rgb(0 0 0 / 35%);
      }
      .bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
      .close { min-width: 44px; min-height: 44px; border: 0; background: transparent; cursor: pointer; }
      iframe { width: 100%; height: 100%; border: 0; background: white; }
      @media (max-width: 640px) {
        .backdrop { padding: 0; }
        .panel { width: 100%; height: 100%; border-radius: 0; }
      }
    </style>
    <button class="launch" type="button" aria-haspopup="dialog"
      aria-controls="firstmile-dashboard-panel" aria-expanded="false">
      Dashboard
    </button>
    <div class="backdrop" hidden>
      <section class="panel" id="firstmile-dashboard-panel" role="dialog"
        aria-modal="true" aria-labelledby="firstmile-dashboard-title">
        <div class="bar">
          <strong id="firstmile-dashboard-title">Firstmile dashboard</strong>
          <button class="close" type="button" aria-label="Close dashboard">Close</button>
        </div>
        <iframe title="Firstmile dashboard" src="${escapeAttribute(dashboardUrl(endpoint, options.token))}"></iframe>
      </section>
    </div>
  `;
  document.body.append(host);

  const launch = requiredElement<HTMLButtonElement>(shadow, ".launch");
  const close = requiredElement<HTMLButtonElement>(shadow, ".close");
  const backdrop = requiredElement<HTMLDivElement>(shadow, ".backdrop");
  const frame = requiredElement<HTMLIFrameElement>(shadow, "iframe");

  const setOpen = (open: boolean, restoreFocus: boolean): void => {
    backdrop.hidden = !open;
    launch.setAttribute("aria-expanded", String(open));
    if (open) close.focus();
    else if (restoreFocus) launch.focus();
  };
  const open = (): void => setOpen(true, false);
  const dismiss = (): void => setOpen(false, true);
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !backdrop.hidden) {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Tab" && !backdrop.hidden) {
      const active = shadow.activeElement;
      if (event.shiftKey && active === close) {
        event.preventDefault();
        frame.focus();
      } else if (!event.shiftKey && active === frame) {
        event.preventDefault();
        close.focus();
      }
    }
  };
  launch.addEventListener("click", open);
  close.addEventListener("click", dismiss);
  document.addEventListener("keydown", keydown);

  const instance: DashboardOverlayHandle = {
    open(): void {
      if (activeOverlay === instance) setOpen(true, false);
    },
    close(): void {
      if (activeOverlay === instance) setOpen(false, true);
    },
    destroy(): void {
      if (activeOverlay !== instance) return;
      activeOverlay = undefined;
      document.removeEventListener("keydown", keydown);
      launch.removeEventListener("click", open);
      close.removeEventListener("click", dismiss);
      host.remove();
    },
  };
  activeOverlay = instance;
  if (options.defaultOpen === true) setOpen(true, false);
  return instance;
}

function requiredElement<T extends Element>(
  root: ShadowRoot,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing overlay element ${selector}`);
  return element;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}
