# Plain HTML example

This three-step signup proves that firstmile works without a frontend framework or a Node backend. The tracker records step ids and lifecycle signals only. It never reads the email or plan value.

## Run it

Build the kit:

```sh
npm run build
```

Start the sidecar from the repository root:

```sh
ADMIN_TOKEN=example \
ALLOWED_ORIGINS=http://localhost:8080 \
MANIFEST_JSON='{"version":"plain-html-v1","groups":["signup","select","finish"],"steps":[{"id":"email","group":"signup"},{"id":"plan","group":"select"},{"id":"done","group":"finish"}]}' \
node packages/kit/dist/sidecar.js
```

Serve the repository in another terminal:

```sh
python3 -m http.server 8080
```

Open:

- Signup: <http://localhost:8080/examples/plain-html/signup.html>
- Projector dashboard: <http://localhost:8787/present>

Move through the three screens and watch the dashboard update. The integration is the marked block in `signup.html`: 33 non-empty lines including the manifest and UI event wiring.

`ALLOWED_ORIGINS` is required because ports 8080 and 8787 are different browser origins. If you open the HTML directly with a `file://` URL, use `ALLOWED_ORIGINS=null` instead. Serving it over HTTP gives browser behavior closer to a deployed integration.
