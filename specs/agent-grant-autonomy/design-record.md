# Agent grant autonomy: design record

Status: draft for @security-auditor's ruling and @dorkos-pm's OK (#dorkos, 2026-11-08). No code yet.
Tickets: DOR-3961 (Must, leave one agent out of an every-agent share), DOR-3959 (Should, give up own grants; own-seat restart). Owner @dorkos-code.

## 1. The goal

Dorian, 2026-11-08: an action only a person can do is a platform gap. Agents should be able to change connection access themselves, and a person (or a trusted agent) approves what needs approving.

- **Narrowing** (taking access away) an agent does directly, audited, with one-tap Undo.
- **Widening** (giving access) any agent can request. A person approves anything. An agent may approve a narrow slice of it (§4).
- Write access by agent approval waits on DOR-3969 (tool and connector reads mark the turn, the §4.7 gap) and on Dorian's call (§12).

## 2. Security's terms (the baseline, word for word)

From @security-auditor, 2026-11-08 10:57 CT, and the DOR-3961 / DOR-3959 terms that "still apply inside this lane".

**Narrowing:**

- N1. An agent narrowing its own grants is always allowed. Narrowing another agent's grants is refused in a turn marked as having read outsider text, or started by another agent's message.
- N2. Narrowing never deletes a connection or account. It changes grants only. Disconnecting stays a person's action.
- N3. Undo re-widens access, so it follows the widening rules, not the narrowing ones.

**Widening by an agent's approval, until reads through tools and connectors mark the turn (§4.7):**

- W1. Only on the same connection the approver already holds, at or below its own access. Never an every-agent share.
- W2. Read access only. Write and destructive stay with a person.
- W3. Never self-approval, and never in a turn started by another agent's message.
- A person can always approve anything.

**Everywhere:**

- E1. Every approval and every narrowing is audited with who did it.
- E2. It fails closed: if the turn's marks can't be read, the answer is no.
- E3. Tests cover each refusal, plus a mutant with the mark check removed.

**DOR-3961 terms (the exclusion):**

- X1. A deny that wins over every-agent grants on every path that reads grants: execute read, write and destructive, held actions, extension Connections reads (#3537), and any cached grant scope.
- X2 (amended by Security, 2026-11-08 11:11 CT). An agent may **set** an exclusion under N1. Only a person may **remove** one. An agent excluding **itself** is allowed from any turn. (Was: only a person can set or remove it.)
- X3. It holds for shares made later, from auto-share or from a person.
- X4. It fails closed: an unknown or unreadable exclusion state means no access for that agent, never the share.
- X5. Tests: an excluded agent is refused on every path in X1, plus one mutant with the deny check removed.

**DOR-3959 terms (own-seat restart):** re-reads the same agent's config only, takes no folder, account, mode or server list; every mark, level and ceiling carries over; rate-limited and audited with the turn that asked.

### 2.1 Security's rulings on this record (2026-11-08 11:11 CT, at `7b1bbaaed9`)

- **Q1, agent-set exclusions: yes.** An agent may set an exclusion under N1; only a person removes one (X2 amended above). An agent excluding itself is allowed from any turn: DOR-3959's give-up-my-own-access, and exactly `flow-snapshot`'s case (it can drop PostHog itself, no person needed).
- **Q2, narrowing others before DOR-3969: ship, with two more guards.**
  - **G1, rate limit:** at most 3 narrowings of _other_ agents per caller per hour. After that, `GRANT_NARROW_RATE`, and the refusal is a ledger row.
  - **G2, Needs-you:** any narrowing of another agent raises a Needs-you item for the person, with Undo on it, so lost access is seen when it happens.
  - The residual is named in the agent text and the docs (§4.4).
- **Q3, access held through an every-agent share counts: yes.** `APPROVE_EXCLUDED` runs before `held`, and an approver who is itself excluded gets an empty `held` from `grantScopeFor`. One test pins that.
- **Made explicit:** the `permissions`-area gate (ask a person unless Allowed) applies to `approve_request` and `undo_access_change`, not only to narrowing another agent (§4.2, §4.3), with a test.
- **Phases:** phase 1 (DOR-3961) first; each phase PR goes to Security on `hold`.

How the exclusion ships:

- **PR A** (DOR-3961): the exclusion, the deny, and person routes.
- **PR B**: the agent path, as one more `narrow_access` form (`leaveOutOfShare`, §6.1), under 4.1's checks.
- **No agent path lifts an exclusion:** not `narrow_access`, not `undo_access_change`, not `approve_request` (`APPROVE_EXCLUDED`).

## 3. Today's grant code (read at `origin/main` 56f5b53e33)

| What                                                                                                                  | Where                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grant rows, one per operation revision, `subjectType` `agent \| session \| every_agent \| extension`, no level column | `packages/db/src/schema/connectors/connections.ts:169`, unique key `:192`                                                                                                                                                     |
| `EVERY_AGENT_GRANT_SUBJECT_ID`                                                                                        | `connections.ts:208`                                                                                                                                                                                                          |
| Level intent per subject (`read \| read-write`)                                                                       | `connectionAccessLevels`, `connections.ts:223`, level `:233`                                                                                                                                                                  |
| Per-chat override (`attached \| detached`)                                                                            | `sessionConnectionOverrides`, `connections.ts:282`                                                                                                                                                                            |
| `everyAgentGrantSubject()`, `replaceEveryAgentGrants`, `revokeEveryAgentGrants`                                       | `apps/server/src/services/connectors/every-agent-grants.ts:28, :60, :111`                                                                                                                                                     |
| The precedence rule: override decides alone, else `or(namedAgent, everyAgentGrantSubject())`                          | `execution/agent-grant-scope.ts:58`, `:82-95`, `:101`                                                                                                                                                                         |
| The same rule, written a second time                                                                                  | `execution/access-query-service.ts` `agentGrantRows` `:100`, `grantApplies` `:164`                                                                                                                                            |
| The check: no matching grant refuses                                                                                  | `execution/authorization-service.ts` `prepareResolved` `:338`, `matchingGrants` `:384` / `:600`, refusal `:388-391`                                                                                                           |
| Recheck just before a call goes out (after a hold)                                                                    | `execution/execution-broker.ts:141, :334, :343`                                                                                                                                                                               |
| Managed connections fold a scope version into the digest                                                              | `authorization-service.ts:416-424`                                                                                                                                                                                            |
| Other grant readers                                                                                                   | `agent-request-service.ts:2383` (`liveAgentRevisionIds`), `management-review-context.ts:104, :190`, `resources/session-access-service.ts:168`, `resources/operator-query-service.ts:835`, `managed-authority-sync-service.ts` |
| Grant writes from the Connections page                                                                                | `routes/connector-management.ts` preview `:369`, apply `:402` → `reconciliation-service.ts:899` (`recordAccessLevel` `:1138`, `replaceNamedAgentGrants` `:1168`, `replaceEveryAgentGrants` `:1211`, managed staging `:1154`)  |
| Turn an every-agent share off                                                                                         | `connector-management.ts:388` → `reconciliation-service.ts:1279`                                                                                                                                                              |
| Trusted auto-share (writes `every_agent` at read-write)                                                               | `access/trusted-sharing.ts:154`, `:205`, `:240`, lowered by `fitSharedLevel` `:296`                                                                                                                                           |
| Who counts as the person                                                                                              | `routes/connector-owner-boundary.ts:109` (`resolveConnectorOperator`)                                                                                                                                                         |
| `request_connection` / `get_connection_request`                                                                       | `execution/execution-capabilities.ts:301, :346` → `agent-request-service.ts:326`                                                                                                                                              |
| Person answers a request                                                                                              | `POST /agent-requests/:requestId/decision` `connector-management.ts:317` → `agent-request-service.ts:777`, `resolveWithCurrentAccess` `:1365`                                                                                 |
| Level → classes                                                                                                       | `agent-request-service.ts:2067` (`classesFor`), `:2079`                                                                                                                                                                       |
| The request card                                                                                                      | `apps/client/src/layers/features/connections/ui/agent-request/AgentRequestCard.tsx:119`, two writes `:164-176`                                                                                                                |
| Activity today (every-agent changes only)                                                                             | `every-agent-activity.ts:46, :49, :111`                                                                                                                                                                                       |
| Audit today                                                                                                           | none from connector services; only the generic route row, `middleware/audit-request-fallback.ts`                                                                                                                              |
| Level helpers                                                                                                         | `packages/connector-providers/src/connector-schemas.ts:164` (`ConnectorAccessLevelSchema`), `:177` (`levelIncludes`), `:797`                                                                                                  |

Turn marks and origins:

| What                                          | Where                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The mark type (`outsider?: true`)             | `packages/shared/src/agent-runtime.ts:118`; `'runtime-default'` counts as outsider `:159-166`                                              |
| Read a turn's marks                           | `services/core/turn-power/turn-levels.ts:192` (`marksOf`), falls back to `live-outsider-turns.ts`                                          |
| Mark helpers, unknown source is marked        | `services/core/turn-power/turn-marks.ts:76` (`UNKNOWN_SOURCE`), `:160` (`marksForTurn`)                                                    |
| The pattern to copy (refuse in a marked turn) | `services/memory/memory-capabilities.ts:151-162`, `:381-386`; `operator/agent-file-inputs.ts:184`                                          |
| A turn another agent started                  | `session/origin/turn-origin.ts:158` (`chat-message`), `chat-messages.ts:24-30` (`fromAgentId`), `permissions/chat-launch-marks.ts:205-240` |
| Who is calling, and from which session        | `middleware/agent-identity.ts:33`, `capabilities/registry.ts:274, :330` (no `sessionId` on external `/mcp`)                                |
| The permission gate                           | `capabilities/permission-enforcement.ts:402`, `marked-turn-holds.ts:30`, `tier-enforcement.ts:805`                                         |

Three things the read turned up, which this design fixes in passing:

1. The precedence rule exists twice (`agent-grant-scope.ts:101` and `access-query-service.ts:100/164`). A deny added to one copy is a leak in the other. Phase 1 makes one helper and points both at it.
2. `createdBy` is stored in three formats (bare id, `owner:<kind>:<id>`, `<kind>:<id>`). The new ledger uses one actor shape (§5).
3. Nothing on the server reads `subjectType='extension'` grants yet. X1's extension path is pinned when #3537 lands (§8).

## 4. The rules, as the server checks them

Every check below runs on the server, in the capability handler, before any write. Order matters: the first failing check answers.

### 4.1 Narrowing

A narrowing lowers or removes an agent's grants on one connection: read-write → read, a level → none, or named operation revisions off. It never touches the connection, the account, or an every-agent row.

```
narrow(caller, target, connection, change):
  if change would add any revision or raise the level    → GRANT_NOT_A_NARROWING
  if target == caller.agent                              → allow (N1)
  marks = marksOf(caller.session, caller.agentPath)
  if marks unreadable or caller has no session           → GRANT_MARKS_UNREADABLE (E2)
  if marks.outsider                                      → GRANT_MARKED_TURN (N1)
  if turnStartedByAnotherAgent(caller.session) != false  → GRANT_AGENT_STARTED (N1)
  if caller narrowed other agents ≥ 3 times in the hour  → GRANT_NARROW_RATE (G1), ledger row
  if caller area 'permissions' is not Allowed            → ask a person (existing gate)
  allow, write the ledger row, raise a Needs-you item with Undo (G2)
```

The rate window counts the caller's own allowed `narrow_other` and agent-set `exclude` rows in `connection_grant_changes` over the last 60 minutes, read in the same transaction as the write. A failed count refuses (E2). Own narrowings don't count and raise no Needs-you item.

`turnStartedByAnotherAgent` is true for a `chat-message` origin with a `fromAgentId`, a spin-off's report, an `agent-dm` relay turn, a room turn whose trigger was another agent's post, and a scheduled run of a schedule another agent made (`tasks/scheduled-run-power.ts:112`). Unknown origin returns "unknown", which refuses.

A narrowing of a grant the target holds only through an every-agent share can't be expressed as a named-grant change. That is an exclusion: `narrow_access` with `leaveOutOfShare`, under the same checks (own: any turn; another: clean turn, rate-limited, Needs-you). It writes an exclusion row; it never touches the every-agent row (Q3's condition).

No restart is needed after a narrowing. Grants are rechecked on every call and again just before it goes out (`execution-broker.ts:334, :343`).

### 4.2 Agent approval of a request

```
approve(caller, request):
  if caller.agent == request.agent                       → APPROVE_SELF (W3)
  if request.access != 'read'                            → APPROVE_NOT_READ (W2)
  marks / origin checks exactly as 4.1                   → GRANT_MARKS_UNREADABLE / GRANT_MARKED_TURN / GRANT_AGENT_STARTED
  if request would write an every-agent row              → APPROVE_EVERY_AGENT (W1)
  if target is excluded from this connection             → APPROVE_EXCLUDED (X2)
  held = caller's live read revisions on request.connection (named or every-agent)
  if held is empty                                       → APPROVE_NOT_HELD (W1)
  grant = request's read revisions ∩ held
  if grant ≠ request's read revisions                    → APPROVE_ABOVE_OWN (W1)
  if caller area 'permissions' is not Allowed            → ask a person (existing gate)
  write named-agent read grants for request.agent, then resolve the request as current_access
```

`held` comes from `grantScopeFor` for the approver, so an approver that is itself excluded from the connection holds nothing there and gets `APPROVE_NOT_HELD` (Q3).

The marks check applies to approvals even though W3 names only the agent-started case: the PM's design says "only in a turn that read no outside text", and today's marks are the part of that we can check.

### 4.3 Undo

Undo restores the row's `before`. It is checked as what it does:

- Undoing a narrowing re-widens, so it goes through 4.2's rules with the caller as approver (N3). An agent undoing its own narrowing is self-approval and is refused; a person undoes it.
- Undoing an agent's approval is a narrowing and goes through 4.1.
- Undoing anything that would re-add an every-agent share for one agent (lifting an exclusion) is person-only.
- If access has changed since (current state ≠ the row's `after`), Undo refuses with `UNDO_STALE` rather than overwrite a later change.
- An agent's Undo, whichever way it goes, also passes the `permissions`-area gate (ask a person unless Allowed).
- A person can always undo, from Activity, the Needs-you item, or the Connections page.

### 4.4 What this can prove before DOR-3969 (Security, 2026-11-08 11:08 CT)

"Refused in a dirty turn" is only provable for turns DorkOS already marks: outsider room or chat text, a Wi-Fi sign-in's hold, and a turn another agent started. Reads through tools and connectors (email, web pages, GitHub, Linear) don't mark a turn until DOR-3969 lands (design: `specs/turn-marks/design-note.md:57-61`).

**So the gate rows and tests prove only the limits that hold without it.** An agent-approved read request is refused:

1. in a turn another agent started;
2. for self-approval;
3. on an every-agent share;
4. above the approver's own access;
5. for write;
6. in a marked turn (outsider room or chat text, Wi-Fi).

For narrowing another agent, the rows are 1 and 6 (refused when another agent started the turn, and in a marked turn). An agent narrowing its own grants is allowed in both.

**Wording rule.** The release note, the tool descriptions, the agent-facing context text and the refusal notes never say an agent is "refused after reading outside content", or anything that implies a tool or connector read is caught. They say what is true: an agent can't approve its own request, can't approve write access, can't approve from a turn another agent started, and can't approve in a turn DorkOS marks as having read words it can't vouch for. `GRANT_MARKED_TURN` fires only on a marked turn, so its text (§7) stays accurate. The PR checks this with a grep test over the new tool descriptions and the fragment for the phrases "outside content", "after reading", "external content".

**The risk is named, in the agent text and the docs (PM, Q2).** Both the `narrow_access` / `approve_request` tool descriptions and the docs page for connection access say it plainly: "DorkOS doesn't yet notice when a turn reads an email or web page through a connection. Until it does, these limits don't cover that case." The changelog fragment says the same in one line. DOR-3969 removes the sentence.

**When DOR-3969 lands,** nothing in this design changes shape: `marksOf` starts returning `outsider` for a turn that read through a tool or connector, and every 4.1 / 4.2 check picks it up. That PR then adds:

- a seventh gate row and test: refused after a connector read (a fake connector result in the turn);
- the widened wording in the release note and tool text;
- a re-open of Q2 (narrowing another agent then gets the full protection, not just today's marks).

Write approval by agents still waits on Dorian's call after that (§1).

## 5. Data model

Two new tables in `packages/db/src/schema/connectors/`, one migration.

**`connection_grant_exclusions`** (DOR-3961)

| Column                   | Notes                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| `id`                     | ULID                                                              |
| `agentId`                | the agent left out                                                |
| `connectionId`           | cascade delete with the connection                                |
| `createdBy`              | actor JSON (below); a person in PR A; an agent too from PR B (Q1) |
| `createdAt`, `revokedAt` | a lifted exclusion keeps its row                                  |
| `changeId`               | the ledger row that made it                                       |

Unique on (`agentId`, `connectionId`) where `revokedAt IS NULL`.

**`connection_grant_changes`** (the ledger behind audit, Activity and Undo)

| Column                          | Notes                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`                            | ULID, the id Undo takes                                                                                |
| `kind`                          | `narrow_own \| narrow_other \| exclude \| include \| approve_read \| undo`                             |
| `actor`                         | `{ kind: 'person' \| 'agent', id, sessionId?, turnOrigin?, marked: boolean }`, one shape for every row |
| `targetAgentId`, `connectionId` |                                                                                                        |
| `before`, `after`               | `{ level: 'read' \| 'read-write' \| null, revisionIds: string[], excluded: boolean }`                  |
| `requestId`                     | for `approve_read`                                                                                     |
| `undoOf`, `undoneBy`            | ledger ids                                                                                             |
| `createdAt`                     |                                                                                                        |

Grant rows themselves are unchanged. Writes go through the existing helpers (`recordAccessLevel`, `replaceNamedAgentGrants`) in one transaction with the ledger row, so a change without a ledger row can't happen.

**The deny.** One helper, `grantScopeFor(db, { agentId, sessionId, connectionId })`, replaces both copies of the precedence rule. It returns the named-agent subject, and the every-agent subject only when an exclusion read for (`agentId`, `connectionId`) succeeded and found none. A failed or unknown read returns "denied" (X4). The per-chat override keeps its current place in front of it. Because the deny is checked at read time, a later share (auto-share, a person, the level follower) never reaches an excluded agent (X3).

Managed connections: an exclusion is a local deny, so the local check refuses immediately. Whether the hosted authority also needs the exclusion to keep `scopeVersion` honest is a phase 1 read-through of `managed-authority-sync-service.ts`, reported in the PR.

## 6. What agents call, and what a person calls

### 6.1 New capabilities (MCP tools, `connectors` domain)

| Tool                             | Input                                                                                                                                                                | Tier / area                                                                     | Notes                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `connectors.narrow_access`       | `{ connectionId, agentId?, to: 'read' \| 'none' }`, `{ connectionId, agentId?, removeOperationRevisionIds }`, or `{ connectionId, agentId?, leaveOutOfShare: true }` | act; area `null` when `agentId` is omitted or is the caller, else `permissions` | `agentId` omitted means the caller (DOR-3959's grant half) |
| `connectors.approve_request`     | `{ requestId }`                                                                                                                                                      | act; area `permissions`                                                         | read requests only                                         |
| `connectors.undo_access_change`  | `{ changeId }`                                                                                                                                                       | act; area `permissions`                                                         | checked as 4.3                                             |
| `connectors.list_access_changes` | `{ connectionId?, agentId?, limit? }`                                                                                                                                | observe                                                                         | the ledger, so an agent can find a `changeId`              |

**Required reason (designer, 2026-11-08).** `narrow_access` on _another_ agent, in any form including `leaveOutOfShare`, takes a required `reason`: one line, at most 15 words, in the agent's own words. It is stored on the ledger row and shown as the quieter second line of the Needs-you item and the Activity row. A missing, empty, multi-line or over-long reason refuses with `GRANT_REASON_REQUIRED` before any other check writes anything. On the agent's own grants the reason is optional.

`list_granted_connections` already reflects narrowings and exclusions, since it reads through the same helper.

Every result carries `changeId` and a plain `note` saying what changed and that a person can undo it. Codex and OpenCode reach these over external `/mcp` with no session (`registry.ts:330`): own narrowing works, everything that needs the turn's marks refuses with `GRANT_MARKS_UNREADABLE`.

### 6.2 New person routes (gated by `resolveConnectorOperator`)

| Route                                                                  | Does                                         |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| `PUT /api/connectors/connections/:connectionId/exclusions/:agentId`    | leave one agent out                          |
| `DELETE /api/connectors/connections/:connectionId/exclusions/:agentId` | let it back in                               |
| `GET /api/connectors/access-changes`                                   | the ledger, for Activity and the page        |
| `POST /api/connectors/access-changes/:changeId/undo`                   | a person's Undo, always allowed unless stale |

Agents never reach these: the operator boundary refuses machine callers (`connector-owner-boundary.ts:115`).

## 7. Refusals and their words

Codes are stable; the text is what the agent sees and can quote.

| Code                                                                  | Text                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GRANT_NOT_A_NARROWING`                                               | That would add access. Ask for it with request_connection instead.                                    |
| `GRANT_MARKS_UNREADABLE`                                              | DorkOS can't tell what this turn has read, so it can't change another agent's access. Ask a person.   |
| `GRANT_MARKED_TURN`                                                   | This turn read words DorkOS can't vouch for, so it can't change another agent's access. Ask a person. |
| `GRANT_AGENT_STARTED`                                                 | Another agent's message started this turn, so it can't change another agent's access. Ask a person.   |
| `GRANT_SHARE_PERSON_ONLY`                                             | Only a person can change an every-agent share. You can leave one agent out of it.                     |
| `EXCLUSION_PERSON_ONLY`                                               | Only a person can let an agent back into a share.                                                     |
| `GRANT_NARROW_RATE`                                                   | You've lowered other agents' access 3 times this hour. Ask a person for more.                         |
| `GRANT_REASON_REQUIRED`                                               | Say why in one line, 15 words at most. The person sees it.                                            |
| `GRANT_DISCONNECT_PERSON_ONLY`                                        | Only a person can disconnect an account. You can narrow access instead.                               |
| `APPROVE_SELF`                                                        | You can't approve your own request. A person or another agent has to.                                 |
| `APPROVE_NOT_READ`                                                    | Agents can approve read access only. A person approves write access.                                  |
| `APPROVE_EVERY_AGENT`                                                 | Agents can't approve an every-agent share. A person can.                                              |
| `APPROVE_EXCLUDED`                                                    | A person left this agent out of this connection. Only a person can let it back in.                    |
| `APPROVE_NOT_HELD`                                                    | You can only approve access to a connection you hold yourself.                                        |
| `APPROVE_ABOVE_OWN`                                                   | You can only approve access you hold yourself, at or below your own.                                  |
| `UNDO_STALE`                                                          | Access has changed since then. Set it on the Connections page instead.                                |
| `CONNECTOR_GRANT_REQUIRED` (existing, `authorization-service.ts:388`) | for an excluded agent, adds: "A person left this agent out of this connection."                       |

Each refusal is also an audit row (§8), so a refused attempt is as visible as an allowed one.

## 8. Audit and Activity

- **Audit:** every ledger write and every refusal calls `recordAudit` with the actor shape, the target, the connection, the code, and the session. This replaces the bare route-only row the fallback writes today.
- **Activity** (category `permissions`, next to `connectors.every_agent_changed`):
  - `connectors.access_narrowed`: "DorkOS PM took PostHog access away from flow-snapshot." with the reason as a quieter second line (_"It wasn't using it."_). Undo.
  - `connectors.access_approved`: "DorkOS PM gave flow-snapshot Read on Linear." Undo.
  - `connectors.agent_left_out`: "You left flow-snapshot out of the PostHog share." Undo.
  - `connectors.access_change_undone`: "Dorian undid DorkOS PM's change to flow-snapshot's Linear access."
  - Own narrowing: "flow-snapshot gave up its PostHog access." Undo (a person's).
- **Needs-you (G2):** every narrowing of _another_ agent, and every exclusion an agent sets on another agent, raises one Needs-you item: "DorkOS PM took PostHog access away from flow-snapshot." with **Undo** and **Keep the change**, and under it, in a quieter second line, the agent's own reason in its words (_"It wasn't using it."_). Keep the change clears the item; Undo is the person route. An agent's own narrowing raises none.
- **Undo is one tap** on the Activity row, the Needs-you item and the Connections page row. It calls the person route; no confirm dialog, because the undo itself is undoable. Its result shows in place on the row ("Access given back"), never as a toast.

## 9. What the person sees

- **Request card** (`AgentRequestCard.tsx`): an agent-approved request shows "Approved by DorkOS PM · Read only" with Undo. A read-write request an agent can't approve stays on the card as today, with the line "Write access needs you."
- **Connections page, a shared connection:** "Every agent, except flow-snapshot." Each left-out agent is a chip with "Let back in". "Leave an agent out" opens the agent picker.
- **Connections page, an agent's row:** a narrowed level shows "Lowered by DorkOS PM" until a person changes it.
- **Needs you:** a narrowing of another agent shows as an item with Undo and Keep the change, plus the agent's reason (§8, G2). An agent's own narrowing doesn't. A read request an agent approved leaves Needs you, and shows in Activity with Undo.

All copy fits the 15-word cap and the `writing-app-copy` rules; the exact strings land with the client PR.

## 10. Tests

One test per refusal in §7, at the capability handler, with a real DB (`packages/db` test fixtures) and a fake turn-level record:

- **Narrowing:** own in a marked turn allowed; own from an agent-started turn allowed; another in a marked turn refused; another from a `chat_send` turn, a spin-off report, an `agent-dm`, an agent's room post and an agent-made schedule refused; another with no session refused; widening dressed as narrowing refused; a write to an every-agent row refused with `GRANT_SHARE_PERSON_ONLY`; `leaveOutOfShare` on itself allowed from a marked and from an agent-started turn; on another allowed in a clean turn and refused in a marked or agent-started turn; no agent path lifts an exclusion (narrow, undo, approve → `EXCLUSION_PERSON_ONLY` / `APPROVE_EXCLUDED`); no path removes a connection.
- **Rate limit (G1):** the 4th narrowing of another agent in an hour refused with `GRANT_NARROW_RATE` and a ledger row; own narrowings don't count; the window rolls after 60 minutes; a count that fails refuses.
- **Needs-you (G2):** a narrowing of another agent, and an agent-set exclusion on another, raise exactly one item with Undo; an own narrowing raises none; Undo on the item restores `before`.
- **Reason:** `narrow_access` on another agent with no reason, an empty one, a multi-line one and a 16-word one each refuse with `GRANT_REASON_REQUIRED` and change nothing; a 15-word one works; the reason appears on the ledger row, the Needs-you item and the Activity row; own narrowing works without one.
- **Area gate:** `narrow_access` on another agent, `approve_request` and `undo_access_change` each ask a person when the caller's `permissions` area isn't Allowed, and proceed when it is.
- **Approval:** self refused; read-write refused; marked and agent-started refused; approver without the connection refused; approver at read asked for revisions it lacks refused; every-agent refused; excluded target refused; an approver that is itself excluded gets an empty `held` and `APPROVE_NOT_HELD` (Q3); a person's approval unaffected by any of these.
- **Undo:** an agent undoing its own narrowing refused; an agent undoing another's narrowing follows 4.2; undo of an approval follows 4.1; stale refused; a person's undo works.
- **Exclusion (X1, X5):** an excluded agent is refused on execute read, write and destructive; on a destructive held action rechecked at `execution-broker.ts:343` after the exclusion lands mid-hold; on `list_granted_connections` and `list_granted_operations`; on `liveAgentRevisionIds`; on the session and operator query services; on a managed connection; and (with #3537) on extension Connections reads. Another agent keeps the share. A share made after the exclusion (auto-share, person) doesn't reach it. An exclusion read that throws denies.
- **Ledger:** every allowed change and every refusal writes its row; a write without a ledger row can't happen (forced failure rolls both back).

**Mutants** (each must go red, run by hand in the PR and listed in its body):

1. The mark check removed from 4.1 / 4.2 (Security's E3).
2. The agent-started check removed.
3. Unreadable marks treated as clean.
4. The self check removed.
5. The read-only check removed.
6. The deny removed from `grantScopeFor` (X5).
7. A second copy of the precedence rule without the deny (proves both callers use the one helper).
8. The exclusion read's failure treated as "no exclusion" (X4).
9. The rate check removed (G1).
10. The Needs-you raise removed from narrowing another agent (G2).
11. The `permissions`-area gate skipped for `approve_request` and `undo_access_change`.
12. The reason check dropped from `narrow_access` on another agent.

## 11. Phases

Each phase is its own PR, opened on `hold` for Security, armed only after @security-auditor's labels.

1. **DOR-3961.** One `grantScopeFor` helper for both callers, the exclusions table, the deny on every path, person routes and the Connections page UI, X-tests and mutants 6-8. This alone lets Dorian keep `flow-snapshot` to Linear without turning PostHog's share off.
2. **Narrowing + ledger.** `connection_grant_changes`, audit and Activity, `narrow_access`, `list_access_changes`, `leaveOutOfShare` (own from any turn, another under 4.1), the G1 rate limit, the G2 Needs-you item, the required reason, person Undo, mutants 1-3, 9-10, 12. Carries DOR-3959's grant half (an agent gives up its own grants, from any turn).
3. **Read approval by agents.** `approve_request`, `undo_access_change`, the card's "Approved by" state, the area-gate test, mutants 4-5, 11.
4. **DOR-3959's seat half.** Own-seat restart under its three terms. Separate code (room seats, not grants); listed here so the ticket closes with this lane.
5. **Not in this lane:** write approval by agents. It waits on DOR-3969 (tool and connector reads mark the turn) and on Dorian's decision.

### 11.1 Build plan for 0.135.0 (cut Mon Nov 9, 18:00 CT)

This is Must 3 of 0.135.0. No code starts before Security's ruling on this design. Phase 1 (DOR-3961) goes first, as its own PR. Phases 1-3 ship in it; phase 4 (seat restart) is a Should and rides along only if green. Times are CT. Every PR opens on `hold`, and stacked ones open as drafts until the one below merges.

| PR                                                                               | Contents                                                                                                                                                                                                            | Open by   | Security label by           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- |
| **A. Exclusions (server)**                                                       | `grantScopeFor` for both callers, `connection_grant_exclusions` + migration, the deny on every X1 path, person routes, X-tests, mutants 6-8                                                                         | Sun 20:00 | Mon 10:00                   |
| **B. Ledger + narrowing (server)**, on A                                         | `connection_grant_changes`, `recordAudit` + Activity events, `narrow_access`, `list_access_changes`, `leaveOutOfShare`, G1 rate limit, G2 Needs-you item, required reason, person Undo route, mutants 1-3, 9-10, 12 | Mon 09:00 | Mon 13:00                   |
| **C. Read approval (server)**, on B                                              | `approve_request`, `undo_access_change`, the six §4.4 rows as tests, area-gate test, mutants 4-5, 11, the wording grep test, agent-facing tool text                                                                 | Mon 11:00 | Mon 15:00                   |
| **D. Person UI (client)**, on A's routes, B's and C's for Undo and "Approved by" | exclusion chips and picker, Undo on Activity and Connections rows, the card's "Approved by" state, Undo result shown in place ("Access given back", no toast), light, dark and 390px shots to @designer on the PR   | Mon 12:00 | Mon 15:00 (designer OK too) |
| **E. Changelog fragment** (in C)                                                 | plain words, the wording rule above                                                                                                                                                                                 | with C    | with C                      |

- **Merge order:** A → B → C, then D. All four green and labelled by Mon 16:00, merged by 17:30, so the cut at 18:00 has them.
- **If C slips:** A and B still ship (exclusion plus narrowing with Undo). The note then says only that, and approval rides the next release. A alone already unblocks `flow-snapshot`.
- **If DOR-3969 lands by Mon 15:00:** C adds the seventh row and the wider wording (§4.4). Otherwise the wording stays as §4.4 says.
- **Load:** one worktree with `node_modules` for A-C in sequence; D in a second. Full suites run in CI only, and the local runs stay targeted (`pnpm vitest run <path>`), after an `uptime` check.
- **QA gate rows:** "a grant narrowed with Undo" (B + D) and the six §4.4 rows (C), in place of "refused in a dirty turn".

## 12. Questions, now ruled

PM's product view (11:10 CT): yes, yes, yes. **Security ruled at 11:11 CT: yes on all three, with Q2's two guards (§2.1).** Kept here for the record.

- **Q1.** Agent-set exclusions: X2 (person-only), or set by an agent under the narrowing rules and lifted only by a person (§2.1)? PM: the second. Security: the second, plus self-exclusion from any turn.
- **Q2.** Narrowing another agent is checked against today's marks, and today a connector or tool read doesn't mark the turn (§4.7, `specs/turn-marks/design-note.md:57-61`). So a turn that read a poisoned email can still narrow a teammate. The harm is lost access, visible in Activity and undone by a person in one tap. Ship narrowing-others in phase 2 with that residual named, or hold it behind DOR-3969 too? My pick: ship, named in the PR. Security's 11:08 point already accepts this shape for approval (§4.4); this asks the same for narrowing. PM: ship it, with the risk named in the agent text and the docs (§4.4); DOR-3969 closes it. Security: ship, with G1 (rate limit) and G2 (Needs-you).
- **Q3.** Approval counts the approver's access through an every-agent share as "held" (W1 says "already holds"). Acceptable, or named grants only? My pick: both count; the every-agent row itself is never written by an agent. PM: yes, on that condition. Security: yes, plus the excluded-approver test.

## 13. Out of scope

- Disconnecting, removing or re-linking a connection or account: person-only, unchanged.
- Destructive operations: never granted by level today (`connector-schemas.ts:177`), and never by an agent.
- Per-chat overrides (`PUT /sessions/:sessionId/connections/:connectionId`): unchanged.
