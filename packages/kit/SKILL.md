---
name: firstmile-integration
description: Integrate, review, or troubleshoot the Firstmile browser SDK, embedded Hono collector, standalone sidecar, manifest, event tracking, dashboard, and Render Blueprint.
---

# Firstmile integration

Use this package to instrument named positions and lifecycle signals in a fixed onboarding flow.

## Guardrails

- Use fixed machine identifiers only. Never derive event identifiers from form values, clipboard contents, DOM text, URLs, or other user input.
- Keep `ADMIN_TOKEN` server-only.
- Treat `WRITE_KEY` and `DASHBOARD_TOKEN` as scoped, browser-visible workshop credentials, not user authentication.
- Use distinct credentials and restrict `ALLOWED_ORIGINS`.
- Keep the manifest version aligned across browser and collector.

## Integration workflow

1. Declare ordered groups and steps. Every group must contain at least one contiguous block of steps.
2. Start the embedded Hono collector or standalone sidecar with all three credentials.
3. Initialize `firstmile({ manifest, writeKey, ... })` in the browser.
4. Add exact route mappings or call the controller methods manually.
5. If enabling the overlay, supply `dashboard: { enabled: true, token }`.
6. Verify ingestion, dashboard authorization, shipment, session rollover, and export authorization.

## Verification

Run `npm run verify`, `npm run build`, `npm run smoke:package`, and `bash scripts/smoke-sidecar.sh` from the repository root when those scripts are available. Do not claim an npm release until the package is published and a real integration has been observed. Describe source availability and licensing from the current repository visibility and license file.
