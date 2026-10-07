---
slug: audit-trail
number: 261006-225901
created: 2026-10-06
status: specified
---

# Audit trail v1: every action recorded, readable by space members and agents

**Status:** Draft
**Author:** Claude (SPECIFY for Dorian Collier)
**Date:** 2026-10-06
**Linear:** DOR-2738
**Ideation:** [`01-ideation.md`](./01-ideation.md)

## Overview

DorkOS gains one append-only, hash-chained log of actions, `audit_events`, written by one service, `services/audit/audit-log.ts`. Every Activity event lands in it, and the paths that today leave no record at all are wired into it: allowed calls to the hand-registered MCP tools, unattributed `act` calls through the capability registry, config writes (with a redacted field diff), marketplace changes, sign-ins and key/token lifecycle, room merges, and every tool call an agent makes inside Claude Code, Codex or OpenCode. People and agents read it through MCP tools, HTTP routes and the app, under one visibility rule: actions are public to the space, a person's own private chats stay with their participants, security records stay with admins. Agents can read other agents' work transcripts. A "pause this agent everywhere" lever lets anyone stop an agent and lets anyone lift the pause, and both are recorded.

It lands in five PRs, in order, each green on its own. It must land before any permission gate is loosened (DOR-2739).

## Background / Problem Statement

Verified against `8b5b7b51b` (line numbers are as of that commit):

1. **No record for allowed hand-registered MCP calls.** `core/mcp-tool-gate.ts` (module doc, "What is audited, and what is not") states it writes nothing when a call is allowed, including a destructive call a person approved. That covers ~47 tools, including `mesh_deny` and `mesh_unregister` (`runtimes/claude-code/mcp-tools/mesh-tools.ts:425,434`).
2. **Unattributed registry calls are silent.** `core/agent-identity/capability-attribution.ts` records `observe`/`act` invocations only when an agent identity resolved; destructive ones always. Once gates go away, an unattributed `act` is the common case.
3. **No config history.** `core/operator/config-write.ts:540-546` logs only the touched key names to the rotating server log.
4. **Runtime tool calls exist only in transcripts.** Bash, edits, fetches: most of what an agent does.
5. **Activity is pruned and mutable.** 30 days (`index.ts:1403`, `DORKOS_ACTIVITY_RETENTION_DAYS`), no trigger, `prune()` deletes. It names agents by path (`services/activity/activity-actor.ts:77`), so moving an agent splits its history. With login off the person has no id ("You").
6. **The "sessions are reachable by no agent" rule is a promise about search only.** `routes/search.ts:94-96` enforces it. `GET /api/sessions`, `/recent`, `/:id`, `/:id/messages` (`routes/sessions.ts:241,286,445,557`) and the live stream `GET /:id/events` (`:1449`, `routes/session-events-handler.ts`) do not check agent identity. Under the new rule, agents SHOULD read agent work, and MUST NOT read a person's private chats, so both halves are wrong today.
7. **No single pause.** Stopping an agent today means interrupting each session, pausing each schedule, and so on.
8. **Nothing is tamper-evident.** No hash chain anywhere.

## Goals

- One store that is a superset of every action DorkOS records, with stable ids, append-only enforced by SQLite, and a verifiable hash chain.
- Every path in Background 1-4 recorded, for all three runtimes.
- People and agents read it under one visibility rule, enforced for agent readers now.
- A pause lever any member can pull and any member can lift.

## Non-goals

- Loop guards: cascade guard, turn budgets, relay ceilings.
- Removing or loosening any permission gate (DOR-2739).
- Signed checkpoints stored off-machine, export (JSONL/OCSF), suspend, rotate, revert, roles, spaces. See "Out of scope / follow-ups".
- Recording reads of non-private content, reactions, canvas versions, community mirror redactions.
- Making the audit log resistant to an agent holding `sqlite3` and the DB file. The chain makes edits detectable by `audit.verify`; proving them needs an off-machine checkpoint (follow-up).

## Technical Design

### 3.1 The event

`packages/db/src/schema/audit/audit-events.ts`, table `audit_events`:

| Column                                                    | Type        | Notes                                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`                                                     | integer PK  | Gap-free, assigned by the writer as `max+1` inside the insert transaction.                                                                                                                                  |
| `id`                                                      | text unique | ULID.                                                                                                                                                                                                       |
| `at`                                                      | text        | ISO 8601 UTC.                                                                                                                                                                                               |
| `space_id`                                                | text null   | `null` = this server's one-person space.                                                                                                                                                                    |
| `actor_id`                                                | text        | Stable account id (§3.2). Never a path, never "You".                                                                                                                                                        |
| `actor_kind`                                              | text        | `person` / `agent` / `system` / `external`. CHECK constraint.                                                                                                                                               |
| `actor_name`                                              | text        | Name at the time.                                                                                                                                                                                           |
| `on_behalf_of`                                            | text null   | JSON `[{accountId, via}]`, `via` ∈ `schedule / delegation / room-turn / extension / bridge`.                                                                                                                |
| `credential`                                              | text null   | JSON `{kind, idHash}`; `kind` ∈ `cookie / api-key / agent-token / mcp-local`; `idHash` is the first 12 hex of sha256 of the credential id, never the credential.                                            |
| `source`                                                  | text        | JSON `{surface, runtime?, sessionId?, turnId?, taskRunId?, toolCallId?}`; `surface` ∈ `app / http / mcp / cli / relay / task / bridge / runtime-tool / system`. IP and user agent go only on `admins` rows. |
| `action`                                                  | text        | `domain.verb`, e.g. `config.changed`, `runtime.tool_used`, `agent.paused`. Indexed.                                                                                                                         |
| `operation`                                               | text        | `create / modify / remove / access / execute / auth`. CHECK constraint.                                                                                                                                     |
| `target_type`, `target_id`, `target_name`, `container_id` | text null   | Flattened so they can be indexed for the timeline query.                                                                                                                                                    |
| `outcome`                                                 | text        | `ok / failed / refused`. CHECK constraint.                                                                                                                                                                  |
| `error`                                                   | text null   | Short code or message, secret-redacted.                                                                                                                                                                     |
| `change`                                                  | text null   | JSON `[{field, before?, after?, redacted?}]`.                                                                                                                                                               |
| `reason`                                                  | text null   | Given by the actor, ≤ 500 chars.                                                                                                                                                                            |
| `links`                                                   | text null   | JSON `{activityId?, approvalId?, traceId?, causedBy?, connectorAttemptId?}`.                                                                                                                                |
| `summary`                                                 | text        | One plain-language line for the app, like Activity's.                                                                                                                                                       |
| `visibility`                                              | text        | `space / participants / admins`. CHECK constraint.                                                                                                                                                          |
| `participants`                                            | text null   | JSON array of account ids, required when `visibility = 'participants'`.                                                                                                                                     |
| `prev_hash`                                               | text        | 64 hex; genesis is 64 zeros.                                                                                                                                                                                |
| `hash`                                                    | text        | `sha256(prev_hash + canonicalJson(row without hash))`, lowercase hex.                                                                                                                                       |

A plain `session_id` column (copied from `source.sessionId` by the writer) makes the per-session query indexable. Indexes: `(actor_id, seq)`, `(target_id, seq)`, `(action, seq)`, `(session_id, seq)`, `(at)`.

**Append-only and chain-linked by trigger.** The migration copies the connector ledger pattern (`drizzle/0086_perfect_whiplash.sql:224-254`): `BEFORE UPDATE` and `BEFORE DELETE` triggers that `RAISE(ABORT, 'audit events are append-only')`. It adds one `BEFORE INSERT` trigger that aborts unless `NEW.seq = COALESCE((SELECT MAX(seq) FROM audit_events), 0) + 1` and `NEW.prev_hash` equals the hash of that row (or 64 zeros for seq 1). So even a bug in the writer cannot fork or gap the chain through the app. The triggers are hand-appended to the drizzle-generated migration, as 0086 did; `pnpm --filter @dorkos/db db:check` must stay green.

**Canonical JSON**: keys sorted at every depth, `undefined` dropped, no whitespace. One exported pure function in `services/audit/canonical-json.ts`, unit-tested against fixed vectors, so a verifier in another process (or language) can reproduce it.

### 3.2 Stable account ids

`services/audit/account-ids.ts`, one resolver used by every writer:

| Caller                                                    | `actor_id`                                                                                                                                                                                                          | `actor_kind` |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Agent with a resolved identity                            | Mesh ULID from `meshCore.getByPath(agentPath)`; else the `id` in its `.dork/agent.json` (`readManifest`); else `unregistered:` + first 16 hex of sha256(path). Path goes into nothing but the last fallback's hash. | `agent`      |
| Agent header present, not resolved                        | `unidentified`                                                                                                                                                                                                      | `external`   |
| Signed-in person or per-user API key                      | Better Auth user id                                                                                                                                                                                                 | `person`     |
| Login off, no header (the owner at this computer)         | The owner account's user id when one exists (`findOwnerAccount`), else `install:` + the install id (`lib/instance-id.ts`, the same id connectors already treat as the local owner, `index.ts:1152`)                 | `person`     |
| DorkOS itself (startup, GC, scheduler fire with no agent) | `system`                                                                                                                                                                                                            | `system`     |
| Chat-platform user via a bridge                           | `bridge:<platform>:<sha256(platformUserId)[:16]>`                                                                                                                                                                   | `external`   |

When the first Better Auth account is created, the auth hook (PR2) records `account.linked` (`change: [{field:'accountId', before:'install:…', after:'<userId>'}]`); `account_timeline` treats the two as one account. Activity's own `actor_id` stays the path in v1 (its client filters and links depend on it); only audit keys on ULIDs.

### 3.3 The writer

`services/audit/audit-log.ts`, class `AuditLog`:

- `record(event: AuditInput): AuditEvent | undefined` is synchronous (better-sqlite3), wraps read-tail + insert in one `IMMEDIATE` transaction, computes `seq`, `prev_hash`, `hash`, never throws (logs a warn and returns `undefined`), and redacts at write, best effort: `error`, `reason`, `summary`, `target.name` and every string inside `change` are swept for credential prefixes, long hex, JWTs, URL passwords and `name=value` / `"name": "value"` pairs whose name says secret; any object member named like a secret is emptied; and any `change` on a `SENSITIVE_CONFIG_KEYS` field or on a path with a secret-named segment becomes `{field, redacted: true}` with no values.
- `observe(fn)` mirrors `ActivityService.observe` (a set of observers, each guarded). PR5's pause detector and later the loop judge ride it.
- `verify({fromSeq?, limit?}): {ok, checked, lastSeq, lastHash, firstBreak?: {seq, reason}, nextFromSeq?}` walks the chain and recomputes every hash, at most 100,000 rows per call (the walk is synchronous and any agent may ask), answering `nextFromSeq` (the next expected seq) when rows remain, and taking the previous page's `lastHash` as `prevHash` so the cross-page link is checked. It catches a changed row and a row removed from the middle; it does NOT catch rows removed from the end, or a forged row with every later row rehashed. Those need the off-machine checkpoint (follow-up), and no doc may claim otherwise.
- On startup it verifies the last 1,000 rows and logs a warn naming the first break; it does not stop the server.

**Actor context without threading.** `services/audit/audit-context.ts`: an `AsyncLocalStorage<AuditActorContext>` modelled on `lib/dispatch-context.ts`. A middleware mounted right after `resolveAgentIdentity` enters it per request (actor, credential, surface `http` or `app`); the MCP gate wrappers enter it per tool call (surface `mcp`); the runtime Proxy (PR3) enters it per turn (surface `runtime-tool`, session, runtime). Service-level choke points (config writes, marketplace transaction) read `currentAuditActor()` and fall back to `system` when there is none. The same three ALS boundaries `dispatch-context.ts` documents apply and are accepted the same way.

### 3.4 Visibility

`visibility` on every row, read by one function `services/audit/visibility.ts: canRead(reader, row)` used by every read path (MCP, HTTP, app):

- `space` rows: every member. Today: the owner and every agent.
- `participants` rows: accounts in `participants`; the owner too while the install is a one-person space (owner sees everything).
- `admins` rows: the owner only today; never an agent.

What is written as what in v1:

| Event                                                                            | Visibility                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Every action, including actions an agent took inside a person's private chat     | `space`                                                               |
| `runtime.tool_used`                                                              | `space` (tool name, target summary, outcome; never full input/output) |
| `auth.signed_in`, `auth.sign_in_failed`, `auth.signed_out` (carry IP/user agent) | `admins`                                                              |
| API key and agent token create/revoke                                            | `space` (no IP; `idHash` only)                                        |
| Anything scoped to a person-to-person DM (none exist yet; the type is ready)     | `participants`                                                        |

**Session visibility.** Transcripts follow the same three classes. A new nullable column `session_metadata.visibility` (+ `visibility_participants`) is written first-write-wins inside `persistSessionRuntime` from its required `TurnOrigin` by an exhaustive switch (`sessionVisibilityForOrigin`, beside `permissionSeedForOrigin` in `turn-origin.ts`, with the same `never` so a new origin breaks the build until someone decides):

| `TurnOrigin.kind`                                                                                         | Session visibility                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `interactive` (a person typing in the app)                                                                | `participants` [owner]                                                                                  |
| `relay-binding` (a chat binding: someone on Telegram/Slack, or a webhook, talking to an agent)            | `participants` [owner]; conservative, since the person on the other end may be the owner thinking aloud |
| `account-handoff`, `account-resume`                                                                       | the session is already bound, so its stored class stands; these write none                              |
| `room`, `schedule`, `agent-dm`, `agent-launch`, `extension-start`, `extension-message`, `connector-event` | `space`                                                                                                 |

A session with no stored class (born before PR4, or a bare-CLI session) is derived at read time from the existing origin overlays: a room binding, a task run, or a `session_started_by` row means `space`; anything else is `participants` [owner]. Unknown is private.

### 3.5 Activity

- **Tee.** `index.ts` wires `activityService.observe(event => auditLog.recordFromActivity(event))`. The mapper converts Activity's actor (path) to an account id (§3.2), maps `category`/`eventType` to `action` (Activity's `eventType` is already `domain.verb`), and sets `links.activityId`. Rule: a choke point writes Activity (and gets audit by the tee) OR writes audit directly, never both; a test enumerates `auditLog.record(` call sites against `activityService.emit(` sites in the same function.
- **Retention.** New config field `activity.retentionDays` (integer 1-3650, default 365) in a new top-level `activity` section. `DORKOS_ACTIVITY_RETENTION_DAYS` still overrides when set. Follows `adding-config-fields`: Zod field and section default, classified `no-risk` in `safe-defaults/default-verdicts.ts` (Activity holds no message content; a longer default withholds nothing and grants nothing), `expose` in `config-disclosure.ts`, `operator-only` in `config-write-policy.ts` under the `resources` stake (shortening it deletes history a person may not have read yet; lengthening spends disk). **No `CONFIG_MIGRATIONS` entry**: like `keepAwake`, a whole new top-level section is written to every stored config by conf before any key runs, so a body would be unreachable; `config-manager.test.ts` pins the section landing on disk.
- **Audit retention.** Forever, no setting, in v1. The delete trigger makes that true. Pruning with a recorded "pruned through seq N" row is a follow-up.
- **This departs from the ticket.** DOR-2738 asked for "Activity becomes a view" of the audit log. In v1 Activity remains its own table and audit is the superset (every Activity row is teed in). Turning Activity into a projection of audit touches ~30 emit sites, the moment detectors and `permission-undo.ts` (which reads an Activity row by id), so it is the **first follow-up** below (operator agreed, 2026-10-06).

## PR split (landing order)

Every PR: `pnpm verify` green, TSDoc on exports, a changelog fragment in `changelog/unreleased/<id>-<slug>.md` (id from `.claude/scripts/id.ts`), written per `writing-changelogs` + `writing-for-humans`. Each test listed must fail with the change reverted (mutation check before review).

### PR1: Store, ids, Activity tee, verify, retention

**Files**

- `packages/db/src/schema/audit/audit-events.ts` (+ export from schema index, + `drizzle.config.ts`), generated migration `packages/db/drizzle/20261006231015_audit_events.sql` with three triggers hand-appended (update, delete, chain-link insert).
- `apps/server/src/services/audit/{audit-log,canonical-json,account-ids,activity-tee,audit-capabilities}.ts`, `index.ts` barrel.
- `packages/shared/src/audit-schemas.ts` (event, actor, source, target, change, links, `AuditVerifyQuerySchema`, `AuditVerifyResultSchema`) + `package.json` export subpath. `redactCredentialTokens` split out of `redactSecrets` in `packages/shared/src/feedback.ts` so the audit writer can sweep credentials without blanking paths.
- Capability `audit.verify` (tier observe, area null) as its own `audit` domain, registered in `self-description/dorkos-registry.ts` and listed under the tokenless drift guard in `external-mcp/tool-security.ts`; surfaces: MCP `audit_verify` on both servers, `GET /api/audit/verify` (`routes/audit.ts`), and so `dorkos call audit.verify`.
- `services/audit/wire-audit-trail.ts` (log + account ids + Activity tee + startup tail verify, testable), called from `index.ts`, which also reads `activity.retentionDays` (applies on the next restart) and mounts `/api/audit`; `src/__tests__/audit-trail-wiring.test.ts` pins that wiring.
- The chain-link trigger finds the tail with `WHERE seq = (SELECT MAX(seq))`, a key lookup; a schema test pins the query plan (no SCAN, no temp B-tree).
- `packages/shared/src/config-schema.ts` (`activity.retentionDays`), `safe-defaults/default-verdicts.ts`, `operator/config-disclosure.ts`, `operator/config-write-policy.ts`.
- `AGENTS.md` service census gains `audit`.
- Moved to the PR that first reads them, so PR1 ships no unused code: the ALS actor context and its middleware (`services/audit/audit-context.ts`, `middleware/audit-actor.ts`) to PR2, `account.linked` to PR2's auth hook, `visibility.ts` and `AuditQuerySchema` to PR4.

**Tests**

- `packages/db` trigger test: UPDATE and DELETE on `audit_events` abort; an INSERT with a wrong `seq` or `prev_hash` aborts. Fails without the triggers.
- `audit-log.test.ts`: three records chain (`prev_hash` = previous `hash`); `verify` passes; after a raw edit with triggers dropped (simulating an agent holding the file), `verify` names the exact `seq`. A `record` that cannot write returns `undefined` and does not throw.
- `canonical-json.test.ts`: fixed vectors (key order, nesting, undefined dropped).
- Redaction: a `change` on `tunnel.authtoken` stores no value; a token-shaped string in `error` is redacted.
- `account-ids.test.ts`: agent path → mesh ULID; unregistered fallback is path-hash, never the path; login off owner → `install:<id>`; with an owner account → user id.
- Tee: an `activityService.emit` produces exactly one audit row with `links.activityId` and an agent ULID actor.
- Retention: the new `activity` section lands on disk for a stale config with no migration; the disclosure, write-policy and safe-defaults drift guards pass (they fail on an unclassified leaf).
- `audit.verify` capability reachable on both MCP servers and HTTP; tier observe.

**Docs**: `docs/guides/audit-trail.mdx` (new; what is recorded, how to check the chain), `docs/guides/meta.json`, `docs/self-hosting/deployment.mdx` (retention default 365 and the new setting), `contributing/audit-trail.md` (new: the writer, the one-or-the-other rule with Activity, the ALS context, how to add a choke point) + `contributing/INDEX.md`.

**Changelog**: "DorkOS now keeps a permanent, tamper-evident record of actions, and Activity history is kept for a year."

### PR2: Close the silent paths

**Files**

- `apps/server/src/services/audit/audit-context.ts` (the ALS actor context, §3.3) + `apps/server/src/middleware/audit-actor.ts`, mounted after agent identity in `app.ts`; moved here from PR1 because these choke points are its first readers. `services/audit/audit-trail.ts` (`initAuditTrail`, `recordAudit`, `runAsAgent`) is the process-wide handle, set by `wireAuditTrail`.
- `core/capabilities/registry.ts`: every invocation with an identity runs inside that agent's scope, so writes a capability makes name the agent.
- PR2 review additions:
  - An in-session capability call with no identity runs (and its row is recorded) as `unidentified`, never the person whose turn it is.
  - `marketplace.update_failed` when an update throws, `remove` if the old version is gone, `modify` if it stayed; installs and updates carry version and short commit before/after.
  - `services/audit/audit-context.ts` `outsideAuditScope`/`runOutsideAuditScope`, applied to the scheduler's cron and every long-lived interval (reconcilers, sweeps, lazily started loops), so a firing never inherits the scope of the request that created it.
  - `mcp.*` rows link `approvalId` when a granted token was spent.
  - The request scope resolves its actor lazily, once; credential kinds `agent-token`, `api-key`, `cookie`, `mcp-local` are all set.
  - Session endings are labelled `signed_out`, `session_revoked`, `session_expired` or `session_ended`; a sign-in refused by DorkOS's own limiter is `auth.sign_in_rate_limited`.
  - `middleware/audit-request-fallback.ts`: a mutating `/api` request nothing recorded leaves an `http.<method>` row (route pattern, outcome; never body, query or ids), deduplicated through the scope's `recorded` marker, which propagates to enclosing scopes.
- The `account.linked` row on first account creation, in the Better Auth hook below.
- `core/mcp-tool-gate.ts`: in both `gateHandRegisteredMcpTools` and `gatedToolRegistrar`, after the handler returns, record `mcp.<tool_name>` with operation from the tool's tier (`observe` → skip unless the tool reads private content; `act` → `execute`/`modify`; `destructive` → `remove`), outcome from `isError`, `links.approvalId` when an approval token was spent. Arguments are never recorded; a per-tool `auditTarget(input)` hook in `mcp-tool-metadata.ts` may name the target (e.g. `mesh_unregister` → the agent id). Rewrite the module doc's "What is audited" section. This one change covers `mesh_deny` and `mesh_unregister`.
- `core/agent-identity/capability-attribution.ts`: unattributed `act` invocations write audit directly (not Activity, to keep the human feed as it is) under the context actor (§3.3). Identified and destructive paths keep writing Activity and reach audit by the tee.
- `core/operator/config-write.ts` (`applyGuardedConfigWrite`, `logConfigWrite`): record `config.changed` with a per-leaf `change` diff from `result.before`/`result.config`; sensitive keys redacted by the writer.
- `services/marketplace/transaction.ts` (the one place install/update/uninstall commit, reached by routes and MCP tools alike): `marketplace.installed/updated/uninstalled` with package name, version before/after, source, SHA.
- Better Auth (`services/core/auth/auth-audit.ts`, wired in `index.ts`): `databaseHooks.session.create/delete.after` for sign-in/out (admins, with IP and user agent), `hooks.after` for failed sign-ins (admins, naming nobody) and API key create/delete (space). Agent identity tokens: `agent-token-env.ts` (each mint, by a hashed reference) and `unregister-cascade.ts` (revocation count) → `agent_token.minted/revoked`.
- `AuditSource` gains `ip` and `userAgent`, set only on `admins` rows.
- `services/rooms/repo/room-merge-service.ts`: record `room.merged` with actor = the caller and target = the agent's branch, so the record names who merged even though the commit is authored as the agent. The commit is recorded by its 12-character short id (a full id is long hex, which redaction hides).

**Tests**

- MCP gate: an allowed `mesh_unregister` (in-session and external) writes one `mcp.mesh_unregister` row with outcome `ok`; a handler `isError` writes `failed`; a refused call still writes only its existing Activity row. Fails today (the gate writes nothing on allow).
- Gate-bypass scan still passes.
- Unattributed `act` via `registry.invoke` writes one audit row with the owner actor; an identified one writes Activity and exactly one audit row (no double).
- Config: patching `scheduler.maxConcurrentRuns` stores before/after; patching `mcp.apiKey` stores `redacted: true` and no value.
- Marketplace: install then uninstall through the route and through the MCP tool each write one row with the right actor.
- Auth: sign-in writes an `admins` row; an agent `audit_query` (PR4) cannot see it (covered again in PR4).
- Merge: an owner merging an agent's copy records the owner as actor.

**Docs**: `docs/guides/audit-trail.mdx` (what is recorded, per area), `contributing/audit-trail.md`.

**Changelog**: "Approved actions, setting changes, package installs and sign-ins now show in the record."

### PR3: Runtime tool calls (all three runtimes)

**Files**

- `services/audit/record-tool-use.ts`: a Proxy in the same shape as `core/keep-awake/hold-during-turn.ts`, applied in `runtimeRegistry.register()`, so every turn from every surface (interactive, room, task, relay, connector event) and every runtime is seen once. It enters the audit ALS context for the turn (session, runtime, agent from `opts.cwd`/`opts.forAgent`), watches `tool_call_start` (to remember name + input) and the terminal `tool_result`/`tool_call_end`, and records `runtime.tool_used`:
  - `target_name`: a ≤ 200-char summary from a per-tool extractor table (Bash → command, Edit/Write/Read → file path, WebFetch → URL host + path, MCP → server/tool), redacted by the writer. Unknown tools → tool name only.
  - `operation`: `access` for read-only tools (Read, Grep, Glob, LS, WebSearch, Codex/OpenCode read equivalents), else `execute`.
  - `source.toolCallId` and `source.sessionId` link to the transcript; full input and output stay there.
  - DorkOS's own MCP tools (`mcp__dorkos__*` and the Codex/OpenCode spellings) are skipped here because PR2 records them server-side with better data.
- Shared tool-name tables for the three runtimes if the normalized `StreamEvent` does not already carry a runtime-neutral name (verify against `runtimes/codex/event-mapper.ts` and `runtimes/opencode/events/part-event-mapper.ts`).

**Tests**

- Proxy test with a fake runtime: a stream with two tool calls writes two rows with the right session, agent ULID and outcome; a stream that throws mid-tool records `failed`; `return()` early records nothing half-written.
- One fixture per runtime (Claude Code, Codex, OpenCode) through the real event mappers: a shell command produces `runtime.tool_used` with the command as target.
- A token in a Bash command is redacted in `target_name`.
- `mcp__dorkos__*` calls are not double-recorded.
- The Proxy is in the `register()` chain (fails if removed: assert via the registry test that a registered runtime is wrapped).

**Docs**: `docs/guides/audit-trail.mdx` ("what your agents did inside their tools"), `docs/guides/runtimes.mdx` one line.

**Changelog**: "Every tool an agent runs, in Claude Code, Codex or OpenCode, now shows in the record."

### PR4: Read side and the visibility rule

**Files**

- `packages/db` migration: `session_metadata.visibility`, `visibility_participants`.
- `services/session/origin/turn-origin.ts`: `sessionVisibilityForOrigin`; `RuntimeRegistry.persistSessionRuntime` writes it (first-write-wins; also when it binds a row a settings write created earlier).
- `services/audit/session-visibility.ts`: read the stored class or derive (§3.4).
- Capabilities (tier observe, area null, both MCP servers, HTTP, CLI): `audit.query` (`audit_query`: filters actor, target, action prefix, operation, session, time window, `before` cursor on `seq`, limit ≤ 200), `audit.get` (`audit_get`: one event plus resolved links: Activity row, approval, trace id, session), `audit.account_timeline` (`account_timeline`: actor OR target OR on-behalf-of = account, aliases from `account.linked`), `audit.transcript_read` (`transcript_read`: a session's messages via the runtime, paginated, refused with `TRANSCRIPT_PRIVATE` when `canRead` fails).
- Routes `apps/server/src/routes/audit.ts`: `GET /api/audit`, `/api/audit/:id`, `/api/audit/accounts/:id/timeline`, `/api/audit/verify` (from PR1).
- Leak fixes in `routes/sessions.ts` (`GET /`, `/recent`, `/:id`, `/:id/messages`, `/:id/tasks`) and `routes/session-events-handler.ts` (`GET /:id/events`): an agent caller sees `space` sessions only; a `participants` session it is not in reads as 404 (not 403, so its existence is not confirmed). `routes/debug.ts` `/sessions/:id` gets the same check. `routes/search.ts:94-96` changes from "no sessions for agents" to "space sessions for agents" through the same function.
- Client: `features/activity-feed-page` gains an "All actions" mode reading `/api/audit` (rows open the linked session, room entry or trace); `features/profile/ui/pages/ActivityPage.tsx` registered in `pages/registry.ts`, an agent's timeline from `account_timeline`. Uses the existing Activity row components; copy follows `writing-app-copy`. A Dev Playground entry if the row component changes (`maintaining-dev-playground`).
- `AGENTS.md` Message search paragraph: replace "Sessions are owner-only and reachable by no agent (spec §7)" with "Agents can search and read agent work sessions; a person's own chats stay private (spec `audit-trail` §3.4)". Update `specs/message-search/02-specification.md` §7 with a pointer.

**Tests**

- `sessionVisibilityForOrigin` is exhaustive (type test) and maps each origin as the table says.
- Derivation: a legacy task-run session is `space`; an unknown session is `participants`.
- Leaks: as an agent, `GET /api/sessions/:id/messages` and `/:id/events` on an interactive session return 404; on a task session return 200. Today the first returns 200, so this fails without the fix. `GET /api/sessions` as an agent omits private sessions.
- `transcript_read` as an agent: task session readable, interactive refused.
- `audit_query` as an agent never returns `admins` rows; as the owner it does.
- Search: an agent's search finds a phrase from a task session and not from an interactive one.
- Client: the profile Activity page renders rows from a mock transport; the All actions toggle switches the query.

**Docs**: `docs/guides/audit-trail.mdx` (who can see what: the privacy table in plain words), `docs/guides/agents.mdx` / `docs/guides/team.mdx` (the profile Activity page), `docs/concepts/sessions.mdx` (private chats vs agent work), `contributing/audit-trail.md` (the visibility function is the only reader).

**Changelog**: "Agents can now review each other's work: they can read the record and other agents' work chats. Your own chats stay private."

### PR5: Pause an agent everywhere

**Files**

- `packages/db`: table `agent_pauses` (agent_id PK, paused_by, paused_at, reason) holding current state; history lives in audit.
- `services/mesh/agent-pause.ts`: `pause(agentId, actor, reason?)`, `resume(...)`, `isPaused(agentPathOrId)`.
  - **Stop current turns**: interrupt every live session whose cwd resolves to the agent (via the projector registry and `runtime.interrupt`), and stop its running task runs.
  - **Hold**: a Proxy in `runtimeRegistry.register()` refuses `sendMessage` for a paused agent's cwd with a typed `AGENT_PAUSED` error. This is the backstop; nicer refusals sit at the entry points: `dispatchMessage` (person messages: a clear error the app shows with a Resume button), the task scheduler (the run is recorded as skipped, "agent paused"), room turn runner (no turn; a quiet notice once per pause), relay/connector-event deliveries (not run; recorded). Held triggers are not replayed on resume (replaying could fire a pile of stale work at once); each held trigger is one `agent.turn_held` audit row so nothing is silent.
  - The agent stays registered, readable and messageable; its profile and the sidebar show "Paused".
- Capabilities `agent.pause` and `agent.resume` (tier `act`, both MCP servers, HTTP `POST /api/agents/:id/pause|resume`, CLI): any account, person or agent, may pause any agent. Any account may resume EXCEPT the paused agent itself: an agent can never lift its own pause (refused `CANNOT_RESUME_SELF`, and the refusal is recorded). Both record who acted. No approval card for either (operator decision, 2026-10-06). They must never stop for approval, so they are exempted from area prompting the way other emergency levers are (verify against `permission-enforcement.ts`; add an explicit carve-out with a test if none exists). System agents (DorkBot) can be paused like any other.
- Client: a Pause/Resume button in `features/profile/ui/ProfileAgentActions.tsx`, a paused badge, and the error state in the composer.

**Tests**

- Pausing interrupts a live fake-runtime turn and records `agent.paused` with actor and reason.
- While paused: a person message returns `AGENT_PAUSED`; a scheduled fire is skipped and recorded; a room mention starts no turn; a direct `runtime.sendMessage` through the registry is refused (backstop, fails without the Proxy).
- Another agent can resume; `agent.resumed` names it. The paused agent resuming itself is refused and recorded (fails without the self-check).
- Pause survives a restart (state in SQLite).
- The pause capability never returns `approval_required` for an agent caller under the strictest preset.
- UI: button toggles state via mock transport.

**Docs**: `docs/guides/agents.mdx` (pausing an agent), `docs/guides/audit-trail.mdx` (acting on what you see).

**Changelog**: "Anyone can now pause an agent everywhere at once, and anyone can lift the pause."

## Acceptance

- Every row in Background 1-4 produces an audit row in a test.
- `audit.verify` passes on a fresh install and names the seq of a tampered row.
- No path writes both Activity and audit directly for one action.
- An agent can read every `space` row and every agent work transcript, and cannot read a person's interactive chat or an `admins` row, over MCP and HTTP alike.
- A paused agent starts no turn from any surface.

## Risks

- **Write volume** from PR3: one sync insert per tool call. Measured target: < 1 ms p99 per `record` on a dev Mac with 1M rows; if not met, batch per turn inside one transaction.
- **The insert trigger's `MAX(seq)` subquery** is an index lookup on the PK, so it stays O(log n). Verify with `EXPLAIN QUERY PLAN` in the PR1 test.
- **DB size** grows forever. ~400 bytes/row; 5,000 tool calls a day is ~700 MB/year. Acceptable for v1; pruning with an explained gap is the first follow-up.
- **ALS loss** at stored-callback boundaries (as `dispatch-context.ts` documents) records the actor as `system`. Tests cover the three choke points that use the context.

## Out of scope / follow-ups

- **First: Activity as a view of audit** (the ticket's ask, deferred in §3.5): drop `activity_events` as a separate store, read the feed from audit, key it on agent ULID.
- Audit pruning (v1 keeps every row forever, operator-accepted): pruning from the front writes a signed "pruned through seq N" row so the gap is explained and verifiable.
- Signed checkpoints (`{seq, hash}` signed with the server key) stored where a local agent cannot write: DorkOS Cloud when linked, a space it pushes to, or an exported file. Without them, tampering is detectable only if the tail was seen before.
- Export (JSONL, OCSF API Activity) and SIEM streaming.
- Suspend, revoke-all, rotate secrets (waits on the vault), revert from an event, flag for review, sponsors.
- Roles and spaces: `space_id`, admin reads of `participants` content writing `access` rows the participants can see.
- Reads of private content recorded (who opened a transcript, who exported a room).
- Reactions, canvas versions and closes, community mirror redactions, task `refused-schedule-log`, relay trace and dead-letter durability.
- Bare-CLI sessions (`claude` run outside DorkOS) never pass through the runtime registry, so their tool calls are not recorded; their transcripts are searchable and classified `participants`.
- Replaying held triggers on resume, if people ask for it.
