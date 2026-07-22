---
name: install-calibrate
description: Install, configure, verify, or troubleshoot the Calibrate browser SDK and standalone sidecar in JavaScript or TypeScript applications. Use when a user asks an AI coding agent to add Calibrate, instrument an onboarding flow, create a manifest and route map, run the collector, validate privacy boundaries, or repair an existing Calibrate installation.
---

# Install Calibrate

Use the `calibrate` CLI for deterministic detection, planning, application, and verification. Inspect the target repository and its local instructions before running it.

## Workflow

When the user supplies an existing collector URL and wants the shortest guided flow, run `npx usecalibrate install --url <collector-url>` first without `--yes`. Review its collector checks, exact manifest, route mapping, file plan, required environment names, and dashboard URL. After explicit approval, rerun with `--yes`. Add `--json` for noninteractive output and provide `CALIBRATE_WRITE_KEY` only for runtime verification.

When the collector URL is unavailable, the mapping needs manual investigation, or a durable plan artifact is useful, use the lower-level workflow:

1. Run `npx usecalibrate detect --dir . --json` without changing files.
2. Review the detected framework, entry point, existing installation, and proposed fixed routes.
3. If routes are missing or ambiguous, ask the user which ordered routes form the onboarding flow and which route means shipped.
4. Run `npx usecalibrate plan --dir . --out calibrate.plan.json`, adding explicit `--route` values when needed.
5. Show the user the proposed manifest, collector mode, file changes, required environment names, and unresolved decisions.
6. Apply only after approval with `npx usecalibrate apply --plan <plan-file> --yes`.
7. Run the host project's build or typecheck.
8. Run `npx usecalibrate verify --dir . --json` for static checks.
9. When a local sidecar and write key are available, run runtime verification with `--endpoint` and `--write-key`.

Read [references/cli.md](references/cli.md) for command details, exit codes, supported projects, and recovery behavior.

## Guardrails

- Use fixed machine identifiers only.
- Never derive identifiers from form values, DOM text, clipboard contents, URLs, query strings, hashes, or other user input.
- Keep `ADMIN_TOKEN` server-only.
- Treat `WRITE_KEY` and `DASHBOARD_TOKEN` as scoped browser-visible workshop credentials, not user authentication.
- Keep browser and collector manifests identical by using `calibrate.install.json` as the installer record.
- Do not overwrite a custom Calibrate integration or ambiguous application entry point.
- Do not deploy, publish, create accounts, or modify production infrastructure without explicit authorization.
- Treat `--url` as an existing collector. The installer does not deploy or host infrastructure.

## Completion

A package install or passing build is not enough. Report static installation as artifact verification. Report runtime validation only after a synthetic completed journey reaches the collector and the privacy rejection check passes.
