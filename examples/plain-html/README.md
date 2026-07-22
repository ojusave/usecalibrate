# Plain HTML example

This three-step onboarding flow uses Calibrate without a frontend framework or application backend. It loads the published `tracker.min.js` browser bundle, calls the global `calibrate` tracker API, and sends events to the standalone sidecar over HTTP. Calibrate does not use WebSockets.

The tracker records configured step IDs and lifecycle signals. It does not read the email, workspace name, or plan value.

## Run the onboarding flow

From the repository root, start the published sidecar package:

```sh
ADMIN_TOKEN=example \
DASHBOARD_TOKEN=example-dashboard \
WRITE_KEY=example-write-key \
ALLOWED_ORIGINS=http://localhost:8080 \
MANIFEST_JSON='{"version":"onboarding-demo-v1","groups":["account","workspace","activation"],"steps":[{"id":"account","group":"account"},{"id":"workspace","group":"workspace"},{"id":"complete","group":"activation"}]}' \
npx --yes --package usecalibrate@0.1.4 calibrate-sidecar
```

Serve the repository from another terminal:

```sh
cd usecalibrate
python3 -m http.server 8080
```

Open these URLs:

- Signup: <http://localhost:8080/examples/plain-html/signup.html>
- Interactive dashboard: <http://localhost:8787/dashboard#token=example-dashboard>

Move through the three screens, then select **View onboarding data**. Done means the dashboard's started and shipped counts increase. The dashboard polls `GET /api/dashboard` once per second and shows starts, completions, the funnel, timing, and recent event names.

The browser tracker sends batches to `POST http://localhost:8787/api/events`. The sidecar validates and reduces those events in memory. Set `PERSIST_PATH` when you need sessions to survive a restart.

`ALLOWED_ORIGINS` is required because ports 8080 and 8787 are different browser origins. If you open the HTML directly with a `file://` URL, use `ALLOWED_ORIGINS=null` instead. Serving it over HTTP gives browser behavior closer to a deployed integration.

The browser bundle cannot launch the collector. Keep the sidecar running while using the example. The default collector is in memory, so its dashboard state resets when the process stops.
