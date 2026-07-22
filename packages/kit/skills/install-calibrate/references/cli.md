# Calibrate installer CLI

## Commands

```sh
npx usecalibrate detect --dir . --json
npx usecalibrate plan --dir . --out calibrate.plan.json
npx usecalibrate apply --plan calibrate.plan.json --yes
npx usecalibrate verify --dir . --json
```

Supply route semantics when detection cannot infer them safely:

```sh
npx usecalibrate plan --dir . \
  --route /signup=account \
  --route /projects/new=project \
  --route /success=success:shipped \
  --out calibrate.plan.json
```

Use `--no-install` only when dependency installation is managed separately. Applying a plan without `--yes` is a hard error.

## Runtime verification

Start the sidecar from an installed application:

```sh
ADMIN_TOKEN=replace-me \
DASHBOARD_TOKEN=replace-me-too \
WRITE_KEY=replace-with-browser-write-key \
ALLOWED_ORIGINS=http://localhost:5173 \
npx usecalibrate sidecar --dir .
```

Then verify ingestion and privacy rejection:

```sh
npx usecalibrate verify --dir . \
  --endpoint http://localhost:8787 \
  --write-key replace-with-browser-write-key \
  --json
```

For React/Vite applications, set `VITE_CALIBRATE_WRITE_KEY` and optionally `VITE_CALIBRATE_ENDPOINT`. Generic ESM applications read `globalThis.CALIBRATE_CONFIG` with `writeKey` and optional `endpoint` fields.

## Support boundary

V1 supports React/Vite and generic ESM browser applications with a unique source entry file. It returns a blocked result for Next.js and unrecognized runtimes. It returns a human-judgment result when fewer than two fixed onboarding routes are available.

The planner will not modify a custom Calibrate integration that lacks `calibrate.install.json`. Review and reconcile that integration manually first.

## Exit codes

- `0`: command completed at its declared evidence level.
- `1`: unexpected execution error.
- `2`: invalid arguments or missing write approval.
- `3`: blocked or needs human judgment.
- `4`: apply or verification failure.

If files change after planning, generate a new plan. Do not force the stale plan over user edits.
