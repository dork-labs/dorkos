---
covers:
  - 'feat(api): every capability door answers a refusal as a problem document (DOR-4979)'
  - "refactor(api): debug's chat reads answer problems, and the old session-not-found body is gone (DOR-4979)"
  - 'fix(api): review round 1 on the capability refusals (DOR-4979)'
---

### Changed

- Actions you run through the API, by `POST /api/capabilities/{id}/invoke` or by their own address (such as pausing an agent or listing its MCP servers), now answer every error in the one standard format, `application/problem+json`, like the rest of the API. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what to do. A request that waits for a person's yes is not an error and still answers `202` with the approval (DOR-4979)
- A sign-in to an MCP server that could not start no longer shows the server's raw answer under Details. The plain reason, and the offer to add your own app credentials when that would help, are unchanged (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these actions directly.** The old `{ error, code }` body is gone: read `code` for the kind of problem and `detail` for the message. The DorkOS app and the `dorkos` command already read the new format. Agents calling the same actions as MCP tools see no change (DOR-4979)
- **A refused action now says why in its `code`:** a person said no (`declined`), a request is already waiting on a person (`needs_approval`), or the agent's permissions block it (`forbidden`). The old `status: "denied"` and `reason` fields are gone; `capabilityId`, `tier`, `approvable` and `approvalId` still sit beside `code` (DOR-4979)
- **Codes now in lower case, or folded into a shared one:** `UNKNOWN_CAPABILITY` is `unknown_capability`; `NOT_READY` and `EXTENSION_TOOL_UNAVAILABLE` are `temporarily_unavailable`; `NOT_FROM_WIFI` is `not_from_wifi`; `AGENT_IDENTITY_UNVERIFIED` is `agent_identity_unverified` (now 401, was 400); `CANNOT_RESUME_SELF` is `forbidden`; `AGENT_NOT_FOUND` and every other "not found" code is `not_found`; `SIGNIN_NO_APP_REGISTRATION`, `SIGNIN_NO_SIGNIN_SUPPORT` and `SIGNIN_UNREACHABLE` are `signin_no_app_registration`, `signin_no_signin_support` and `signin_unreachable`; `SPEND_LIMIT` is `spend_limit_reached`; on `POST /api/connectors/executions`, `CONNECTOR_GRANT_REQUIRED` is `forbidden`, and `CONNECTOR_AGENT_NOT_OWNED` is `forbidden` (now 403, was 409). A code that is already on the shared list keeps it in lower case (`AGENT_PAUSED` is `agent_paused`, `ROOM_ARCHIVED` is `room_archived`). Any refusal with no closer code is 400 `invalid_request` (DOR-4979)
- **Statuses that changed on these actions** (each was 400 unless it says otherwise) (DOR-4979):
  - 500 `internal_error`: DorkOS's own failures, such as `DISCOVER_FAILED`, `SEND_FAILED` and `REGISTER_FAILED`, and an agent settings file it can't read (`MANIFEST_UNREADABLE`).
  - 429 `rate_limited`: `RATE_LIMITED` and other "too many requests" codes.
  - 401 `agent_identity_unverified`: `UNIDENTIFIED_CALLER`, `UNKNOWN_CALLER` and other callers DorkOS couldn't confirm.
  - 403: `person_only` for codes that need a person (`NEEDS_A_PERSON`, `PERSON_ONLY_MODE`); `forbidden` for refusals of this caller (`SPEND_OUTSIDER`, `…_DENIED`, `…_NOT_OWNED`, `SYSTEM_AGENT`); `needs_approval` for one that waits on a person's yes (`APPROVAL_REQUIRED`, which `POST /api/connectors/executions` answered with 409).
  - 412 `precondition_failed`: anything that changed since you looked (`…_CHANGED`, `…_MISMATCH`, `STALE_…`).
  - 409: `conflict` for a name already taken or a limit that is full; `already_resolved` for something already cancelled or ended.
  - 503 `temporarily_unavailable`: something not available yet or switched off (`…_UNAVAILABLE`, `…_DISABLED`, `…_TIMEOUT`).
  - 413 `request_too_large` and 501 `not_supported` where the code says so.
