# @firstmile/sdk

`@firstmile/sdk` is an ESM-only browser and Node package for recording named onboarding positions and lifecycle signals. The browser API sends events to an existing embedded collector or standalone sidecar. It cannot start a shared backend.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Ffirstmile)
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=hero_cta) |
[GitHub repository](https://github.com/ojusave/firstmile)

## Installation

This package has not been published to npm. In the repository checkout, build and pack it:

```sh
cd /Users/ojusave/Desktop/Samples/firstmile
npm ci
npm run build --workspace @firstmile/sdk
npm pack --workspace @firstmile/sdk
```

Install the resulting tarball in another project:

```sh
npm install /Users/ojusave/Desktop/Samples/firstmile/firstmile-sdk-0.1.0.tgz
```

After publication, the intended command will be:

```sh
npm install @firstmile/sdk
```

Browser use needs an ESM-aware bundler or runtime. The server and sidecar require Node.js 20 or newer.

## Browser quickstart

The root export is browser-safe. It defaults to the collector endpoint `/__firstmile`:

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
  ],
  dashboard: {
    enabled: true,
    defaultOpen: false,
    token: "replace-with-dashboard-token"
  }
});

await fm.ready;
```

The collector must already exist. For a separate sidecar, set `endpoint` to its origin:

```ts
const fm = firstmile({
  endpoint: "https://firstmile-sidecar.example",
  writeKey: "replace-with-browser-write-key",
  manifest,
  routes
});
```

## Embedded Hono collector

Mount the server routes at the default browser endpoint:

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

The browser SDK then uses its default:

```ts
firstmile({
  manifest,
  writeKey: window.FIRSTMILE_WRITE_KEY,
  routes,
  dashboard: { enabled: true, token: window.FIRSTMILE_DASHBOARD_TOKEN }
});
```

The host is responsible for starting Hono. `createFirstmile` exposes credentialed ingestion at `/api/events`, the manifest at `/api/manifest`, protected aggregates at `/api/dashboard`, the projector at `/present`, bearer-protected JSONL export at `/export`, and `/healthz`.

## Standalone sidecar

After installing a local tarball or a future published release:

```sh
ADMIN_TOKEN=replace-me \
DASHBOARD_TOKEN=replace-me-too \
WRITE_KEY=replace-with-browser-write-key \
ALLOWED_ORIGINS=https://product.example \
MANIFEST_JSON='{"version":"v1","groups":["signup"],"steps":[{"id":"account","group":"signup"}]}' \
npx firstmile-sidecar
```

In the current unpublished checkout, build the package and run `node packages/kit/dist/sidecar.js` instead.

The sidecar requires distinct `ADMIN_TOKEN`, `DASHBOARD_TOKEN`, and `WRITE_KEY` values plus one manifest source. It also supports `PORT`, `MANIFEST_JSON`, `MANIFEST_URL`, and `ALLOWED_ORIGINS`. `MANIFEST_JSON` takes precedence when both sources are set. `PORT` defaults to `8787`; the server binds to `0.0.0.0`. `ALLOWED_ORIGINS` is a comma-separated CORS allowlist.

## Route configuration

Each route has an exact absolute pathname, a manifest step, and an optional `shipped` flag:

```ts
routes: [
  { path: "/signup", step: "account" },
  { path: "/projects/new", step: "project" },
  { path: "/success", step: "success", shipped: true }
]
```

The observer matches only `window.location.pathname`. It normalizes trailing slashes and ignores query strings, hashes, unmapped paths, and repeat notifications for the same step. It observes the initial route, `pushState`, `replaceState`, and `popstate` without creating history entries.

Forward movement completes the prior step and records the new step with `from`. Back movement records the earlier step without completing the prior step. Events receive configured step IDs, never the actual pathname or full URL.

## Controller API

`firstmile(options)` initializes immediately and returns:

- `ready`: resolves when initialization finishes.
- `view(step, nav?, from?)`: records a named position.
- `error(step, code, attempt)`: records a bounded machine error code.
- `complete(step)`: records step completion and elapsed time.
- `copy(artifact)`: records an artifact name, never clipboard content.
- `paste(step, ok)`: records whether the host accepted a paste result.
- `shipped()`: records successful flow completion.
- `openDashboard()`: opens the enabled dashboard overlay.
- `closeDashboard()`: closes the enabled dashboard overlay.
- `destroy()`: removes listeners, timers, route wrappers, and injected UI without clearing the persisted session or outbox.

Calls before initialization completes are queued and do not throw. Only one high-level instance is active per page. Calling `firstmile()` again replaces the prior instance.

`defineManifest(manifest)` validates a manifest while preserving its TypeScript type. The root export also provides the `Manifest`, `ManifestStep`, `FirstmileOptions`, `FirstmileRoute`, `FirstmileController`, and `DashboardOptions` types.

## In-app dashboard

The overlay is disabled by default. Set `dashboard.enabled: true` to add a Shadow DOM launcher and an iframe for the collector's `/present` route. `defaultOpen` defaults to `false`.

Dashboard data requires `DASHBOARD_TOKEN`; export requires `ADMIN_TOKEN`; ingestion requires `WRITE_KEY`. The overlay uses the dashboard token in a URL fragment. Treat browser credentials as scoped workshop secrets, restrict CORS, and never place `ADMIN_TOKEN` in browser code.

## Low-level tracker

Import `@firstmile/sdk/tracker` for the original functions:

- `init({ endpoint, manifest, writeKey, sessionTimeoutMs?, app?, debug? })`
- `view(step, nav?, from?)`
- `error(step, code, attempt)`
- `complete(step)`
- `copy(artifact)`
- `paste(step, ok)`
- `shipped()`
- `onMeta(callback)`
- `destroy()`

Unlike the high-level root API, low-level `init` requires an explicit endpoint. `endpoint: ""` means same-origin. It accepts a manifest object or manifest URL.

The tracker keeps a namespaced localStorage session and outbox, rolls over shipped or stale sessions, sends batches of at most 50 events, and retries network failures with bounded backoff. Instrumentation failures do not throw into host code. With `debug: true`, degraded initialization warns at most once.

## Manifest

```ts
interface Manifest {
  version: string;
  groups: string[];
  steps: Array<{ id: string; group: string; label?: string }>;
}
```

Groups and steps are ordered and non-empty. Step IDs must be unique, every group must contain a step, and steps must follow the declared group order. Change `version` when the flow changes because each event carries the manifest version.

## Package exports

- `@firstmile/sdk` and `@firstmile/sdk/browser`: browser-safe high-level API.
- `@firstmile/sdk/tracker`: low-level browser tracker.
- `@firstmile/sdk/server`: Node and Hono collector.
- `@firstmile/sdk/manifest`: manifest types and validation.
- `@firstmile/sdk/reducer`: event reduction API.
- `@firstmile/sdk/snapshot`: aggregate snapshot API.
- `@firstmile/sdk/version`: package version.

## Privacy

Firstmile records named positions and lifecycle signals. The SDK never reads form values, textarea values, clipboard contents, or DOM text. The closed schema rejects arbitrary fields and prose-like strings. Integrators must use fixed machine identifiers and must not pass user-provided values into identifier fields. The route observer sends configured step IDs instead of URLs, pathnames, query parameters, or hashes.

Identifiers are bounded and validated. Events containing unknown fields are omitted at ingestion. The SDK does not scan the DOM or modify cookies.

## Render deployment

The repository includes a Render Blueprint for the sidecar. It uses Node 20, binds to Render's `PORT`, exposes `/healthz`, disables automatic deploys and previews, and configures all three credentials plus the manifest and origin allowlist.

[Deploy to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Ffirstmile) |
[Render documentation](https://render.com/docs) |
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=footer_link)

The repository is private, so the deploying Render account must have access.

## Current v0.1 limitations

- The collector is in-memory and single-process.
- State resets after a restart or deploy. There is no persistence backend.
- Multiple collector instances do not coordinate.
- Browser-visible write and dashboard credentials provide workshop isolation, not user authentication.
- The default collector limits are designed for a small private beta and use 24-hour in-memory retention.
- The package is ESM-only. Server usage requires Node.js 20 or newer.
- The API is pre-1.0 and may change.
- The package has not been published to npm.
- The repository is private, and no license has been selected.

License: to be decided before public release.
