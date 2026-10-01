---
slug: managed-cloud-error-honesty
number: 260930-205620
created: 2026-09-30
status: specified
---

# Make managed cloud refusals diagnosable and honest

**Tracker:** DOR-2622 · **Ideation:** [01-ideation.md](01-ideation.md)

## Overview

When DorkOS's servers refuse a managed-connector request, the app must (1) log which call failed with its status and the cloud's error code, (2) answer its own routes with an honest status and a stable code, and (3) tell the person where the problem is and what to do. It also fixes one wire drift: the app reads `code` where the cloud sends `error`. And it lets managed actions carry the names and "important" flags that self-managed actions already show.

## Background / Problem Statement

See ideation §2 and §4. In short:

- `ManagedConnectorCloudError` carries a code and status, but its message is a fixed sentence. No caller logs the status, and the cloud's `error`/`reason` are thrown away.
- `sendManagementError` rethrows it, so the route answers 500 `INTERNAL_ERROR`. `sendResourceError` answers 500 with no log. `/apps/:toolkit/actions` answers 502 `actions_unavailable` for every cause.
- A 403 `{"error":"permission_upgrade_required"}` is read as `body.code`, so relink recovery never fires. Two tests encode the same wrong field.
- UI failure states ignore the error object.
- The site's switchable fallback copy of the managed discovery service has the strict-schema-over-spread bug that took managed Gmail down.

## Goals

- Every managed-cloud refusal produces exactly one structured log line at the parser choke point: `{kind, method, path, status, cloudCode, reason, code}`. The path is without its query. There are no tokens, and the reason is capped at 200 characters.
- The legacy managed error body `{error, reason?}` is one shared, tested schema, which the private repo vendors.
- `permission_upgrade_required` is recognised from the body the cloud actually sends.
- Every app route that can hit the managed cloud maps `ManagedConnectorCloudError` to an honest status and code (table below), and logs anything it cannot map.
- The access card, access dialog, AppActions and AccountPanel say where the problem is and offer the one useful action.
- Managed operations can carry `displayName` and `important` (optional; the cloud does not send them yet).
- The site fallback builds wire responses through explicit mappers, and splits 400 (bad request) from 500 (our bug).

## Non-Goals

- Moving managed connectors onto `/v1/connections/*` and the Problem envelope (follow-up item).
- The control-plane fix (private, paired item).
- Deleting the site fallback. It stays until forwarding is permanent.

## Technical Dependencies

No new packages. It uses `zod`, the existing `logger`/`logError` (`apps/server/src/lib/logger.ts`), `fetchJSON` error fields (`code`, `status`, `body`) in the client transport.

## Detailed Design

### 1. Contract (`packages/shared/src/connector-managed-schemas.ts`, `connector-managed-discovery-schemas.ts`)

```ts
/** The legacy managed-connector error body the control plane sends on any non-2xx. */
export const ManagedConnectorErrorBodySchema = z
  .object({ error: z.string().min(1).max(100), reason: z.string().max(1_000).optional() })
  .passthrough(); // tolerant on read: extra keys never turn a refusal into invalid_response
```

- Named constants for the known codes: `unauthorized`, `permission_upgrade_required`, `managed_connectors_unavailable`, `invalid_request`, `internal_error`, `not_found`, `conflict`.
- `ManagedConnectorOperationSchema` gains `displayName: z.string().min(1).max(200).optional()` and `important: z.boolean().optional()`. It stays `.strict()` otherwise.
- The TSDoc on both says the private repo vendors the file, and the cloud must not send the new operation fields until the app floor accepts them.

### 2. Parser and error type (`apps/server/src/services/core/auth/cloud-link-client.ts`)

- `ManagedConnectorCloudError` gains read-only `cloudCode?: string`, `reason?: string` (capped at 200), `method?: string`, `path?: string` (no query), and for `invalid_response` an `issuePaths?: string[]` (Zod issue paths only, never values). The constructor takes an options object. Existing `(code, status)` call sites move to it.
- `throwManagedConnectorCloudError(response, request)` reads the body once, bounded, and safe-parses it with `ManagedConnectorErrorBodySchema`. Mapping:
  - 401 → `unauthorized`
  - 403 with `error === 'permission_upgrade_required'` → `permission_upgrade_required`
  - other 403 → `request_failed`
  - 404 → `not_found`
  - 409 → `conflict`
  - 503 or 5xx → **new `unavailable`**
  - anything else → `request_failed`

  `cloudCode` and `reason` are carried in every case.

- New code message: `unavailable` → "DorkOS’s servers aren’t answering right now." The message for `request_failed` stays human; the status belongs in the log, not in copy.
- One `logger.warn('[CloudLink] Managed cloud request refused', {...})` at `requestManagedConnectorResource` and `parseManagedAuthorityStatus` (the two choke points), and a `logger.warn(... 'answered something unexpected' ...)` for `invalid_response` with `issuePaths`. No other layer re-logs the same refusal at warn.
- `afterRefusal` (`cloud-link.ts:841`) keeps the new fields when it wraps.

### 3. Route mapping (one helper, every route)

New `apps/server/src/routes/managed-cloud-error.ts` exports `sendManagedCloudError(res, error): boolean`:

| `ManagedConnectorCloudError.code`                             | HTTP | body `code`               | body `error` (human)                                                                            |
| ------------------------------------------------------------- | ---- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `unauthorized`                                                | 401  | `cloud_link_required`     | This computer isn’t linked to your DorkOS account anymore. Link it again in Settings › Access.  |
| `permission_upgrade_required`                                 | 409  | `cloud_link_needs_update` | This computer’s link to your DorkOS account needs updating. Link it again in Settings › Access. |
| `network_error`, `unavailable`                                | 503  | `cloud_unavailable`       | DorkOS’s servers aren’t answering right now. Nothing changed. Try again in a few minutes.       |
| `request_failed`, `invalid_response`, `not_found`, `conflict` | 502  | `cloud_refused`           | DorkOS’s servers couldn’t finish this. Nothing changed on this computer. Try again later.       |

Wire it into `sendManagementError` (`connector-management.ts`), `sendResourceError` (`connector-resources.ts`, which also gets a `logError` for its unmapped 500 remainder), `sendProgramError` (`connector-execution.ts`), and the `/apps/:toolkit/actions` path. That path keeps `actions_unavailable` for provider outages, but passes a known cloud cause through the table. `app-actions-service.ts` stops discarding causes: it keeps the last cause on the `unavailable()` result, and the route uses it.

### 4. Other log sites

- `managed-cloud.ts:322-335`: log `{code, status, cloudCode}` once before collapsing to `MANAGED_EXECUTION_OUTCOME_UNKNOWN`.
- `bootstrap.ts:684,1037,1043`, `cloud-link.ts:791`: include `code`/`status` when the error is a `ManagedConnectorCloudError`.
- `middleware/error-handler.ts:18`: log `{method, path, code, status}` beside the message.
- `routes/cloud.ts:110`, `routes/cloud-communities.ts:210,226`, `services/core/cloud/credits-inference.ts:169`: include `problemOf(e)?.code` and status.

### 5. Client

A new `apps/client/src/layers/entities/connectors/lib/cloud-failure.ts` exports `cloudFailure(error): {title, description, action?: 'relink'} | null`. It is keyed on `error.code` from the table. `null` means use the surface's existing copy.

- `ConnectionAccessCard`, `ConnectionAccessDialog`, `AppActions` and `AccountPanel` pass the query or mutation error through it. When there is a result, they show its copy. `action: 'relink'` renders a "Open Settings › Access" button, using the existing settings navigation.
- `use-access-reconciliation.ts` exposes `loadError` beside `loadFailed`.
- Copy follows `writing-for-humans`. Before changing any string, grep `apps/e2e` for the old copy.

### 6. Site fallback (`apps/site/src/lib/connectors/managed/`)

- Add explicit mappers `toWireToolkit`, `toWireToolkitVersion` and `toWireOperation` (pick the wire fields; trim the toolkit `displayName`, cap it at 200, and fall back to the slug when it is blank). No spread feeds a wire parse. Operations omit `displayName`/`important`, matching the control plane, until the floor moves.
- The managed routes under `apps/site/src/app/api/instances/connectors/**` answer 400 `invalid_request` only for request parse and JSON syntax errors. Any other Zod failure answers 500 `internal_error` with `console.error` of the class and route.

## User Experience

A person whose managed app fails to load sees one of three honest messages:

- It's on DorkOS's servers: try later, nothing changed.
- This computer's link needs updating: here's the button.
- This computer isn't linked: here's the button.

The generic copy stays only for unknown causes.

## Testing Strategy

- **Parser:** feed real cloud bodies (`{error:'permission_upgrade_required'}` with a 403, `{error:'managed_connectors_unavailable', reason}` with a 503, `{error:'invalid_request'}` with a 400, and a non-JSON 502). Assert the code, cloudCode, reason, status and path. Assert one warn log with no token. **Rewrite** `cloud-link-client.test.ts:432-452` and `cloud-link.test.ts:157-166` to the real `{error}` shape (red first against the current parser).
- **Schema:** `ManagedConnectorErrorBodySchema` parses every documented shape and tolerates extra keys. The operation schema accepts and rejects the new optional fields at their bounds.
- **Routes:** supertest each mapper row through `reconciliation/previews`, one `connector-resources` route and `/apps/:toolkit/actions`. Assert status, code and that it is logged.
- **Client:** RTL for the access card with each code: copy, and the relink button present or absent.
- **Site:** a behavioural test through real mappers and the real schema, with a fixture carrying `displayName`/`important`/`logoUrl`. Route tests for the 400/500 split.
- **Verification:** run `pnpm verify` and `pnpm vitest run` on each touched folder. Run `chromium-connections` locally if any copy an e2e spec asserts changed.

## Performance Considerations

It reads one bounded error body per refusal (already one round trip). Nothing changes on the hot path.

## Security Considerations

Logs never carry tokens, response bodies beyond `error` plus a 200-character `reason`, or query strings (which can hold cursors). Zod issue paths are logged, never values.

## Documentation

- A changelog fragment in plain words ("When DorkOS's servers can't answer, the app now says so and tells you what to do").
- TSDoc on the new schema and helper.
- `contributing/` has no guide for the managed-cloud client. Add a short "errors" note to the connector guide the server uses, if one exists.

## Implementation Phases

1. Contract (shared schemas + tests).
2. Parser, error type and choke-point logging (+ the rewritten tests).
3. Route helper and its wiring, app-actions cause passthrough, the other log sites.
4. Client copy.
5. Site fallback mappers + the 400/500 split.

## Open Questions

- ~~Should `permission_upgrade_required` be 403 or 409 from the app's own routes?~~ (RESOLVED) **Answer:** 409 `cloud_link_needs_update`. **Rationale:** the person is signed in to the app, so 403 would read as "you may not". The conflict is between this computer's link and the account.
- ~~Keep a fallback read of `body.code`?~~ (RESOLVED) **Answer:** No. **Rationale:** no cloud version ever sent `code` on these paths. A fallback would only keep the mirrored tests alive.
- ~~Add displayName/important now if the cloud cannot send them yet?~~ (RESOLVED) **Answer:** Yes. **Rationale:** contract-first. Apps must accept a field before the server may send it.

## Related ADRs

- Draft: `decisions/260930-210144-managed-wire-explicit-mapping-and-error-body.md` (seeded by this spec).

## References

- DOR-2622; the paired private item.
- `packages/cloud-api/src/problem.ts` (the `/v1` envelope this will migrate to).
