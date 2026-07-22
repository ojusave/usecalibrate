# React/Vite example

This example shows the current position-only `usecalibrate` API. Calibrate records configured step IDs and lifecycle signals. It does not inspect fields, read input values, or infer route meanings.

For the shortest complete path, follow the repository's [ten-minute local quickstart](../../README.md#ten-minute-local-quickstart). The guided installer generates and imports this integration after showing the proposed changes.

## Manual integration

Install version 0.1.4 or newer:

```sh
npm install usecalibrate@^0.1.4
```

Create `src/calibrate.ts`:

```ts
import { calibrate, defineManifest } from "usecalibrate";

const manifest = defineManifest({
  version: "onboarding-v1",
  groups: ["signup"],
  steps: [
    { id: "account", group: "signup" },
    { id: "success", group: "signup" }
  ]
});

const routes = [
  { path: "/signup", step: "account" },
  { path: "/welcome", step: "success", shipped: true }
] as const;

const writeKey = import.meta.env.VITE_CALIBRATE_WRITE_KEY;
const endpoint = import.meta.env.VITE_CALIBRATE_ENDPOINT || "http://localhost:8787";

export const calibrateClient = writeKey
  ? calibrate({ endpoint, manifest, routes, writeKey })
  : undefined;
```

Import it once from the application entry point:

```tsx
import "./calibrate";
```

Start the application without writing the local key into source:

```sh
VITE_CALIBRATE_WRITE_KEY=local-browser-write-key npm run dev
```

Visit `/signup`, continue to `/welcome`, then open the collector's `/dashboard` route. Done means the dashboard's reached-step and shipped counts increase.

The collector must already exist. The browser SDK does not start or deploy it.
