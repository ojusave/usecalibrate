# Security

Firstmile is an unpublished private beta. Do not send secrets, form values, clipboard contents, DOM text, URLs, or user-provided values through event identifiers.

## Reporting a vulnerability

Private GitHub vulnerability reporting is not currently enabled for this private repository. Until it is enabled, report vulnerabilities to the maintainer through an established private channel. Do not open a public issue containing exploit details or credentials.

Before a public release, enable private vulnerability reporting and replace this temporary process with a monitored security contact.

## Credential model

- `WRITE_KEY` authorizes event ingestion and is expected to be browser-visible.
- `DASHBOARD_TOKEN` authorizes aggregate dashboard reads and is expected to be browser-visible when the overlay is enabled.
- `ADMIN_TOKEN` authorizes raw JSONL export and must remain server-only.

Use distinct values, restrict `ALLOWED_ORIGINS`, rotate disclosed credentials, and do not treat browser-visible credentials as end-user authentication.
