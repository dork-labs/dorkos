---
slug: ask-entitlement
id: 260819-023728
created: 2026-08-19
status: ideation
tracker: DOR-1356
project: Unified Conversation Surfaces
---

# Per-person Ask entitlement: the fleet-wide list and the fan-out filter by who may answer

**Slug:** ask-entitlement
**Author:** Claude (IDEATE+SPECIFY author)
**Date:** 2026-08-19

---

## 1) Intent & Assumptions

- **Task brief:** P3 of the unified-conversation programme (DOR-1330) made every prompt an
  agent is parked on reachable from every route: `GET /api/sessions/pending-interactions`
  lists them and `interaction_pending` broadcasts them on the global stream. Both answer
  every caller the session gate admits. The six answer routes run `requirePersonToAnswer`,
  so nobody but a person in the cockpit can ACT — but nothing at all decides who may SEE
  an Ask's detail, and the detail is the tool name, the command or path it would run
  against, and the agent that asked. That is P3's Known Issue 23, filed verbatim as the
  follow-up: _"the list route and the fan-out both need a per-caller filter, which is a
  change to `eventFanOut`'s addressing model."_ This item builds the entitlement model both
  ends read, and — because the bridge is where a second person actually exists today —
  gives an allowlisted approver on Telegram a real Approve/Deny for a room-bound Ask, while
  everybody else in that chat keeps only the vague waiting sentence.
- **Assumptions:**
  - `presentsAgentIdentity` (`middleware/agent-identity.ts:70-77`) is the one fact that
    says a machine is calling, and DOR-1357 has already made two surfaces read it rather
    than two copies of one sentence. This item makes it three.
  - The local install stays single-account: `services/core/auth/accounts.ts`'s module doc
    states the registration policy opens sign-up only while the `user` table is empty and
    refuses every later attempt, permanently. So "the operator" and "the owner" are the
    same person, and a second cockpit person is a future invites spec, not this one.
  - DOR-1355 (`resolvedBy` carried from `res.locals.user` into the resolution) and
    DOR-1359 (the bridged waiting sentence) are siblings landing in the same window. This
    spec composes with both and does not restate either; where it needs a fact from one it
    says so and depends on nothing unlanded.
  - The chat bridge's `platformChatType` vocabulary is Telegram's
    (`'private' | 'group' | 'supergroup'`, `chat-bridge/bridge-store.ts:43`), so the bridged
    room is a Telegram surface today. The design is written against the adapter-neutral
    seams (`mayApprove`, the `relay.human.*` subject, the `approval_required` StreamEvent)
    so Slack inherits it when a Slack bridge exists.
- **Out of scope:**
  - Widening the direct-bind approval path. §3.4 of the unified-conversation spec says the
    relay's `mayApprove` gate is "unchanged and not widened by this spec", and it stays
    that way here: a direct-bound agent's card still lands wherever it lands today.
  - A second cockpit account, invites, or per-session ownership columns. There is no second
    person to filter against inside the cockpit, and a bar that cannot discriminate is
    worse than no bar.
  - Room-scoped Ask signals. §3.5 settled that the room correlates through the global
    event carrying `roomId`; nothing here reopens it.
  - `RoomTurnWaiting`'s shape, the 60-second waiting grace, and the room's own
    `awaiting_approval` copy. All three stay exactly as shipped.

## 2) Pre-reading Log

- `specs/unified-conversation/02-specification.md` §3.1–§3.6: the wire shape
  (`InteractionPendingEvent` carries `sessionId`, `cwd`, the whole
  `PendingInteractionDTO`, and optional `roomId`/`roomAuthorId`), where the broadcast comes
  from (`SessionListBroadcaster` subscribing to `onProjectorInteractionChange`), the list
  route's deliberate "`sessionGate` and nothing more" authority, and the "eligible
  approver" table whose two sets — the cockpit's operator cookie and the bridge's
  allowlist — "never merge".
- `specs/unified-conversation/04-implementation.md` P3 Known Issues 22–24 and the
  post-programme follow-ups: KI 23 is this item's charter, KI 22 (`resolvedBy` never
  populated) is DOR-1355's, and the 2026-08-18 entry records DOR-1357 lifting
  `presentsAgentIdentity` into `middleware/agent-identity.ts` so two surfaces read one
  predicate.
- `apps/server/src/routes/sessions.ts:74-127`: `ANSWERING_NEEDS_COCKPIT` and
  `requirePersonToAnswer` — `resolveDecisionAuthority(readCallerAuthority(req, res))` then
  `requireOperatorCookieUnderLogin(res, 'whether a tool runs')`. Lines 219-250: the list
  route, registered above `/:id` with the Express 5 ordering note, joining
  `listPendingInteractionsAcrossSessions()` against
  `req.app.locals.roomSessionBindings`. Lines 862, 886, 916, 941, 961, 1018: the six
  routes that call the guard.
- `apps/server/src/lib/caller-authority.ts:80-87`: `readCallerAuthority` builds
  `{ agentIdentityPresented: presentsAgentIdentity(req, res), approvalTokenPresented, user }`.
  Lines 214-229: `requireOperatorCookieUnderLogin` — allows outright when login is off, and
  under login-on requires `user.credential === 'cookie'`.
- `apps/server/src/middleware/agent-identity.ts:45-77`: `getRequestAgentIdentity` (which
  agent) versus `presentsAgentIdentity` (is a machine calling — true for a header that did
  not even resolve).
- `apps/server/src/services/core/event-fan-out.ts`: `addClient(client)` takes no identity;
  `broadcast(eventName, data)` renders once (`encodeBroadcast`) and writes to every client
  in the set, after firing every in-process listener.
- `apps/server/src/routes/events.ts:50-91` and `routes/events-socket.ts:49-87`: the two
  transports. The SSE one runs behind the Express chain, so `res.locals.user` and
  `res.locals.agentIdentity` are both filled. The WebSocket one is handed
  `attempt.locals` — `StreamUpgradeLocals`, "`res.locals`-shaped on purpose"
  (`streams/stream-upgrade-auth.ts:44-53`) — and today `globalEventsRoute.authorize()`
  ignores it entirely.
- `apps/server/src/services/core/streams/upgrade-router.ts:78-113`: `UpgradeRoute.credential`
  is stated as DATA so a new route cannot forget the gate, with the reason written down
  ("the gate was tested, but the _wiring_ of it — the part an exploit uses — was not").
  That is the pattern this item copies for the fan-out's principal.
- `apps/server/src/services/session/session-list-broadcaster.ts:172-183` (`RoomBindingsPort`,
  a port so the module never reaches into `services/rooms/`), `:460-506`
  (`broadcastInteraction`, two events per parked turn, `roomId` joined here).
- `apps/server/src/services/rooms/room-session-ledger.ts:31-36, :118`:
  `RoomSessionBinding { roomId, authorId, sessionId }` and `bindingForSession`.
- `packages/relay/src/adapters/approver-allowlist.ts`: `mayApprove(allowlist, userId)` —
  fails closed on every uncertainty, "absence is not consent", and its module doc already
  records the residual this item must not extend: _"anyone who can post in a channel the
  bot sits in was never filtered by it at all, and the approval card lands in that
  channel."_
- `packages/relay/src/adapters/telegram/telegram-adapter.ts:540-604` and
  `slack/slack-adapter.ts:340-401`: the click handlers. Both run `mayApprove` before
  publishing `relay.system.approval.<agentId>` with `respondedBy`.
- `packages/relay/src/adapters/claude-code/approval-handler.ts:74-123`:
  `handleApprovalResponse` parses the payload and calls
  `agentManager.approveTool(sessionId, toolCallId, approved)` with **no authority check of
  its own** — the adapters' in-process gates are the only thing between the relay bus and a
  tool running.
- `packages/relay/src/adapters/telegram/outbound.ts:393-509`: `deliverMessage` detects a
  StreamEvent on the envelope and, for `approval_required`, renders the inline keyboard via
  `handleApprovalRequired`. Everything else falls through to the plain-payload path.
- `apps/server/src/services/relay/chat-bridge/deliver.ts:72-78, :392-456`: the bridge is
  driven off the durable room log; `DELIVERABLE_NOTICES` is exactly `turn_failed` and
  `halted`, so `awaiting_approval` reaches nobody on the far end today.
- `apps/server/src/services/rooms/notices/notice-copy.ts:160-213` and
  `room-turn-runner.ts:486, :507-511`: the room's own waiting notice — late by
  `WAITING_NOTICE_GRACE_MS = 60_000`, one sentence per `WaitingKind`, and deliberately
  carrying no tool name and no question, "because repeating them into a shared room would
  put one member's approval decision — file paths and commands included — in front of
  everybody else."
- `apps/server/src/services/core/auth/session-gate.ts:41-58`: `RequestUser` carries
  `credential: 'cookie' | 'api-key'`, required rather than optional, precisely so a surface
  can tell the two apart.
- `apps/server/src/services/core/auth/accounts.ts` module doc and `auth/index.ts:292-307`:
  one account, the earliest, permanently — the single-identity fact this whole design rests
  on.
- `decisions/260725-133221-approvals-bind-to-the-exact-action-shown.md`: an approval binds
  to the exact action the person SAW. A bridged card therefore has to show the action, which
  is why an actionable card can only go where every reader may answer.
- `meta/agent-etiquette.md` §9: a standard nobody checks is decoration — every rule here has
  to be judgeable against a real transcript, or a real test.
- `.claude/rules/room-conduct.md`: "Who is calling is resolved, never assumed… neither
  present means the surface could name nobody, and on a login-on install that is a refusal,
  never a fallback to the owner."

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/routes/sessions.ts` — the list route (`:235`) and the six answer
    routes; `requirePersonToAnswer` (`:120`).
  - `apps/server/src/services/core/event-fan-out.ts` — the addressing change lives here.
  - `apps/server/src/routes/events.ts`, `routes/events-socket.ts` — the two places a client
    joins the fan-out, and the two places a per-connection principal is available.
  - `apps/server/src/services/session/session-list-broadcaster.ts` — `broadcastInteraction`
    (`:483`), the only producer of `interaction_pending` / `interaction_resolved`.
  - `apps/server/src/services/relay/chat-bridge/` — where a bridged room's actionable Ask
    is produced and where the bridged waiting sentence is delivered.
  - `packages/relay/src/adapters/claude-code/approval-handler.ts` — where a relay approval
    reaches the runtime, and where the server-side re-check has to sit.
- **Shared dependencies:** `presentsAgentIdentity` (`middleware/agent-identity.ts`),
  `RequestUser.credential` (`auth/session-gate.ts`), `StreamUpgradeLocals`
  (`streams/stream-upgrade-auth.ts`), `mayApprove` (`@dorkos/relay`),
  `RoomSessionBinding` (`rooms/room-session-ledger.ts`), `AdapterManager.getAdapter`
  (`relay/adapter-manager.ts`).
- **Data flow:** a projector parks a turn → `onProjectorInteractionChange` →
  `SessionListBroadcaster.broadcastInteraction` → `eventFanOut.broadcast` → every connected
  client. In parallel, `GET /api/sessions/pending-interactions` reads
  `listPendingInteractionsAcrossSessions()` for a window that opened later. This item puts
  one predicate — `askEntitlement` — in front of both, and adds a third consumer: a room's
  bridged chat.
- **Feature flags/config:** none new. The two existing dials are `auth.enabled` (login on
  or off) and each relay adapter's `approverAllowlist`
  (`packages/shared/src/relay-adapter-schemas.ts:160, :314`).
- **Potential blast radius:** the fan-out is the server's one broadcast bus — every event,
  not just the two Ask events, passes through `broadcast`. The addressing parameter is
  therefore optional-per-event and required-per-connection: an event that names no audience
  reaches everyone exactly as today, and a connection that named no principal is a compile
  error rather than a silent allow.

## 4) Research

### The hole, stated exactly

Run DorkOS with login off. Open the global stream with an agent's own identity header:

```
curl -N -H 'X-DorkOS-Agent: <a minted agent token>' http://localhost:4242/api/events
curl -H 'X-DorkOS-Agent: <a minted agent token>' http://localhost:4242/api/sessions/pending-interactions
```

Both answer. The first streams `interaction_pending` for every session on the machine; the
second lists them. Each envelope carries `interaction.toolName`, `interaction.input` (the
command or the file content), `interaction.blockedPath`, and the session's `cwd`
(`packages/shared/src/schemas.ts:1170-1226`). The agent cannot ANSWER — `requirePersonToAnswer`
refuses it at all six routes, structurally — but it reads every other agent's pending
shell command, in every project on the machine, in real time. Under login-on the same
caller needs a credential first, and an agent legitimately holds one of the person's API
keys, which is the exact residual DOR-474 named.

There is no second cockpit person to filter against. There IS a second kind of caller, it
is already reachable, and it is the one the whole `agent-trust` line of work exists to
keep away from decisions. So the entitlement's first real member is not a second human — it
is the machine.

### Potential solutions

1. **Filter at the two read surfaces with a shared predicate, and address the broadcast
   per connection.** One function decides; the list route drops rows it says no to and the
   fan-out skips clients it says no to. The principal is read once per request and once per
   connection, from the same `res.locals`-shaped facts both transports already carry.
   - Pro: the two surfaces cannot drift, which is the failure `lib/caller-authority.ts`'s
     module doc says matters more than a wrong answer. The addressing parameter is opt-in
     per event, so nothing else on the bus changes. The WebSocket transport already has the
     identity at `authorize()` and simply stops throwing it away.
   - Con: `EventFanOut` grows a second concept. Mitigated by making the principal a
     required argument of `addClient`, which is the shape `UpgradeRoute.credential`
     already argues for.
2. **Refuse the whole surface to an agent (403 on the list, close the socket on the
   stream).** Simpler to write.
   - Pro: no per-event work at all.
   - Con: a 403 says "Asks exist and you may not see them", which is more than nothing;
     and closing the global stream breaks agents that legitimately read `session_upserted`
     and room activity off it. The bus is multiplexed by design.
3. **Strip the detail rather than the event** — broadcast `interaction_pending` with the
   DTO removed for an unentitled caller.
   - Pro: an unentitled reader still learns a session is parked.
   - Con: two shapes for one event name, which the wire shape's own doc argues against
     ("a second copy that goes stale"), and it hands a machine the one fact — this agent
     is blocked and can be watched — with none of the accountability of the detail.
4. **Do the cockpit half only, and leave the bridge alone.**
   - Pro: half the work.
   - Con: the bridge is where a second person genuinely exists. Doing only the cockpit
     half means the entitlement model's `answer` axis has no runtime consumer that can
     ever return `none`, which is a check that cannot fail.

### Recommendation

Solution 1, with the bridge as the answer axis's real consumer. Concretely:

- One module, `services/session/ask-entitlement.ts`, exporting `AskPrincipal`,
  `AskSubject`, `askEntitlement()` and `readAskPrincipal()`.
- Three outcomes, because there are three genuinely different callers today: `'answer'`
  (the operator, and an allowlisted bridged approver), `'see'` (a program holding the
  person's own per-user API key under login-on — it can already read the same detail off
  `GET /api/sessions/:id/events`, so cutting it here would break integrations while
  protecting nothing), and `'none'` (anything presenting an agent identity, and any
  bridged person who is not an approver).
- `eventFanOut.addClient(client, principal)` and
  `broadcast(eventName, data, audience?)`. One encode, as today; the audience only decides
  who the encoded frame is written to.
- `requirePersonToAnswer` is NOT given a second bar it could never fail. It keeps its
  exact behaviour and gains a conformance test binding it to `askEntitlement`, so the two
  can never come to mean different things by "may answer".
- The bridged half: an actionable Approve/Deny card reaches a bridged chat **only** when
  that chat is `platformChatType === 'private'` and its one external author is on the
  bridge adapter's approver allowlist. Anything else — a group, a supergroup, a private
  chat with a non-approver — gets the vague waiting sentence and nothing more. The click
  runs `mayApprove` in the adapter as it does today AND `askEntitlement` on the server
  before the runtime is touched.

## 5) Decisions

| #   | Decision                                                 | Choice                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who is entitled, stated once                             | The session owner (which on this install is the one account the registration policy allows) ∪ the room-approver allowlist for a room-bound Ask. Expressed as `askEntitlement(principal, subject)`.                               | The brief's model, and the only one the code can support honestly: `accounts.ts` guarantees one account, and `mayApprove` is the only other set of people DorkOS knows about.                                                                            |
| 2   | Three outcomes, not two                                  | `'answer' \| 'see' \| 'none'`.                                                                                                                                                                                                   | Three callers exist today and they differ. Collapsing `see` into `none` would cut a person's own API-key integration out of a list while it can still read the same detail one route over — a bar that breaks something and protects nothing.            |
| 3   | What an agent gets                                       | `'none'`, always, whatever else it presents, for every Ask including one raised by a session it is running in.                                                                                                                   | `presentsAgentIdentity` is true for a header that did not even resolve, which is the property that makes "the requester never self-approves" structural rather than a comparison. Same reasoning one layer up in `requirePersonToAnswer`.                |
| 4   | Login-off behaviour                                      | Unchanged. A caller with no credential and no agent header is the operator and is entitled to everything.                                                                                                                        | This is the shipped posture and the documented residual (`caller-authority.ts`): with no accounts DorkOS cannot tell the cockpit from a program on the same machine, and this spec does not pretend otherwise.                                           |
| 5   | The list route's refusal shape                           | `200` with an empty `interactions` array, never `403`.                                                                                                                                                                           | The rooms domain's own rule — "not a member answers exactly as no such room" — so a room id is never a capability. A 403 would tell a machine that Asks exist.                                                                                           |
| 6   | Where the fan-out principal comes from                   | A **required** second argument to `addClient`, built by each transport from the identity it already holds (`res.locals` for SSE, `attempt.locals` for the WebSocket).                                                            | The `UpgradeRoute.credential` lesson, verbatim: a posture stated as data cannot be forgotten by a new route, and the wiring is the part an exploit uses.                                                                                                 |
| 7   | Whether the addressing applies to every event            | No. `broadcast` takes an OPTIONAL audience; only `interaction_pending` passes one.                                                                                                                                               | Every other event on the bus is already something the caller could read from its own resource route. Addressing them all would be a large, untested behaviour change riding along with this one.                                                         |
| 8   | In-process listeners under addressing                    | They always receive, addressed or not.                                                                                                                                                                                           | A listener is the server itself (the local `CommunityAdapter`), not a caller. Filtering it would break a subsystem to enforce a rule about people.                                                                                                       |
| 9   | Whether `interaction_resolved` is addressed too          | No — it is broadcast to everyone.                                                                                                                                                                                                | It carries `sessionId`, an `interactionId` and an outcome. It is a receipt with no detail in it, and an unentitled client that never saw the `pending` simply has nothing to close. Addressing it would cost a second subject resolution per resolution. |
| 10  | Whether the answer routes get a second bar               | No. `requirePersonToAnswer` keeps its exact behaviour; a conformance test binds it to `askEntitlement`.                                                                                                                          | Under one account the second bar could never fail, and a check that cannot discriminate is worse than none. The binding test CAN fail — seed `askEntitlement` returning `'answer'` for an agent and it goes red.                                         |
| 11  | Where the bridged actionable card may land               | Only a bridged chat with `platformChatType === 'private'` whose single external author is on that adapter's `approverAllowlist`.                                                                                                 | An approval binds to the action the person SAW (ADR 260725-133221), so a card must carry the detail; and detail may only go where every reader may answer. A group chat's audience is unknowable — lurkers are not on the roster.                        |
| 12  | Whether to fix the same weakness on the direct-bind path | No. Recorded as a follow-up.                                                                                                                                                                                                     | `approver-allowlist.ts`'s module doc already records that a direct-bind card lands in a channel anyone can read. Changing it is a change to every direct-bind operator's shipped behaviour and belongs in its own item with its own review.              |
| 13  | Server-side re-check of a relay approval                 | Yes. `handleApprovalResponse` takes a required `authorize` port; the server answers it with `askEntitlement`. A room-bound session refuses an unentitled clicker; a direct-bound session keeps the adapter's own gate as today.  | The relay bus has no authority of its own — `approval-handler.ts` calls `approveTool` on whatever it is handed. Adding a path that publishes on that bus without a server-side answer would be a new way to run a tool.                                  |
| 14  | The bridged waiting sentence                             | `awaiting_approval` joins the bridge's deliverable notices, re-rendered per kind for the far end (approval / question / something needed), naming no tool, no path and no command — and skipped for a turn that got a real card. | DOR-1359 declined this; the brief makes it part of this item. Re-rendering rather than forwarding is the pattern `turn_failed` already uses, because the room's own line points at "Ana's session", which is meaningless on Telegram.                    |
| 15  | What the client needs                                    | Nothing new.                                                                                                                                                                                                                     | The store reads the list on mount and the stream after; both are filtered server-side, so the two agree by construction. No new event name, no schema change, no allowlist entry.                                                                        |
| 16  | Whether `AskSubject` gets a session-owner field now      | No. The subject carries `sessionId`, optional `roomId` and the resolved approver ids. Ownership is answered by the install having one account.                                                                                   | A per-session owner column with one possible value is a migration, a write path and a reconciler for a fact nothing can vary. The seam where a second person enters is `resolveAskSubject`, which is documented and one function wide.                   |

## 6) Risks

- **The fan-out's hot path.** `broadcast` runs for every event on the server. The audience
  is one optional callback invoked per client, only for events that pass one, and the
  encode still happens once. Pinned by a test that a plain broadcast reaches every client
  and performs no per-client work beyond `send`.
- **A cockpit that stops seeing Asks.** The cockpit's WebSocket presents no agent header,
  so it resolves to `'operator'`. The failure mode to guard is a transport that forgets to
  pass a principal — which is why the parameter is required rather than defaulted.
- **The bridged card as a new way to run a tool.** Mitigated by two independent gates that
  both fail closed: the adapter's `mayApprove` on the click (unchanged), and the server's
  `askEntitlement` before `approveTool`. Either alone would be enough; neither is trusted
  to be the only one.
- **Copy that leaks.** The bridged waiting sentence is written from the room's own
  vocabulary and reviewed against DOR-613's rule. The test asserts the delivered string
  contains no tool name, path or command from the interaction.
