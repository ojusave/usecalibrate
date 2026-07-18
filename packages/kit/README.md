# @firstmile/kit

firstmile lets a product team watch its first mile in real time through a self-hosted, projector-ready funnel. It is position-only by construction: integrators declare ordered steps, then the kit reports movement, retries, timing, backtracks, lifecycle state, and completion.

**firstmile physically cannot see what your users type: the event schema has no field for content.**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Ffirstmile)
[Sign up on Render](https://dashboard.render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=hero_cta) |
[Repository](https://github.com/ojusave/firstmile) |
[Render docs](https://render.com/docs)

## Quickstart A: Node and Hono host

From this repository, build the workspace and mount firstmile in a Hono app:

```sh
npm install
npm run build
```

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFirstmile } from "@firstmile/kit";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error("ADMIN_TOKEN is required");
const manifest = {
  version: "onboarding-v1",
  groups: ["signup", "activate"],
  steps: [
    { id: "account", group: "signup" },
    { id: "project", group: "activate" },
    { id: "success", group: "activate" },
  ],
};
const fm = createFirstmile({ manifest, adminToken });
const app = new Hono();
app.route("/", fm.routes);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8787) });
```

Serve `dist/tracker.min.js` as a static asset, then initialize and record position from browser code:

```html
<script src="/tracker.min.js"></script>
<script>
  firstmile.init({ endpoint: "", manifest: "/api/manifest" }).then(() => {
    firstmile.view("account");
    firstmile.complete("account");
    firstmile.view("project");
  });
</script>
```

An empty endpoint means same-origin. A missing or non-string endpoint disables tracking without affecting the host.

## Quickstart B: any stack through the sidecar

The sidecar keeps firstmile separate from the host backend. Configure it with environment variables and point the zero-dependency browser tracker at its public URL:

```sh
ADMIN_TOKEN=replace-me \
ALLOWED_ORIGINS=https://product.example \
MANIFEST_JSON='{"version":"v1","groups":["signup"],"steps":[{"id":"account","group":"signup"}]}' \
node node_modules/@firstmile/kit/dist/sidecar.js
```

```html
<script src="/assets/tracker.min.js"></script>
<script>
  firstmile.init({
    endpoint: "https://firstmile-sidecar.example",
    manifest: { version: "v1", groups: ["signup"], steps: [{ id: "account", group: "signup" }] }
  });
  firstmile.view("account");
</script>
```

The sidecar defaults to port 8787 and binds to `0.0.0.0`. Configure the manifest with `MANIFEST_JSON` or `MANIFEST_URL`; `MANIFEST_JSON` wins when both are set. `ALLOWED_ORIGINS` is an optional comma-separated list used only for sidecar CORS. The two required environment variables are `ADMIN_TOKEN` and one manifest source. See the complete [plain HTML example](../../examples/plain-html/README.md).

For Render, use a web service with `node packages/kit/dist/sidecar.js` as its start command, `/healthz` as its health check, and `ADMIN_TOKEN`, `MANIFEST_JSON`, and `ALLOWED_ORIGINS` as environment variables. Render's filesystem is ephemeral, which matches this v0.1 in-memory service: state resets on deploy or restart. The [Deploy to Render documentation](https://render.com/docs/deploy-to-render-button) explains Blueprint-backed one-click deployment.

## Manifest reference

The manifest is the only flow declaration:

```ts
interface Manifest {
  version: string;
  groups: string[];
  steps: { id: string; group: string; label?: string }[];
}
```

Groups and steps are ordered. Each step must reference a declared group, step ids must be unique, and both arrays must be non-empty. `label` is optional. Extra step properties are ignored so a host can keep its own configuration beside firstmile's fields. Change `version` when the flow changes: every event is stamped with it.

## Tracker API reference

- `init({ endpoint, manifest, app?, debug? })`: validates or fetches the manifest, restores the local session and outbox, then starts lifecycle tracking. `endpoint: ""` uses same-origin.
- `view(stepId, nav?, from?)`: records position. Direction is inferred from manifest order when omitted.
- `error(stepId, code, attempt)`: records an integrator-defined short error code and retry number.
- `complete(stepId)`: records completion and elapsed time in the current step.
- `copy(artifactName)`: records only the artifact id, never clipboard content.
- `paste(stepId, ok)`: records whether the host accepted a paste result.
- `shipped()`: marks the flow complete and records total elapsed time.
- `onMeta(callback)`: receives ingest metadata when it changes deeply.

Events persist in a namespaced localStorage outbox and flush in batches. Network failure retries with bounded backoff. Tracker failures do not throw into host code. With `debug: true`, degradation produces at most one warning.

## SPA history note

firstmile never changes browser history. A single-page app should push a history entry for each visible step and call `view()` from its own route transition. Without per-step entries, the iOS edge swipe can leave the site instead of moving to the prior step, which inflates closed counts.

## Dashboard tour

Open `/present` on the firstmile server. It polls once per second and renders `started` followed by each manifest group. Ratios between columns show conversion from the prior stage; each group also shows conversion from start. Summary counters report shipped and current lifecycle states.

Press `d` to toggle the step drilldown. It shows reach, errors, backtracks, returns, and median step time. The ticker rotates through recent humanized events. The freshness indicator turns red when the snapshot is more than five seconds old. The page loads no external assets and displays no user identifiers.

## Export and data shape

`GET /export?token=<ADMIN_TOKEN>` returns all stored events as newline-delimited JSON. Treat the token as a secret and do not place it in projector URLs. Each line has this envelope:

```json
{"sessionId":"random-id","seq":4,"ts":1750000000000,"manifestVersion":"v1","type":"page_view","step":"account","nav":"forward"}
```

Payload strings are bounded machine identifiers, not prose: 1 to 128 characters using letters, numbers, `.`, `_`, `:`, `/`, or `-`. Error codes use the same syntax with a 64-character limit. Unknown step ids that match this syntax are recorded, which preserves record-never-reject without creating a free-text channel. Arbitrary fields and prose-like strings are omitted at ingestion. `/api/dashboard` returns an aggregate snapshot, while `/api/manifest` returns the validated public flow declaration.

This release stores state in one process and writes accepted events to stdout. It has no persistence backend, cross-instance coordination, or user authentication. Keep one service instance and collect stdout logs if events must survive a restart.

## Beta honesty

firstmile was extracted live from a DevRelCon workshop, v0.1, the API will move, issues welcome, maintained by a person on paternity leave, expect commits at odd hours.

Open issues at [github.com/ojusave/firstmile/issues](https://github.com/ojusave/firstmile/issues).

License: to be decided before public release.
