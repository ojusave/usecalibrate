# Event contract

This is the public surface of Firstmile. Any platform that can send an HTTP request can
produce events; the browser SDK is just the reference client. Everything here is enforced
by the collector at ingestion, so a malformed or over-sharing event is dropped rather than
stored.

## Transport

`POST /api/events`

```json
{ "events": [ /* one or more events */ ] }
```

A bare JSON array is also accepted. The response is `{ "ok": true, "accepted": <number> }`.
Invalid events are dropped individually; one bad event never fails the batch. Delivery is
idempotent: events are deduped on `(sessionId, seq)`, so clients can safely retry.

## Envelope

Every event carries these fields:

| Field | Type | Notes |
|---|---|---|
| `v` | integer | Contract version. Currently `1`. |
| `app` | identifier | Names the instrumented surface. |
| `sessionId` | identifier | Opaque, client-generated. No PII. |
| `seq` | integer ≥ 0 | Monotonic per session; used for ordering and dedup. |
| `ts` | integer | Epoch milliseconds. |
| `user` | identifier | Optional. Present only when the host calls `identify()` with consent. |
| `type` | string | Discriminates the payload (below). |

An **identifier** is 1 to 128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`. This is the
privacy floor: free-form text and PII cannot pass validation, so they cannot be stored.

## Event types

| `type` | Payload fields | Meaning |
|---|---|---|
| `session_start` | `resumed?`, `awayMs?` | A session began or resumed. |
| `page` | `route`, `nav` (`forward`\|`back`), `from?` | A position in the flow, by route id (never a full URL). |
| `field` | `name`, `fieldType`, `action` (`focus`\|`fill`\|`blank`\|`blur`\|`error`), `code?`, `attempt?` | A field interaction. Never the value. |
| `flow_step` | `step`, `group?`, `index` | An inferred or declared step in the flow. |
| `copy` | `artifact` | A named artifact was copied. Never the content. |
| `paste` | `step`, `ok` | Whether a paste was accepted. Never the content. |
| `heartbeat` | `visible` | Liveness and tab visibility. |
| `shipped` | `totalMs` | The whole flow completed. |
| `bye` | `persisted` | The page was hidden or closed. |

## What never appears

Field values, input and textarea contents, clipboard contents, DOM text, arbitrary
attributes, full URLs, query strings, and hash fragments are never part of the contract.
Any event containing an unexpected field fails validation.

## Other endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard` | Snapshot JSON powering the dashboard. |
| GET | `/api/schema` | Product name and contract version. |
| GET | `/export?token=…` | Newline-delimited JSON export (guarded by `ADMIN_TOKEN` when set). |
| GET | `/healthz` | Liveness. |
| GET | `/` | The dashboard UI. |
