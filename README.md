# Firstmile

Self-hostable onboarding and funnel diagnostics that autocapture the flow without ever reading its contents.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

> Firstmile is a placeholder name and will change before any package release. The packages are not published to npm.

Install one package, point it at your app, and Firstmile detects the pages, fields, and the flow between them, then streams that structure to a collector you run. It records that an email field was focused, filled, or errored. It never records what someone typed. Most funnel tools make you choose between "see everything, inherit a PII problem" and "instrument every step by hand." Firstmile takes a third path: autocapture the shape of the journey, leave the contents in the browser.

- [Highlights](#highlights)
- [How it works](#how-it-works)
- [The privacy guarantee](#the-privacy-guarantee)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Project structure](#project-structure)
- [Development](#development)
- [Current limits](#current-limits)

## Highlights

- **Autocapture, not manual instrumentation.** It observes route changes and form fields on its own. You call the manual API only for things the DOM cannot tell it, like an API response that means the flow shipped.
- **Privacy is enforced on the wire, not promised in docs.** Every event must pass a bounded schema at ingestion. An event carrying a stray `email` value is dropped by the collector, not stored and hoped over.
- **The contract is the product.** Ingestion is a documented `POST /api/events`. The browser SDK is the reference client; a native app or a backend can produce the same events with an HTTP call.
- **Runs anywhere Node runs.** SQLite by default means there is no database to provision to try it. Point `DATABASE_URL` at Postgres when you want durable, multi-instance storage.
- **Fault-isolated by design.** Instrumentation never throws into your app, and a failing destination is logged without blocking ingestion.

## How it works

<!-- TODO: replace with a real architecture diagram at static/images/architecture-diagram.png -->
> _Architecture diagram: to be added._

A client sends events to the collector. The collector validates them against the contract, dedupes and persists them, reduces them into per-session state, and serves a dashboard.

<!-- TODO: replace with a real dashboard screenshot at static/images/dashboard.png -->
> _Dashboard screenshot: to be added._

## The privacy guarantee

Firstmile records named positions and a closed set of interaction signals. It does not read input values, textarea contents, clipboard contents, DOM text, or arbitrary attributes. The route observer never sends full URLs, query strings, or hashes: dynamic-looking path segments (numeric ids, uuids, hashes) collapse to `:id` before anything leaves the page, so a real user id in a URL never becomes a route.

The floor is a shared validation rule. Every identifier on the wire is 1 to 128 characters matching `^[A-Za-z0-9:/][A-Za-z0-9._:/-]*$`. Prose, emails, and quoted text fail that rule, so they cannot ride along in a field the schema would otherwise accept. The collector enforces it a second time at ingestion. See [docs/contract.md](./docs/contract.md) for the full event vocabulary.

## Quick start

Firstmile is a four-package workspace and is not yet published to npm. Build it from a checkout:

```bash
npm install
npm run build
```

Run the collector. With no configuration it uses a local SQLite file and serves a dashboard on port 8787:

```bash
node packages/collector/dist/cli.js
# [firstmile] Firstmile collector on http://0.0.0.0:8787
# [firstmile] store: sqlite · dashboard: /
```

Open `http://localhost:8787` for the dashboard. Once published, the same collector will run with `npx @firstmile/collector`.

## Usage

**A web app with a bundler:**

```ts
import { firstmile } from "@firstmile/browser";

const fm = firstmile({
  app: "my-app",
  endpoint: "http://localhost:8787",
});
```

That single call starts autocapture. With a client router, page and flow events appear as visitors navigate, and field interactions appear as they fill forms.

**A plain HTML page** adds the SDK with one script tag. See [`examples/plain-html`](./examples/plain-html) for a runnable multi-step form. The published CDN form will be:

```html
<script src="https://cdn.jsdelivr.net/npm/firstmile"></script>
<script>firstmile({ app: "site", endpoint: "https://collector.example.com" });</script>
```

**The manual API** covers what autocapture cannot see:

```ts
fm.shipped();                 // the flow completed (e.g. an API returned 200)
fm.page("/checkout");         // a position you want to record explicitly
fm.copy("api_key");           // an artifact name, never its contents
fm.identify("account_9f8c");  // optional, opaque, consented id
```

See [`examples/react`](./examples/react) for a React integration.

## Configuration

The collector reads everything from the environment with production-safe defaults.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to bind on `0.0.0.0`. |
| `STORE` | `sqlite` | `sqlite`, `postgres`, or `memory`. Defaults to `postgres` if `DATABASE_URL` is set. |
| `SQLITE_PATH` | `./firstmile.db` | SQLite file path. |
| `DATA_DIR` | — | Directory for the SQLite file when `SQLITE_PATH` is unset. |
| `DATABASE_URL` | — | Postgres connection string. Required when `STORE=postgres`. |
| `ALLOWED_ORIGINS` | — | Comma-separated origins allowed to post cross-origin. |
| `ADMIN_TOKEN` | — | When set, guards `/export`. When unset, export is open (fine for local). |
| `DEST_STDOUT` | `false` | Also write each event as JSON to stdout. |
| `WEBHOOK_URL` | — | Also forward batches to this URL, with timeout and capped retry. |

If SQLite cannot open its file, the collector logs a warning and falls back to in-memory storage rather than failing to start. Postgres is chosen explicitly, so a bad connection fails fast.

## Deploy

The collector is a standard Node service, so any host works. Two equal paths:

**Docker:**

```bash
docker build -f packages/collector/Dockerfile -t firstmile-collector .
docker run -p 8787:8787 -v "$PWD/data:/data" firstmile-collector
```

**Node directly:** run `node packages/collector/dist/cli.js` behind whatever process manager or platform you use (a VPS, Fly, Railway, Render, Kubernetes). Set `DATABASE_URL` for durable storage and `ALLOWED_ORIGINS` for the sites that post to it.

## Project structure

```
packages/contract   The public event schema and shared types. Depends on nothing else.
packages/browser    The browser SDK: autocapture, transport, flow inference, manual API.
packages/collector  Ingest, Store adapters (SQLite/Postgres), destinations, dashboard, CLI.
examples/           plain-html and react integrations.
docs/contract.md    The event contract, documented as the public surface.
```

Modules depend only on `@firstmile/contract`, never on each other's internals. Storage and destinations sit behind ports so a new backend is one file behind an existing interface.

## Workshop kit (packages/kit)

Alongside the autocapture packages, this repo carries `packages/kit`: the vendored Firstmile workshop kit (tracker, in-memory collector, and sidecar) used by the DevRelCon demo. This repo owns it. Downstream repos (the fakesaaspi demo) vendor `packages/kit` via their own `scripts/sync-kit.sh` and must not hand-edit their copy; make kit changes here and land them on `main`.

The sidecar exposes `POST /admin/reset` (admin-token gated), which clears its in-memory sessions and events. Sidecar deployments lose that state on every deploy or restart anyway, so reset gives operators an explicit, immediate way to start clean.

## Development

```bash
npm run build       # build contract, then browser, then collector
npm test            # run all package tests
npm run lint        # eslint across the packages
npm run typecheck   # strict tsc per package
```

Tests cover the contract validator (including PII rejection), the SQLite and in-memory stores, session reduction and funnel math, and fault isolation (a failing destination must not affect ingestion).

## Current limits

- The dashboard's live view and flow inference are heuristic: the flow is the observed order of distinct routes, correctable with explicit `page()` calls. There is no declared-manifest override yet.
- Autocapture is browser-only today. Native and server clients can already post to the contract, but there are no client libraries for them yet.
- `identify()` links sessions by an opaque id you supply. There is no cross-device identity in the core, by design.

## License

[Apache-2.0](./LICENSE).
