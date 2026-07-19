# Plain HTML example

This three-step signup uses Firstmile without a frontend framework or application backend. It loads the low-level `tracker.min.js` IIFE, calls the global `firstmile` tracker API, and sends events to the standalone sidecar. It does not exercise the high-level `firstmile()` ESM facade from `@firstmile/sdk`.

The tracker records configured step IDs and lifecycle signals. It does not read the email or plan value.

## Run the local sidecar example

Build the SDK from the physical repository path:

```sh
cd /Users/ojusave/Desktop/Samples/firstmile
npm ci
npm run build --workspace @firstmile/sdk
```

In the same terminal, start the sidecar:

```sh
ADMIN_TOKEN=example \
DASHBOARD_TOKEN=example-dashboard \
WRITE_KEY=example-write-key \
ALLOWED_ORIGINS=http://localhost:8080 \
MANIFEST_JSON='{"version":"plain-html-v1","groups":["signup","select","finish"],"steps":[{"id":"email","group":"signup"},{"id":"plan","group":"select"},{"id":"done","group":"finish"}]}' \
node /Users/ojusave/Desktop/Samples/firstmile/packages/kit/dist/sidecar.js
```

Serve the repository from another terminal:

```sh
cd /Users/ojusave/Desktop/Samples/firstmile
python3 -m http.server 8080
```

Open these URLs:

- Signup: <http://localhost:8080/examples/plain-html/signup.html>
- Projector dashboard: <http://localhost:8787/present#token=example-dashboard>

Move through the three screens and watch the dashboard update. The marked block in `signup.html` contains the manifest, low-level `firstmile.init()` call, manual events, and UI wiring.

`ALLOWED_ORIGINS` is required because ports 8080 and 8787 are different browser origins. If you open the HTML directly with a `file://` URL, use `ALLOWED_ORIGINS=null` instead. Serving it over HTTP gives browser behavior closer to a deployed integration.

The browser script cannot launch the collector. Keep the sidecar running while using the example. The collector is in-memory, so its dashboard state resets when the process stops.

## Future installed-package sidecar

`@firstmile/sdk` has not been published to npm. After installing a locally built tarball or a future published release, the equivalent sidecar command will be:

```sh
ADMIN_TOKEN=example \
DASHBOARD_TOKEN=example-dashboard \
WRITE_KEY=example-write-key \
ALLOWED_ORIGINS=http://localhost:8080 \
MANIFEST_JSON='{"version":"plain-html-v1","groups":["signup","select","finish"],"steps":[{"id":"email","group":"signup"},{"id":"plan","group":"select"},{"id":"done","group":"finish"}]}' \
npx firstmile-sidecar
```

The example HTML still needs access to the package's built `tracker.min.js` file at the script path configured in `signup.html`.
