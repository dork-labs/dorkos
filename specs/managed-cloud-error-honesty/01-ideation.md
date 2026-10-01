---
slug: managed-cloud-error-honesty
number: 260930-205620
created: 2026-09-30
status: ideation
---

# Make managed cloud refusals diagnosable and honest

**Slug:** managed-cloud-error-honesty
**Author:** Claude Code (with the operator)
**Date:** 2026-09-30
**Tracker:** DOR-2622 (paired with a private control-plane item, contract-first)

---

## 1) Intent & Assumptions

- **Task brief:** After a managed Gmail connection was made, both the Connections side panel and an agent's in-chat access request showed "Couldn't load who can use it". The cause was a server-side bug on DorkOS's servers, but the app hid every clue: the log said only "DorkOS's servers turned the request down.", the route answered a bare 500 `INTERNAL_ERROR`, and the card showed fixed copy. Make every managed-cloud refusal diagnosable from the app's own log, honest in the app's own routes, and understandable in the UI, and fix the one wire-contract drift found on the way.
- **Assumptions:**
  - The managed-connector calls keep using the legacy `/api/instances/connectors/*` paths for now; the control plane does not serve the `/v1/connections/*` twins defined in `packages/cloud-api/src/routes.ts` yet.
  - The legacy error body the cloud sends is `{ "error": "<code>", "reason"?: "<text>" }`, with 401 `unauthorized`, 403 `permission_upgrade_required`, 503 `managed_connectors_unavailable`, 400 `invalid_request`, 409 and 404.
  - Logs may carry status, the cloud's error code, the request path (no query) and a request-kind label. Never tokens, never bodies beyond the error code and a length-capped reason.
- **Out of scope:**
  - Moving managed connectors onto `/v1/connections/*` and the Problem envelope. That is the long-term end state, and it is a programme of its own (a follow-up item is filed).
  - The server-side bug itself. It is fixed in the paired private item. This repo's site fallback copy of the same code is in scope (section 3).

## 2) Pre-reading Log

- `apps/server/src/services/core/auth/cloud-link-client.ts:150-283`: `ManagedConnectorCloudError` keeps `code` and `status`. Its message depends on the code only. `throwManagedConnectorCloudError` reads `body.code` on a 403, but the cloud sends `body.error`. So the "link this computer again" recovery never fires, and 503 `reason` is dropped.
- `apps/server/src/services/core/auth/__tests__/cloud-link-client.test.ts:432-452` and `cloud-link.test.ts:157-166`: the fake 403 bodies use `{code: …}`. They encode the bug, so they pass while production fails.
- `apps/server/src/routes/connector-management.ts:208-270` (`sendManagementError`): has no branch for `ManagedConnectorCloudError`, so it rethrows to the global handler, which answers 500 `INTERNAL_ERROR`.
- `apps/server/src/routes/connector-resources.ts:98-135` (`sendResourceError`): answers a catch-all 500 with **no log at all**. `/apps/:toolkit/actions` turns every refusal into 502 `actions_unavailable`.
- `apps/server/src/services/connectors/resources/app-actions-service.ts:296-328`: `catch {}` drops the cause.
- `apps/server/src/services/connectors/providers/managed/managed-cloud.ts:322-335`: every non-link cloud error becomes `MANAGED_EXECUTION_OUTCOME_UNKNOWN`, with no log.
- `apps/server/src/services/connectors/bootstrap.ts:684,1037,1043` and `services/core/auth/cloud-link.ts:791`: log `.message` only, which is the generic sentence.
- `apps/server/src/middleware/error-handler.ts:18`: logs the message and stack. It has no method, path, code or status.
- `apps/server/src/routes/cloud.ts:110`, `cloud-communities.ts:210,226`, `services/core/cloud/credits-inference.ts:169`: `/v1` read failures log without `problem.code`, and a received Problem becomes 502 "Could not reach".
- `apps/client/src/layers/shared/lib/transport/http-client.ts:72-93`: `fetchJSON` already keeps `code`, `status` and `body`, so a server code does reach the client.
- `apps/client/src/layers/features/connections/ui/access/ConnectionAccessCard.tsx:281-287`, `ConnectionAccessDialog.tsx:91-96`, `ui/AppActions.tsx:89-156`, `ui/panel/AccountPanel.tsx:74-77`: fixed failure copy that ignores the error.
- `apps/site/src/lib/connectors/managed/discovery-service.ts:222,258`: the switchable site fallback (`DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD`, `apps/site/src/proxy.ts`). It has the same strict-schema-over-spread bug as the server that failed in production.
- `packages/shared/src/connector-managed-discovery-schemas.ts`: the strict managed wire schemas. `ManagedConnectorOperationSchema` has no `displayName`/`important`, while the provider page schema allows both.

## 3) Codebase Map

- **Primary modules:** `cloud-link-client.ts` (parser and error type), `cloud-link.ts` (token wrapper, refusal handling), `connector-management.ts` and `connector-resources.ts` (route error mapping), `app-actions-service.ts`, `managed-cloud.ts`, `bootstrap.ts`, `middleware/error-handler.ts`; client access card, dialog, AppActions, AccountPanel; site `lib/connectors/managed/discovery-service.ts`.
- **Shared dependencies:** `@dorkos/shared/connector-managed-schemas` (legacy managed wire, vendored byte-for-byte by the private repo), `packages/cloud-api/src/problem.ts` (`/v1` envelope), `logger`/`logError`.
- **Data flow:** cloud HTTP response → `throwManagedConnectorCloudError` → `ManagedConnectorCloudError` → service → route error mapper → JSON `{error, code}` → `fetchJSON` error → card copy.
- **Feature flags/config:** `DORKOS_CLOUD_URL`; site `DORKOS_CLOUD_ACCOUNTS_ORIGIN` + `DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD`.
- **Blast radius:** every managed-connector call and its route; relink recovery (`bootstrap.ts:293`, `managed-authority-sync-service.ts`); Connections UI failure states (e2e specs may assert the old copy; see memory "UI copy breaks queue-only").

## 4) Root Cause Analysis

- **Repro:** link a computer to a DorkOS account, connect Gmail as a managed connection, open it in the side panel. `POST /api/connectors/reconciliation/previews` → 500. The control plane's `GET …/toolkits/gmail/operations` answers 400 `{"error":"invalid_request"}`, while `…/version` answers 200.
- **Observed vs expected:** the log should say which cloud call failed, with what status and code. Instead it said "turned the request down." with a stack. The card should say the problem is on DorkOS's servers and that nothing is wrong on this computer. Instead it said "Couldn't load who can use it".
- **Evidence:** `~/.dork/logs/dorkos.log` 2026-09-30 20:32–20:39, eight identical lines; a hand-made request with the instance key reproduced the 400.
- **Decision:** there are two independent defects here, a missing diagnostic path and a field-name drift (`code` vs `error`). The server-side 400 is the private item's.

## 5) Research

- **Potential solutions:**
  1. **Patch the parser only** (read `error`). This fixes relink, but the next unknown refusal is just as blind. Rejected.
  2. **Pin the legacy error body as a shared schema, carry it on the error, and map it honestly everywhere.** Add `ManagedConnectorErrorBodySchema` to `@dorkos/shared/connector-managed-schemas`, the home of the legacy managed wire, which the private repo vendors by hash, so both sides read one definition. `ManagedConnectorCloudError` gains `status`, `cloudCode`, `reason` and `path`. The route mappers get a branch for it, with structured logs. The client reads the code. Moderate size, and it closes the class.
  3. **Move to `/v1/connections/*` + Problem now.** This is the right end state, but it needs the control plane to serve those routes first. That is a programme, not a bug fix.
- **Recommendation:** 2 now, 3 as a filed follow-up. Choice 2 is designed so 3 is a transport swap: the error type and route mapping stay the same.

## 6) Decisions

| #   | Decision                                                 | Choice                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the legacy error body lives                        | `@dorkos/shared/connector-managed-schemas` (public), vendored by the private repo                                                                                                                                            | That module already owns the legacy managed wire; the private repo depends on it, never the reverse. `cloud-api` stays `/v1`-only.                                                                                                                                              |
| 2   | Which field the parser reads                             | `error` (the shape the cloud sends); tests rewritten to the real shape                                                                                                                                                       | Tests that mirrored the bug are the reason it shipped.                                                                                                                                                                                                                          |
| 3   | What the app's routes answer                             | Link needs updating → 409 `cloud_link_needs_update`; not linked → 401 `cloud_link_required`; cloud down/5xx/network → 502 `cloud_unavailable`; cloud said the request was bad → 502 `cloud_refused` (not our caller's fault) | Honest status for the caller; stable codes the client can branch on.                                                                                                                                                                                                            |
| 4   | Logging shape                                            | One `logger.warn('[CloudLink] managed request refused', {kind, method, path, status, cloudCode, reason})` at the single parser choke point; route mappers log only the unmapped remainder                                    | One line per refusal, at the one place every call passes.                                                                                                                                                                                                                       |
| 5   | Site fallback copy                                       | Fix the same strict-over-spread bug by explicit field mapping, plus a test through the real schema                                                                                                                           | It is live whenever the forward flag is off.                                                                                                                                                                                                                                    |
| 6   | `/v1/connections` migration                              | Out of scope; follow-up item                                                                                                                                                                                                 | Blocked on the control plane serving those routes.                                                                                                                                                                                                                              |
| 7   | Action names and the "important" flag on managed actions | Add `displayName` and `important` as optional fields to `ManagedConnectorOperationSchema` (public contract first); the app's managed provider carries them into `AppActions`                                                 | `app-actions-service.ts:343-345` already shows both for self-managed accounts; managed accounts lose them only because the wire cannot carry them. The cloud keeps omitting them until app versions that accept them are the floor, because older apps parse the page strictly. |

Next step: SPECIFY.
