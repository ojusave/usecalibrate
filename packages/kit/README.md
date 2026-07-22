# usecalibrate

`usecalibrate` is an ESM-only browser and Node package for recording named onboarding positions and lifecycle signals. The browser API sends events to an existing embedded collector or standalone sidecar. It cannot start a shared backend.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Fusecalibrate)
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=hero_cta) |
[GitHub repository](https://github.com/ojusave/usecalibrate)

## Installation

Install the package from npm:

```sh
npm install usecalibrate
```

Browser use needs an ESM-aware bundler or runtime. The server and sidecar require Node.js 20 or newer.

If a Calibrate collector is already running, use the guided installer:

```sh
npx usecalibrate install --url https://collector.example
```

It verifies `/healthz`, loads the collector's authoritative `/api/manifest`, confirms `/dashboard`, previews the route mapping and file changes, then asks before writing. It supports React/Vite and generic ESM browser applications with one detectable entry point. Add explicit routes when inference is ambiguous:

```sh
npx usecalibrate install \
  --url https://collector.example \
  --route /signup=account \
  --route /success=success:shipped
```

For noninteractive use, add `--yes --json`. Set `CALIBRATE_WRITE_KEY` to run a synthetic ingestion and privacy-rejection check. The key is not persisted or included in command output. Without the key, a successful command reports `evidence: "artifact"` instead of claiming runtime verification.

The package does not provision or host the collector. The SDK is bundled into the host application. The existing collector receives data and serves the interactive UI at `<collector-url>/dashboard`.

### Install with an AI coding agent

The package ships a portable Agent Skill at `skills/install-calibrate`. Install that directory in your agent's skill location, then ask:

> Install Calibrate for this application's onboarding flow.

The skill drives a plan-before-write CLI:

```sh
npx usecalibrate detect --dir . --json
npx usecalibrate plan --dir . --out calibrate.plan.json
npx usecalibrate apply --plan calibrate.plan.json --yes
npx usecalibrate verify --dir . --json
```

V1 supports React/Vite and generic ESM browser applications. The planner proposes fixed route identifiers but requires review before applying them. Runtime verification can send a synthetic completed journey to a local sidecar and confirm that an event carrying an unknown content field is rejected.

To build and pack it from a repository checkout instead:

```sh
cd usecalibrate
npm ci
npm run build --workspace usecalibrate
npm pack --workspace usecalibrate
```

Install the resulting tarball in another project:

```sh
npm install /path/to/usecalibrate-0.1.4.tgz
```

## Browser quickstart

The root export is browser-safe. It defaults to the collector endpoint `/__calibrate`:

```ts
import { calibrate } from "usecalibrate";

const fm = calibrate({
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
const fm = calibrate({
  endpoint: "https://calibrate-sidecar.example",
  writeKey: "replace-with-browser-write-key",
  manifest,
  routes
});
```

## Embedded Hono collector

Mount the server routes at the default browser endpoint:

```ts
import { Hono } from "hono";
import { createCalibrate } from "usecalibrate/server";

const app = new Hono();

const fm = createCalibrate({
  manifest,
  adminToken: process.env.ADMIN_TOKEN,
  dashboardToken: process.env.DASHBOARD_TOKEN,
  writeKey: process.env.WRITE_KEY,
  allowedOrigins: []
});

app.route("/__calibrate", fm.routes);
```

The browser SDK then uses its default:

```ts
calibrate({
  manifest,
  writeKey: window.CALIBRATE_WRITE_KEY,
  routes,
  dashboard: { enabled: true, token: window.CALIBRATE_DASHBOARD_TOKEN }
});
```

The host is responsible for starting Hono. `createCalibrate` exposes service status at `/`, credentialed ingestion at `/api/events`, the manifest at `/api/manifest`, protected aggregates at `/api/dashboard`, the interactive UI at `/dashboard`, the projector at `/present`, bearer-protected JSONL export at `/export`, and `/healthz`.

## Standalone sidecar

After installing `usecalibrate`:

```sh
ADMIN_TOKEN=replace-me \
DASHBOARD_TOKEN=replace-me-too \
WRITE_KEY=replace-with-browser-write-key \
ALLOWED_ORIGINS=https://product.example \
MANIFEST_JSON='{"version":"v1","groups":["signup"],"steps":[{"id":"account","group":"signup"}]}' \
npx calibrate-sidecar
```

From a repository checkout, build the package and run `node packages/kit/dist/sidecar.js` instead.

The sidecar requires distinct `ADMIN_TOKEN`, `DASHBOARD_TOKEN`, and `WRITE_KEY` values plus one manifest source. It also supports `PORT`, `MANIFEST_JSON`, `MANIFEST_URL`, `ALLOWED_ORIGINS`, and `PERSIST_PATH`. `MANIFEST_JSON` takes precedence when both sources are set. `PORT` defaults to `8787`; the server binds to `0.0.0.0`. `ALLOWED_ORIGINS` is a comma-separated CORS allowlist.

`PERSIST_PATH` is optional. When set to a writable file path, every stored event is appended as JSONL and replayed on boot, so sessions and events survive restarts; the sidecar flushes and closes the file on `SIGTERM`. A mounted disk cannot be shared or rolled, so enabling persistence pins the service to a single instance with stop-then-start deploys (see `render.yaml`). Leave `PERSIST_PATH` unset for in-memory-only operation.

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

`calibrate(options)` initializes immediately and returns:

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

Calls before initialization completes are queued and do not throw. Only one high-level instance is active per page. Calling `calibrate()` again replaces the prior instance.

`defineManifest(manifest)` validates a manifest while preserving its TypeScript type. The root export also provides the `Manifest`, `ManifestStep`, `CalibrateOptions`, `CalibrateRoute`, `CalibrateController`, and `DashboardOptions` types.

## In-app dashboard

The overlay is disabled by default. Set `dashboard.enabled: true` to add a Shadow DOM launcher and an iframe for the collector's `/dashboard` route. `defaultOpen` defaults to `false`.

You can also open the dashboard directly:

```text
https://collector.example/dashboard#token=YOUR_DASHBOARD_TOKEN
```

The token is read from the URL fragment, removed from the visible address bar, held in browser memory, and sent only as the bearer credential for `/api/dashboard`. The dashboard shows current retention-window aggregates:

- Started, shipped, overall conversion, active-now count, and median ship time
- Reach and conversion by manifest group
- Lifecycle presence totals
- Step reach, derived drop-off, error events, backtracks, returns, and median time
- Humanized recent signals without session identifiers
- Connection, paused, stale, unauthorized, unavailable, and empty states

Drop-off is derived from each step's reach compared with the next step, or shipped sessions for the final step. It is clamped at zero because revisits can make aggregate step counts non-monotonic. Error counts are events, not unique users. This first dashboard does not claim trends, cohorts, or time-series data because the snapshot contract does not provide them.

Dashboard data requires `DASHBOARD_TOKEN`; export requires `ADMIN_TOKEN`; ingestion requires `WRITE_KEY`. The overlay uses the dashboard token in a URL fragment. Treat browser credentials as scoped workshop secrets, restrict CORS, and never place `ADMIN_TOKEN` in browser code.

## Low-level tracker

Import `usecalibrate/tracker` for the original functions:

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

- `usecalibrate` and `usecalibrate/browser`: browser-safe high-level API.
- `usecalibrate/tracker`: low-level browser tracker.
- `usecalibrate/server`: Node and Hono collector.
- `usecalibrate/manifest`: manifest types and validation.
- `usecalibrate/reducer`: event reduction API.
- `usecalibrate/snapshot`: aggregate snapshot API.
- `usecalibrate/version`: package version.

## Privacy

Calibrate records named positions and lifecycle signals. The SDK never reads form values, textarea values, clipboard contents, or DOM text. The closed schema rejects arbitrary fields and prose-like strings. Integrators must use fixed machine identifiers and must not pass user-provided values into identifier fields. The route observer sends configured step IDs instead of URLs, pathnames, query parameters, or hashes.

Identifiers are bounded and validated. Events containing unknown fields are omitted at ingestion. The SDK does not scan the DOM or modify cookies.

## Render deployment

The repository includes a Render Blueprint for the sidecar. It uses Node 20, binds to Render's `PORT`, exposes `/healthz`, disables automatic deploys and previews, and configures all three credentials plus the manifest and origin allowlist.

[Deploy to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Fusecalibrate) |
[Render documentation](https://render.com/docs) |
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=footer_link)

The repository is public. The deploy still creates private service credentials, which must be replaced before use and kept out of source control.

## Current v0.1 limitations

- The embedded collector and sidecar are single-process.
- State resets after a restart or deploy unless `PERSIST_PATH` points to a writable file. File persistence replays JSONL on startup and requires one instance.
- Multiple collector instances do not coordinate or share state.
- Browser-visible write and dashboard credentials provide workshop isolation, not user authentication.
- The default collector limits are designed for small workshops and evaluations and use 24-hour retention.
- The package is ESM-only. Server usage requires Node.js 20 or newer.
- The API is pre-1.0 and may change.
- The package is published on npm under `usecalibrate`.
- The source repository is public under Apache-2.0.

License: [Apache-2.0](./LICENSE).
