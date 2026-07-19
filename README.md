# Firstmile

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Ffirstmile)
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=hero_cta) |
[GitHub repository](https://github.com/ojusave/firstmile)

## What Firstmile does

Firstmile is a self-hosted SDK for recording named positions and lifecycle signals in an onboarding flow. A browser app declares a manifest and route map, then sends events to a Firstmile collector that is already running.

The browser quickstart uses the default collector endpoint, `/__firstmile`:

```ts
import { firstmile } from "@firstmile/sdk";

const fm = firstmile({
  writeKey: "replace-with-browser-write-key",
  manifest: {
    version: "onboarding-v1",
    groups: ["signup", "activate"],
    steps: [
      { id: "account", group: "signup" },
      { id: "project", group: "activate" },
      { id: "success", group: "activate" }
    ]
  },
  routes: [
    { path: "/signup", step: "account" },
    { path: "/projects/new", step: "project" },
    { path: "/success", step: "success", shipped: true }
  ]
});

await fm.ready;
```

The browser import initializes tracking. It cannot launch a shared backend. Mount the collector in a Node and Hono server or run the standalone sidecar first.

## Installation

`@firstmile/sdk` has not been published to npm. To build and install a tarball from this checkout:

```sh
cd /Users/ojusave/Desktop/Samples/firstmile
npm ci
npm run build --workspace @firstmile/sdk
npm pack --workspace @firstmile/sdk
```

Then install the generated tarball in a consumer project:

```sh
npm install /Users/ojusave/Desktop/Samples/firstmile/firstmile-sdk-0.1.0.tgz
```

After the package is published, the intended installation command will be:

```sh
npm install @firstmile/sdk
```

The package is ESM-only. Browser use requires an ESM-aware bundler or runtime. Server and sidecar use require Node.js 20 or newer.

## Browser SDK with sidecar

Use the sidecar for static sites, non-Node applications, or applications that keep Firstmile outside the primary backend. Start it from this checkout:

```sh
ADMIN_TOKEN=replace-me \
DASHBOARD_TOKEN=replace-me-too \
WRITE_KEY=replace-with-browser-write-key \
ALLOWED_ORIGINS=http://localhost:3000 \
MANIFEST_JSON='{"version":"onboarding-v1","groups":["signup"],"steps":[{"id":"account","group":"signup"}]}' \
node packages/kit/dist/sidecar.js
```

Point the browser SDK at the already-running collector:

```ts
import { firstmile } from "@firstmile/sdk";

const fm = firstmile({
  endpoint: "http://localhost:8787",
  writeKey: "replace-with-browser-write-key",
  manifest: {
    version: "onboarding-v1",
    groups: ["signup"],
    steps: [{ id: "account", group: "signup" }]
  },
  routes: [{ path: "/signup", step: "account" }]
});
```

After installing the local tarball or a future published package, `npx firstmile-sidecar` starts the same executable. The sidecar requires distinct `ADMIN_TOKEN`, `DASHBOARD_TOKEN`, and `WRITE_KEY` values plus one manifest source. It also accepts `PORT`, `MANIFEST_JSON`, `MANIFEST_URL`, and `ALLOWED_ORIGINS`. If both manifest sources are set, `MANIFEST_JSON` takes precedence. `PORT` defaults to `8787`, and the server binds to `0.0.0.0`.

## Browser SDK with embedded Hono server

Mount the collector at `/__firstmile` so the browser SDK can use its default endpoint. This is the embedded server integration:

```ts
import { Hono } from "hono";
import { createFirstmile } from "@firstmile/sdk/server";

const app = new Hono();

const fm = createFirstmile({
  manifest,
  adminToken: process.env.ADMIN_TOKEN,
  dashboardToken: process.env.DASHBOARD_TOKEN,
  writeKey: process.env.WRITE_KEY,
  allowedOrigins: []
});

app.route("/__firstmile", fm.routes);
```

The browser setup then needs no `endpoint` option:

```ts
firstmile({
  manifest,
  writeKey: window.FIRSTMILE_WRITE_KEY,
  routes,
  dashboard: { enabled: true, token: window.FIRSTMILE_DASHBOARD_TOKEN }
});
```

`createFirstmile` provides Hono routes for ingestion, the public manifest, dashboard data, the projector, protected JSONL export, and health checks. The host application remains responsible for starting and serving Hono.

## Automatic route configuration

Routes map exact pathnames to manifest step IDs:

```ts
const fm = firstmile({
  manifest,
  writeKey: "replace-with-browser-write-key",
  routes: [
    { path: "/signup", step: "account" },
    { path: "/projects/new", step: "project" },
    { path: "/success", step: "success", shipped: true }
  ]
});
```

Firstmile checks the current pathname after initialization and observes `pushState`, `replaceState`, and `popstate`. It normalizes trailing slashes, ignores query strings and hashes, ignores unmapped routes, and does not create history entries. Moving forward completes the previous step. Moving backward records a back view without completing the previous step. A route marked `shipped` records shipment once for that SDK instance.

The observer uses the actual pathname only for local exact matching. Events contain the configured step ID, never the pathname or full URL.

## Manual controller events

Routes are optional. The returned controller supports manual instrumentation:

```ts
const fm = firstmile({ manifest, writeKey: "replace-with-browser-write-key" });

await fm.ready;
fm.view("account");
fm.error("account", "email_rejected", 1);
fm.complete("account");
fm.copy("api_key");
fm.paste("project", true);
fm.shipped();
fm.openDashboard();
fm.closeDashboard();
fm.destroy();
```

`view(step, nav?, from?)` records position and can infer direction from manifest order. `error` records a bounded machine code and attempt number. `complete` records elapsed time for a step. `copy` records an artifact name, not clipboard content. `paste` records only whether the host accepted the result. `shipped` records flow completion. `openDashboard` and `closeDashboard` control an enabled overlay. `destroy` stops this SDK instance without clearing its persisted browser session or outbox.

Calls made before `ready` resolves are queued safely. Starting another `firstmile()` instance replaces the active instance on that page.

For direct access to the original low-level API, import `@firstmile/sdk/tracker`. Its `init` function requires an explicit endpoint and retains `endpoint: ""` for same-origin collection.

## In-app dashboard

The dashboard overlay is disabled by default. Enable it explicitly:

```ts
const fm = firstmile({
  manifest,
  writeKey: "replace-with-browser-write-key",
  dashboard: {
    enabled: true,
    defaultOpen: false,
    token: "replace-with-dashboard-token"
  }
});
```

The SDK adds a Shadow DOM launcher and an iframe for the collector's `/present` route. `openDashboard()` and `closeDashboard()` control the panel, and `destroy()` removes it.

Dashboard data requires `DASHBOARD_TOKEN`; export requires `ADMIN_TOKEN`; ingestion requires `WRITE_KEY`. The overlay places the dashboard token in the iframe URL fragment, which browsers do not send in HTTP requests. Treat both browser credentials as scoped workshop secrets, restrict CORS, and rotate them if disclosed. Never put `ADMIN_TOKEN` in browser code.

## Plain HTML integration

The framework-free example uses the low-level IIFE build and a standalone sidecar. Follow the copy-paste instructions in [`examples/plain-html`](examples/plain-html/README.md). This path is useful when there is no module bundler. It does not exercise the high-level `firstmile()` facade.

## Privacy guarantees

Firstmile records named positions and a closed set of lifecycle signals. The SDK never reads typed values, textarea values, clipboard contents, or DOM text. Integrators must still use fixed machine identifiers and must not pass user-provided values into identifier fields.

The route observer does not send query parameters, hashes, pathnames, or arbitrary URLs. It sends only step IDs declared by the integrator. Identifiers are bounded and validated at ingestion, and events containing arbitrary fields are omitted. Browser state uses a namespaced localStorage session and outbox. Firstmile does not modify cookies.

## Render sidecar deployment

The repository's [`render.yaml`](render.yaml) defines one Render web service with Node 20 and `/healthz`. Automatic deploys and preview environments are disabled for the private beta. Set `MANIFEST_JSON` and `ALLOWED_ORIGINS` when creating the Blueprint. Render generates all three credentials.

[Deploy the sidecar to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Ffirstmile) or read the [Deploy to Render documentation](https://render.com/docs/deploy-to-render-button). After deployment, set the browser SDK's `endpoint` to the sidecar's public HTTPS URL. The repository is currently private, so the deploying Render account must have access to it.

[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=footer_link)

## Current v0.1 limitations

- The collector stores sessions and events in memory in one process.
- State resets on deploy, restart, or process failure. There is no persistence backend.
- Multiple collector instances do not coordinate state. Run one instance.
- The write and dashboard credentials are intentionally browser-visible and provide workshop isolation, not user authentication.
- The collector applies bounded request, batch, session, event, and 24-hour retention defaults. Tune `limits` for embedded deployments.
- The package is ESM-only, and server usage requires Node.js 20 or newer.
- The API is pre-1.0 and may change.
- `@firstmile/sdk` has not been published to npm.
- The GitHub repository is private.
- No license has been selected.

License: to be decided before public release.
