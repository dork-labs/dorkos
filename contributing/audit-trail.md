# Audit trail

The audit log is one append-only, hash-chained table, `audit_events`, that records every action on a DorkOS server: who acted, on what, when, and how it came out. It is the record "trusted by default" rests on, so it has to be complete before any permission gate is loosened. Spec: `specs/audit-trail/02-specification.md`.

## Where things live

| Piece                            | File                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Table, CHECK constraints         | `packages/db/src/schema/audit/audit-events.ts`                               |
| Migration + the three triggers   | `packages/db/drizzle/20261006231015_audit_events.sql`                        |
| Wire shapes                      | `packages/shared/src/audit-schemas.ts` (`@dorkos/shared/audit-schemas`)      |
| The one writer                   | `apps/server/src/services/audit/audit-log.ts` (`AuditLog`)                   |
| Canonical JSON for the hash      | `apps/server/src/services/audit/canonical-json.ts`                           |
| Stable actor ids                 | `apps/server/src/services/audit/account-ids.ts` (`AccountIds`)               |
| Activity → audit copy            | `apps/server/src/services/audit/activity-tee.ts`                             |
| The `audit.*` capabilities       | `apps/server/src/services/audit/audit-capabilities.ts`                       |
| `/api/audit` routes              | `apps/server/src/routes/audit.ts`                                            |
| The one reader rule              | `apps/server/src/services/audit/visibility.ts` (`canRead`)                   |
| Who may read a session           | `apps/server/src/services/audit/session-visibility.ts`                       |
| The reader of an HTTP request    | `apps/server/src/routes/audit-reader.ts`                                     |
| The `/api/sessions/:id` guard    | `apps/server/src/routes/session-read-guard.ts`                               |
| Who may read a room turn         | `apps/server/src/services/rooms/session-bindings/room-session-visibility.ts` |
| Audit rows as a reader sees them | `apps/server/src/services/audit/audit-session-scrub.ts`                      |
| Secret sweep before hashing      | `apps/server/src/services/audit/audit-redaction.ts`                          |

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

## Pausing an agent (PR5)

`services/mesh/pause/` holds the lever: `AgentPauseService` (`agent-pause.ts`), the backstop (`hold-paused-turns.ts`) and the capabilities (`pause-capabilities.ts`). Current state is one row per paused agent in `agent_pauses` (`packages/db/src/schema/mesh.ts`), held in memory and written through, so a pause survives a restart; the history is the audit rows below.

| Row                                                                                 | Written by                            | Actor                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| `agent.paused` (`change: paused false→true`, `reason`)                              | `AgentPauseService.pause`             | whoever paused it (the capability's caller) |
| `agent.resumed`, `outcome: ok` or `refused` with `error: CANNOT_RESUME_SELF`        | `AgentPauseService.resume`            | whoever asked                               |
| `agent.turn_held` (`outcome: refused`, `error: AGENT_PAUSED`), one per held trigger | `recordHeld`, from each refusal point | `system`                                    |

Rules a change here must keep:

- **The hold is at the runtime seam.** `holdPausedAgents` is the outermost decorator in `decorateRuntime`, so a paused agent starts no turn from any surface, on any runtime, including one added later. It resolves the agent exactly as `toolActorOf` does (`resolveAgentHome(cwd, turnAgentOf(opts))`), so a worktree or managed checkout of the agent counts. It also remembers every live turn, which is how a pause interrupts them (`runtime.interruptQuery`) without a per-runtime list, and which agent each session it ran belongs to. It intercepts `sendMessage`, `executeCommandIntent` (a summary is a turn), `deliverIntoTurn` and `canStageSession` (a steer is refused as `stream-closed` and a stage as `unsupported`, so neither boots the agent's process; the queued message then meets the hold) and `onRuntimeTurn`: a turn the agent opens on its own (a helper reporting back, a wake-up timer) has no dispatch to refuse, so it is stopped as it opens and its session ended. A pause marks each tracked turn `stopRequested` whatever its runtime answered, because a turn still launching (signing in, reading settings) answers `not-running`; the hold reads the latch at the turn's next event, ends the session and throws. A refused queued message reaches the chat as an `AGENT_PAUSED` error event (the agent id in `reason`, no stack), which the app renders as the paused notice with Resume. Doe's `runBeat` never passes `sendMessage`, so it checks the pause itself. With no folder in a turn's options, it reads the session's stored one (`getSessionCwd`).
- **A pause ends the agent's sessions, not just its turns.** `AgentRuntime.endSessionsWhere` (required on every runtime, conformance E1/E2) ends every session the runtime holds live from its OWN records: the turn, the background helpers and shells, the warm process and its timers. Claude Code evicts the process; Codex stops the background work and unloads the thread; OpenCode and Doe have only turns. The count a pause reports is the sessions whose stop was acknowledged.
- **Entry points refuse earlier, with a clearer answer**, and each records its one `agent.turn_held`: `launch-session.ts` (a message: `AGENT_PAUSED`, `409` with `agentId`, the app offers Resume), the scheduler (a `skipped` run, `AGENT_PAUSED_SKIP_REASON`, Run now included), the room runner (throws `AgentPausedError`; the room writes one `agent_paused` notice per pause, keyed to `pausedAt`). A scheduled task writes one `agent.turn_held` per pause, its later skipped fires only their run rows. Relay and connector deliveries rely on the backstop.
- **Held triggers are never replayed** on resume.
- **Unregistering drops the pause** (`unregister-cascade.ts` calls `AgentPauseService.forget`), so no row outlives its agent.
- **The limit:** a request with no agent token is treated as the person, so a process the agent started outside any runtime's records (a detached script) could call the API as the person, `resume` included. `endSessionsWhere` closes the processes DorkOS knows about; `docs/guides/agents.mdx` states the rest.
- **Nobody lifts their own pause.** `resume` refuses an agent actor whose id is the paused agent's, and an `unidentified` caller (it could be that agent). Anyone may pause anyone, DorkBot included.
- **No approval card, ever.** `agent.pause` and `agent.resume` are `act` with no area, and `NEVER_ASKS_ACTIONS` in `permission-enforcement.ts` keeps them out of every area even if one is declared. A revoked identity is still refused by the tier gate.

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

## Who can read what (PR4)

`canRead(reader, row)` in `services/audit/visibility.ts` is the ONLY reader rule. Every read path goes through it: the four read capabilities (`audit.query`, `audit.get`, `audit.account_timeline`, `audit.transcript_read`), the `/api/audit` routes, the session routes and stream, and search. Never write a second check.

- `space` rows: everyone. `participants` rows: the accounts listed. `admins` rows: the owner, never an agent.
- The owner of this one-person install reads everything. Any caller that presented an agent token, resolved or not, reads as that agent (or as `unidentified`).
- `readableBy(reader)` is the same rule as SQL, so a page is filled with rows the reader may see rather than filtered after the `LIMIT`. `visibility.test.ts` checks the two agree row for row; change both or neither.

**Sessions** are `space`, `participants`, or (a room turn only) a room's agent members, read through the same `canRead` (`canReadSession`). What started the session decides: `sessionVisibilityForOrigin` in `services/session/origin/turn-origin.ts` maps every `TurnOrigin` (an exhaustive switch, so a new origin does not compile until someone decides). It reads `session_metadata.launch_origin`, which the binding write already stores first-write-wins; a session with none (older, or a bare-CLI one) is agent work only when a room binding, a task run or a recorded starter says so, and private otherwise. Unknown is private.

The process-wide lookup is set once in `index.ts` (`initSessionVisibility`). Unset (most unit tests), every session is private: agents are refused, the owner is unaffected. A test that reads a session as an agent sets one.

A **room turn** is the one origin that does not decide by itself: its room does (`resolveRoomSessionVisibility`). A bridged chat-app room or a DM with a person is private; a team channel or a DM between agents is readable by that room's agent members (and the owner), checked as membership stands at read time. The resolver names them by the same account id an agent reader carries (`AccountIds.agentAccountId` of the agent's home), so pass that, not a mesh name. A chat carried to another account (`account-handoff`) reads as the chat it continues. The spec §3.4 "As built (PR4 review)" table is the full rule.

**The one exception** lives next to the rule: `canReadSession(reader, visibility, involvedBy)`. A person's private chat that started a chat may be read by that chat (`chat_read`, through `mayReadChat`). A message is not involvement: any agent can message a person's chat and draw a reply, so a reply never opens their history. Pass `involvedBy` from nowhere else. `chat_send` names the chat it landed in only when the sender may read it (`maySeeChat`).

Over HTTP, `routes/audit-reader.ts` names the reader (`readerOfRequest`) and answers a private session with **404 `SESSION_NOT_FOUND`, never 403**, so an agent cannot confirm a person's chat exists. `transcript_read` answers `TRANSCRIPT_PRIVATE` for the same case and for an unknown id alike. Every `/api/sessions/:id/*` route is already behind `router.param('id', guardSessionParam)` (`routes/session-read-guard.ts`), so a new route there needs nothing; a transcript read anywhere else calls `refuseUnreadableSession` (one id) or `readableSessions` (a list) before it reads anything. A frame on `GET /api/events` about a session goes out with `sessionAudience(sessionId)`. A list that names sessions (the debug lists, `binding_list_sessions`) drops, or strips the id from, rows about a session the caller may not read. An agent that starts a chat over HTTP binds it `agent-launch` (`httpTurnOrigin`), so it can read its own chat.

**Audit rows** that point into a session the reader may not read lose `sessionId`, `turnId` and `toolCallId`, and a `sessionId` filter on one answers an empty page. A `targetId` filter that hid every row on a page drops the cursor too, so the page reads as the last one. Read the log through `readAuditQuery`, `readAuditTimeline` and `readAuditEvent` (`services/audit/audit-session-scrub.ts`), never `log.query` directly, from anything a caller reaches.

**The limit, stated plainly.** A caller is an agent only when it says so (`X-DorkOS-Agent`, or DorkOS's in-session tools). A bare request reads as the owner, and transcript files on disk are open to any program on the computer. Never describe this as keeping chats from agents without that qualifier.

## Checking the chain

`AuditLog.verify({ fromSeq?, limit? })` walks the chain and names the first break. One call walks at most 100,000 rows (`AUDIT_VERIFY_MAX_ROWS`), because the walk is synchronous and any agent may ask for it; when rows remain, the answer carries `nextFromSeq` (always the row that SHOULD come next, so a gap at a page boundary is reported by the next page). Pass the previous page's `lastHash` as `prevHash` to check the link across the boundary; without it the stored row before `fromSeq` is used. It is exposed as the `audit.verify` capability (`audit_verify` on both MCP servers, `dorkos call audit.verify`, `GET /api/audit/verify`). The server also checks the last 1,000 rows at startup and warns if they break.

The triggers stop the app, not somebody with `sqlite3` and the file; the chain makes such an edit detectable afterwards, with two gaps: rows removed from the END, and a forged row followed by every later row rehashed, both verify clean. Closing them needs a checkpoint (last seq and hash) stored somewhere a local agent cannot write, which is a follow-up in the spec. Never describe the check as catching more than that.

One more `sqlite3` caveat: the app's connection sets `recursive_triggers = ON` (`packages/db/src/index.ts`), but the `sqlite3` shell defaults it to OFF, and with it off an `INSERT OR REPLACE` that collides on `id` deletes the old row without firing the delete trigger. The chain-link trigger still refuses any row that is not `max + 1`, so such a replace leaves a hole `verify` reports as a missing row: not a silent bypass, but a way round the delete trigger.

## Activity retention

Activity keeps `activity.retentionDays` days (default 365; `DORKOS_ACTIVITY_RETENTION_DAYS` overrides). The `permissions` category is never pruned. The audit log is never pruned.
