---
covers:
  - 'feat(api): every capability door answers a refusal as a problem document (DOR-4979)'
  - "refactor(api): debug's chat reads answer problems, and the old session-not-found body is gone (DOR-4979)"
---

### Changed

- Actions you run through the API, by `POST /api/capabilities/{id}/invoke` or by their own address (such as pausing an agent or listing its MCP servers), now answer every error in the one standard format, `application/problem+json`, like the rest of the API. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what to do. A request that waits for a person's yes is not an error and still answers `202` with the approval (DOR-4979)
- A sign-in to an MCP server that could not start no longer shows the server's raw answer under Details. The plain reason, and the offer to add your own app credentials when that would help, are unchanged (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these actions directly.** The old `{ error, code }` body is gone: read `code` for the kind of problem and `detail` for the message. The DorkOS app and the `dorkos` command already read the new format. Agents calling the same actions as MCP tools see no change (DOR-4979)
- **A refused action now says why in its `code`:** a person said no (`declined`), a request is already waiting on a person (`needs_approval`), or the agent's permissions block it (`forbidden`). The old `status: "denied"` and `reason` fields are gone; `capabilityId`, `tier`, `approvable` and `approvalId` still sit beside `code` (DOR-4979)
- **Codes now in lower case, or folded into a shared one:** `UNKNOWN_CAPABILITY` is `unknown_capability`; `NOT_READY` and `EXTENSION_TOOL_UNAVAILABLE` are `temporarily_unavailable`; `NOT_FROM_WIFI` is `not_from_wifi`; `AGENT_IDENTITY_UNVERIFIED` is `agent_identity_unverified` (now 401, was 400); `CANNOT_RESUME_SELF` is `forbidden`; `AGENT_NOT_FOUND` and every other "not found" code is `not_found`; `SIGNIN_NO_APP_REGISTRATION`, `SIGNIN_NO_SIGNIN_SUPPORT` and `SIGNIN_UNREACHABLE` are `signin_no_app_registration`, `signin_no_signin_support` and `signin_unreachable`; `SPEND_LIMIT` is `spend_limit_reached`; on `POST /api/connectors/executions`, `CONNECTOR_GRANT_REQUIRED` is `forbidden`, and `CONNECTOR_AGENT_NOT_OWNED` is `forbidden` (now 403, was 409). Anything that changed since you looked is 412 `precondition_failed`, and any other refusal is 400 `invalid_request` (DOR-4979)
