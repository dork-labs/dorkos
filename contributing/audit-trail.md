# Audit trail

The audit log is one append-only, hash-chained table, `audit_events`, that records every action on a DorkOS server: who acted, on what, when, and how it came out. It is the record "trusted by default" rests on, so it has to be complete before any permission gate is loosened. Spec: `specs/audit-trail/02-specification.md`.

## Where things live

| Piece                          | File                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| Table, CHECK constraints       | `packages/db/src/schema/audit/audit-events.ts`                          |
| Migration + the three triggers | `packages/db/drizzle/20261006231015_audit_events.sql`                   |
| Wire shapes                    | `packages/shared/src/audit-schemas.ts` (`@dorkos/shared/audit-schemas`) |
| The one writer                 | `apps/server/src/services/audit/audit-log.ts` (`AuditLog`)              |
| Canonical JSON for the hash    | `apps/server/src/services/audit/canonical-json.ts`                      |
| Stable actor ids               | `apps/server/src/services/audit/account-ids.ts` (`AccountIds`)          |
| Activity → audit copy          | `apps/server/src/services/audit/activity-tee.ts`                        |
| `audit.verify` capability      | `apps/server/src/services/audit/audit-capabilities.ts`                  |
| `GET /api/audit/verify`        | `apps/server/src/routes/audit.ts`                                       |

## The invariants

1. **Append-only, enforced by SQLite.** `BEFORE UPDATE` and `BEFORE DELETE` triggers abort. Never write a code path that updates or deletes an audit row; there is no prune.
2. **The chain is enforced on insert.** A `BEFORE INSERT` trigger refuses a row whose `seq` is not `max + 1` or whose `prev_hash` is not the last row's `hash`. Only `AuditLog.record` computes those, inside one `IMMEDIATE` transaction. Do not insert into `audit_events` any other way.
3. **The hash contract.** `hash = sha256(prev_hash + canonicalJson(hashInput(row)))`. `hashInput` lists every column except `hash`, keyed by SQL column name, with NULL as `null`. Adding a column to `hashInput` changes what every existing row hashes to, so `verify` would call the whole log tampered. A new column must leave old rows hashing exactly as before (for example, include its key only when it is not NULL), and a test must prove an old row still verifies.
4. **Actors are stable ids.** Never record an agent's path or the word "You". Use `AccountIds`: an agent is its mesh ULID (read from the `agents` table, so it works before the mesh boots), an unregistered agent is `unregistered:<hash>`, the owner is their account id or `install:<install id>`.
5. **Redaction is the writer's job.** `record` sweeps every free-text field for anything that looks like a password or key (known prefixes, long hex, JWTs, URL passwords, `name=value` and `"name": "value"` where the name says secret), empties any member whose name says secret, and empties the values of any `change` on a `SENSITIVE_CONFIG_KEYS` field or a field whose path names a secret. It is best effort, and it is linear: free text is cut to 16,000 characters before the sweep and every pattern is bounded, because a quadratic pattern let one long string block the server for seconds. A test pins that. Numbers and yes/no values are never blanked (`maxTokens: 4096` is a setting, not a secret). Pass raw values; do not pre-redact. Redaction is a net, not a licence: never put a secret's value in `summary`; write "used secret X".
6. **`record` never throws.** It logs a warn and returns `undefined`, so a failing audit write cannot fail the action it records.

## Who acted: the audit scope

`services/audit/audit-context.ts` carries the actor across one async chain (an `AsyncLocalStorage`, like `lib/dispatch-context.ts`). Deep writers call `recordAudit(...)` from `services/audit/audit-trail.ts`, which takes the actor, surface, session and credential from the scope and falls back to DorkOS itself. Three edges enter a scope:

- `middleware/audit-actor.ts`, per request, after `sessionGate` and `resolveAgentIdentity`: the agent a token names (or `unidentified`), the account an API key or cookie proves, or the owner with login off.
- `core/mcp-tool-gate.ts`, per allowed hand-registered tool call, in session always (the scope there would otherwise be the person whose message started the turn) and on `/mcp` when the call carries an identity.
- `core/capabilities/registry.ts`, per invocation with an identity (`runAsAgent`).

A turn runs detached from the request that started it, so anything a tool does without one of the last two edges is recorded as the PERSON. When you add a new way for an agent to act, enter a scope for it. An in-session call with no identity is named `unidentified`, never the person (`runAsAgent(..., { inSession })`).

The request scope is lazy: the actor and credential are read the first time something asks, and remembered, so a read that records nothing costs nothing, and a gate that runs after the middleware (the `/mcp` authorizer) is still seen. Credential kinds: `agent-token` (hash of the presented token, matching its `agent_token.minted` row), `api-key`, `cookie`, `mcp-local`.

**Timers and loops inherit the scope they were created in.** A cron registered inside a person's request would name that person for every firing. Start long-lived work with `outsideAuditScope(callback)` / `runOutsideAuditScope(fn)` from `services/audit/audit-context.ts`; the scheduler's cron, the reconcilers, the sweeps and the lazily started loops already do (`services/tasks/__tests__/scheduler-audit-scope.test.ts` proves it with a real firing). A new `setInterval`/`Cron` that can be started from a request needs the same wrap.

## The request fallback

`middleware/audit-request-fallback.ts`, mounted right after `auditActor`, records `http.<method>` (route pattern with ids as `:id`, outcome from the status; never body or query) for any mutating `/api` request that finished with nothing recorded under its scope. Every successful `AuditLog.record` marks its scope and every enclosing scope as recorded (`markAuditScopeRecorded`), so a request a choke point covered, even in a narrower agent scope, adds nothing. A precise choke point is always better than this line: when you see `http.*` rows for a route that matters, add one. Conversation is never recorded here (`CONVERSATION`: chat messages, queued-message edits, room entries, reactions, threads, message attachments): it is speech, not action, and a person's private chat must not surface as rows the space can read. Requests that change nothing (`/read`, `/preview`, `/check`, `/probe`, `/heartbeat`, devtools ingest, …) are listed in `NOT_ACTIONS`. A row keeps the route with only id-shaped segments masked, so non-id segments such as a package name or the NAME of a secret setting do appear; values never do, because the body and query are never read.

`recordAudit` does nothing before `initAuditTrail` (set by `wireAuditTrail` at startup), so a unit test that does not set one up is unaffected.

## What PR2 records, and where

| Action                                                                                                                                                                  | Choke point                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mcp.<tool>` (act/destructive tools that ran; `links.approvalId` when a granted token was spent)                                                                        | `core/mcp-tool-gate.ts` `invokeAudited`                                                              |
| `capability.invoked/failed` by an unidentified caller (act tier)                                                                                                        | `core/agent-identity/capability-attribution.ts`, audit only, not Activity                            |
| `config.changed` with per-leaf before/after                                                                                                                             | `core/operator/config-write.ts` (both the guarded write and `logConfigWrite`)                        |
| `marketplace.installed/updated/uninstalled` (version and short commit before/after), `marketplace.update_failed` (`remove` when the old version is gone, else `modify`) | `MarketplaceInstaller.install/update`, `UninstallFlow.uninstall` (not the removal half of an update) |
| `auth.signed_in/signed_out/session_revoked/session_expired/session_ended/sign_in_failed/sign_in_rate_limited` (admins), `account.linked`, `api_key.created/revoked`     | `core/auth/auth-audit.ts`, Better Auth hooks, `middleware/auth-rate-limit.ts`                        |
| `agent_token.minted/revoked`                                                                                                                                            | `agent-identity/agent-token-env.ts`, `unregister-cascade.ts`                                         |
| `room.merged` (the merger, not the commit author)                                                                                                                       | `rooms/repo/room-merge-service.ts`                                                                   |
| `http.<method>` for any mutating `/api` request nothing else recorded                                                                                                   | `middleware/audit-request-fallback.ts`                                                               |

## Runtime tool calls (PR3)

`services/audit/record-tool-use.ts` wraps every runtime at the registration seam (`core/runtime-seam/decorate-runtime.ts`) and writes one `runtime.tool_used` row per tool call when it settles (`status` `complete` or `error`). It reads only the runtime-neutral `StreamEvent`s, so a new runtime is covered as long as its mapper emits `toolCallId`, `toolName`, `input` and a terminal `status`. Rules a change here must keep:

- Claude's `tool_call_end` is not terminal (DOR-2011); only a terminal status settles a call, and a call settles once.
- DorkOS's own tools are skipped, as each runtime spells them (`mcp__dorkos__*` for Claude Code and Codex, `dorkos_*` for OpenCode, the bare `MCP_TOOL_TIERS` name for Doe); the gate records them. Only the running runtime's spelling counts.
- A call still open when the turn ends is recorded once as `runtime.tool_started` and remembered for its session; its result, in a later turn or by another route, records `runtime.tool_used` once (`recordRuntimeToolCall` settles by session and call id). Never record a guessed `failed`.
- Helper agents: Claude Code's helper calls never reach the stream, so `runtimes/claude-code/audit-tool-hooks.ts` records them from the SDK `PostToolUse`/`PostToolUseFailure` hooks (only inputs with an `agent_id`); Doe's arrive through `DoeTurnEvents.onHelperTool`. Codex and OpenCode report only a helper's start (`runtime.helper_started`), and the guide says so.
- The actor is the agent whose home the turn stands in, resolved by `resolveAgentHome` like every other turn-path identity check (`toolActorOf`), named by its mesh id and display name.
- The actor is named explicitly on each row: an async generator's body runs in its consumer's ALS context, so the scope is not reliable there.
- Target extraction is `toolTarget`; add a tool shape there with a row in its test table. Never record a full input or output: the transcript already has it. A target is swept for secrets before it is cut short, and the writer sweeps `target.id` as well as `target.name`.

## One or the other, never both

A choke point records an action in ONE of two ways:

- It writes Activity (`activityService.emit`). The tee copies the row into the audit log with `links.activityId`.
- It calls `auditLog.record(...)` directly, for actions that have no place in the human feed.

Doing both records the action twice. If you add a direct `record` call next to an existing `emit`, remove one of them.

The one deliberate layering: the MCP gate's `mcp.<tool>` row says a TOOL ran, and the domain may also record what that tool changed (`tasks_delete` writes `tasks.task_deleted` to Activity). Those are two facts at two levels, both under the same actor and session, not one fact twice.

Long hex is redacted as a possible secret, so record a commit or digest by its 12-character short form.

## Adding a choke point

1. Decide the action name (`domain.verb`, matching Activity's style), the `operation`, and the target.
2. Resolve the actor through `AccountIds`. Prefer the identity the request or turn already resolved over guessing.
3. Choose `visibility`: `space` for actions (the default and almost always right), `admins` for security records such as sign-in IPs, `participants` only for something scoped to a private conversation (name the participants).
4. Write a test that the action produces exactly one row with the right actor, and run it once with your call removed to prove it fails.

## Checking the chain

`AuditLog.verify({ fromSeq?, limit? })` walks the chain and names the first break. One call walks at most 100,000 rows (`AUDIT_VERIFY_MAX_ROWS`), because the walk is synchronous and any agent may ask for it; when rows remain, the answer carries `nextFromSeq` (always the row that SHOULD come next, so a gap at a page boundary is reported by the next page). Pass the previous page's `lastHash` as `prevHash` to check the link across the boundary; without it the stored row before `fromSeq` is used. It is exposed as the `audit.verify` capability (`audit_verify` on both MCP servers, `dorkos call audit.verify`, `GET /api/audit/verify`). The server also checks the last 1,000 rows at startup and warns if they break.

The triggers stop the app, not somebody with `sqlite3` and the file; the chain makes such an edit detectable afterwards, with two gaps: rows removed from the END, and a forged row followed by every later row rehashed, both verify clean. Closing them needs a checkpoint (last seq and hash) stored somewhere a local agent cannot write, which is a follow-up in the spec. Never describe the check as catching more than that.

One more `sqlite3` caveat: the app's connection sets `recursive_triggers = ON` (`packages/db/src/index.ts`), but the `sqlite3` shell defaults it to OFF, and with it off an `INSERT OR REPLACE` that collides on `id` deletes the old row without firing the delete trigger. The chain-link trigger still refuses any row that is not `max + 1`, so such a replace leaves a hole `verify` reports as a missing row: not a silent bypass, but a way round the delete trigger.

## Activity retention

Activity keeps `activity.retentionDays` days (default 365; `DORKOS_ACTIVITY_RETENTION_DAYS` overrides). The `permissions` category is never pruned. The audit log is never pruned.
