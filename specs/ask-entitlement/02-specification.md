---
slug: ask-entitlement
id: 260819-023728
created: 2026-08-19
status: specified
tracker: DOR-1356
project: Unified Conversation Surfaces
---

# Per-person Ask entitlement: the fleet-wide list and the fan-out filter by who may answer

**Status:** Draft
**Author:** Claude (IDEATE+SPECIFY author)
**Date:** 2026-08-19

## Overview

An Ask's detail — the tool name, the command or file path it would run against, the
session's working directory — is broadcast to every caller the session gate admits, and
listed to every caller the session gate admits. This spec puts one predicate in front of
both, so the detail reaches only whoever may act on it, and gives an allowlisted approver
on a bridged chat a real Approve and Deny for a room-bound Ask while everybody else in
that chat keeps only a sentence that names nothing.

## Background / Problem Statement

P3 of the unified-conversation programme (DOR-1330) shipped the fleet-wide Ask. Its own
record, `specs/unified-conversation/04-implementation.md` Known Issue 23, states the gap
without softening it:

> **Nobody checks who may SEE a prompt, and the changelog now says so.** The detail rides
> the per-caller global stream and the list route, both of which answer this cockpit's
> operator — the person who can answer. That is true and sufficient on a single-identity
> install… **The follow-up, if DorkOS ever has more than one person: the list route and the
> fan-out both need a per-caller filter**, which is a change to `eventFanOut`'s addressing
> model.

Two things are true that the issue does not say. First, "answer this cockpit's operator" is
not quite what either surface does: both answer anything that clears `sessionGate`, and an
**agent** clears it. With login off it needs no credential at all; with login on it holds
one of the person's API keys, which is how a Codex or OpenCode agent reaches the operator
surface. Presenting `X-DorkOS-Agent`, a caller can hold `GET /api/events` open and read
every pending shell command in every project on the machine, live — and can list them all
with one `GET /api/sessions/pending-interactions`. It cannot answer: `requirePersonToAnswer`
(`apps/server/src/routes/sessions.ts:120-127`) refuses every agent structurally. It can
read.

Second, DorkOS already has a second set of people, and they are not in the cockpit: the
approvers named on a relay adapter's `approverAllowlist`
(`packages/relay/src/adapters/approver-allowlist.ts`). A room bridged to a Telegram chat
shows those people a sentence saying an agent is waiting — late by a minute, naming
nothing — and gives them nothing to press. The approval they could give lives in a cockpit
they may not have open.

So the entitlement model this spec builds has two real members from its first commit, and
the gap it closes is present-tense rather than hypothetical.

## Goals

- One server-side predicate answers "may this caller see this Ask, and may they act on
  it", and every surface that shows or accepts an Ask reads that one predicate.
- `GET /api/sessions/pending-interactions` returns only rows the caller is entitled to.
- `interaction_pending` is addressed on the global fan-out rather than broadcast, so an
  unentitled connection never receives the detail at all.
- An allowlisted approver on a bridged private chat gets an actionable Approve/Deny card
  for a room-bound Ask, gated twice and failing closed at both gates.
- Everybody else on a bridged chat gets one plain sentence per kind that names no tool, no
  path and no command.
- Today's single-account cockpit behaviour does not change in any observable way.

## Non-Goals

- A second cockpit account, invites, or a per-session owner column. The registration policy
  permits exactly one account (`apps/server/src/services/core/auth/accounts.ts` module
  doc), so there is no second person to discriminate against inside the cockpit and no
  honest test for one.
- Widening the direct-bind approval path. `approver-allowlist.ts`'s module doc already
  records that a direct-bind card lands in whatever channel the bot sits in; changing that
  is a change to every direct-bind operator's shipped behaviour and belongs to its own item.
- Addressing every event on the fan-out. Only `interaction_pending` gets an audience.
- Room-scoped Ask signals, `RoomTurnWaiting`'s shape, `WAITING_NOTICE_GRACE_MS`, or the
  room's own `awaiting_approval` copy. All unchanged.
- Any client change. If the server filters, the client has nothing to do.

## Technical Dependencies

None new. Everything composes from shipped pieces:

- `presentsAgentIdentity` — `apps/server/src/middleware/agent-identity.ts:70-77`
- `RequestUser.credential` — `apps/server/src/services/core/auth/session-gate.ts:41-58`
- `StreamUpgradeLocals` — `apps/server/src/services/core/streams/stream-upgrade-auth.ts:44-53`
- `mayApprove` / `toIdList` — `packages/relay/src/adapters/approver-allowlist.ts`, re-exported
  at `packages/relay/src/index.ts:244`
- `RoomSessionBinding`, `bindingForSession` — `apps/server/src/services/rooms/room-session-ledger.ts:31-36, :118`
- `buildBridgePrincipal` — `apps/server/src/services/relay/bridge-principal.ts`

## Detailed Design

### 1. The principal — one reader for "who is calling"

New module `apps/server/src/lib/caller-principal.ts`, beside `caller-authority.ts` and for
the same anti-divergence reason its module doc gives: several surfaces ask this and they
must not mean different things by it.

```ts
/**
 * Who is on the other end of a request or a stream connection, in the only terms
 * anything here needs.
 *
 * A `res.locals`-shaped read, exactly like {@link readCallerAuthority}, so both
 * transports answer it identically: the Express chain fills `res.locals`, and a
 * WebSocket upgrade fills the same shape itself (`StreamUpgradeLocals`).
 */
export type CallerPrincipal =
  /** A person in the cockpit — or, with login off, anything that presents nothing. */
  | { readonly kind: 'operator' }
  /** A program proving the person's identity with one of their per-user API keys. */
  | { readonly kind: 'program'; readonly userId: string }
  /** Anything presenting `X-DorkOS-Agent`, resolved or not. */
  | { readonly kind: 'agent' }
  /** Somebody clicking a button on a chat platform. Never arrives over HTTP. */
  | { readonly kind: 'bridged'; readonly platform: string; readonly platformUserId: string };

/**
 * Read the principal off a request and the locals the gate filled.
 *
 * Order is load-bearing and fails closed: the agent question is asked FIRST, so a
 * caller holding a valid credential AND presenting an agent header reads as an
 * agent. That is the same precedence `resolveDecisionAuthority` uses, and the
 * reason DOR-474 exists.
 */
export function readCallerPrincipal(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
): CallerPrincipal;
```

Implementation, in full:

1. `presentsAgentIdentity(req, res)` → `{ kind: 'agent' }`.
2. `(res.locals.user as RequestUser | undefined)?.credential === 'api-key'` →
   `{ kind: 'program', userId }`.
3. otherwise → `{ kind: 'operator' }`.

There is no `bridged` branch here: nothing on a chat platform speaks HTTP to this server.
It is constructed by the relay path in §5 and is a member of the union so that one function
answers for both worlds.

### 2. The policy — `askEntitlement`

New module `apps/server/src/services/session/ask-entitlement.ts`. It lives beside
`pending-interactions.ts` and `session-list-broadcaster.ts` because an Ask is a session
fact; the room half arrives as data on the subject rather than as an import, so this module
never reaches into `services/rooms/` or `services/relay/`.

```ts
/** The Ask an entitlement question is about. */
export interface AskSubject {
  /** The session whose turn is parked. */
  readonly sessionId: string;
  /** The room this session answers for, when it answers for one. */
  readonly roomId?: string;
  /**
   * Platform user ids allowed to authorize this room's tool calls, as the bridge
   * adapter's `approverAllowlist` holds them.
   *
   * Resolved ONLY on the bridged path (§5): a `bridged` principal is the only one
   * this list can ever answer for, and it cannot arrive over HTTP. The cockpit
   * surfaces therefore pass a subject without it, and that is correct rather than
   * incomplete.
   */
  readonly approvers?: readonly string[];
}

/** What a principal may do with one Ask. */
export type AskEntitlement =
  /** See the detail and act on it. */
  | 'answer'
  /** See the detail; the answer bar is somebody else's. */
  | 'see'
  /** Neither. The Ask does not exist for this caller. */
  | 'none';

/**
 * Whether this caller may see an Ask's detail, and whether they may act on it.
 *
 * **The rule, in one sentence: the detail follows the answer right.** Everything
 * that may answer may see; the one thing that may see without answering is the
 * person's own program, which can already read the identical detail off
 * `GET /api/sessions/:id/events` — withholding it here would break an integration
 * and protect nothing.
 *
 * Fails closed on every uncertainty, the same discipline `mayApprove` states.
 */
export function askEntitlement(principal: CallerPrincipal, subject: AskSubject): AskEntitlement;
```

The whole table, and it is the whole implementation:

| Principal                                        | Result     | Why                                                                                                                                                                      |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                                          | `'none'`   | An agent may never decide, and reading every other agent's pending command across the machine is the capability this closes. True even for the session it is running in. |
| `operator`                                       | `'answer'` | One account owns this install; the operator owns every session on it. Login-off, this is also the credential-free caller, unchanged.                                     |
| `program`                                        | `'see'`    | `requirePersonToAnswer` refuses it (DOR-474). It already reads the same detail one route over.                                                                           |
| `bridged`, in `subject.approvers`, same platform | `'answer'` | `mayApprove(subject.approvers, platformUserId)`, and only when `subject.approverPlatform` is the platform the caller clicked from.                                       |
| `bridged`, not in `approvers`                    | `'none'`   | Absence is not consent. An empty or absent list authorizes nobody.                                                                                                       |
| `bridged`, `subject.roomId` unset                | `'none'`   | A chat platform user has no standing over a session no room owns.                                                                                                        |

`subject.sessionId` is on the type and unread by the body today. It is there because it is
the seam a second person enters through — `askEntitlement` is where "which sessions are
yours" would be asked — and because every caller already holds it. Its TSDoc says exactly
that, so the next reader does not mistake it for a leftover.

### 3. The two cockpit surfaces

#### 3.1 `GET /api/sessions/pending-interactions`

`apps/server/src/routes/sessions.ts:235-250`. One filter, inside the existing `.map`, which
becomes a `flatMap`:

```ts
const principal = readCallerPrincipal(req, res);
const interactions = listPendingInteractionsAcrossSessions().flatMap((row) => {
  const binding = bindings?.bindingForSession(row.sessionId);
  const subject: AskSubject = {
    sessionId: row.sessionId,
    ...(binding ? { roomId: binding.roomId } : {}),
  };
  if (askEntitlement(principal, subject) === 'none') return [];
  return [
    {
      sessionId: row.sessionId,
      cwd: row.cwd,
      interaction: row.interaction,
      ...(binding ? { roomId: binding.roomId, roomAuthorId: binding.authorId } : {}),
    },
  ];
});
```

**It answers `200` with an empty array, never `403`.** That is the rooms domain's own rule
— "not a member answers exactly as no such room" — so the response never tells a machine
that Asks exist. The route's existing comment block, which today says its authority is
"`sessionGate` and nothing more, deliberately", is rewritten: reading that something needs a
person is still not deciding it, and a cockpit that has not proven itself for a decision
still gets the pill — what has changed is that a caller which is not a person AT ALL gets
nothing.

`warnings` stays as it is.

#### 3.2 The fan-out gains a per-connection principal

`apps/server/src/services/core/event-fan-out.ts`:

```ts
/** Register a client. Returns an unsubscribe function. */
addClient(client: FanOutClient, principal: CallerPrincipal): () => void;

/**
 * Decide, per connected client, whether one broadcast is that client's to receive.
 *
 * Omitted means everyone, which is what every event on this bus has always meant
 * and what all but one still mean.
 */
export type BroadcastAudience = (principal: CallerPrincipal) => boolean;

broadcast(eventName: string, data: unknown, audience?: BroadcastAudience): void;
```

Four properties this must keep, each with a test in §Testing:

1. **One encode.** `encodeBroadcast` still runs once per broadcast, before the client loop.
   The audience decides who a frame is written to, never how many times it is rendered.
2. **`principal` is REQUIRED, not defaulted.** A default would be a silent allow for the
   next stream somebody adds. This is the argument `UpgradeRoute.credential` already makes
   in `upgrade-router.ts:88-105` — "the gate was tested, but the _wiring_ of it — the part
   an exploit uses — was not" — and the same shape: state the posture as data at the call
   site, so it cannot be forgotten.
3. **In-process listeners always receive.** `subscribe()`'s consumers are the server itself
   (the local `CommunityAdapter`), not callers. The audience is applied to the client loop
   only, and `subscribe`'s doc gains one sentence saying so.
4. **Backpressure is unchanged.** A client the audience skips is not measured, not dropped,
   and not deleted from the set.

Internally the client set becomes `Set<{ client: FanOutClient; principal: CallerPrincipal }>`.

The two transports supply the principal from what they already hold:

- `apps/server/src/routes/events.ts:64` — `eventFanOut.addClient(client, readCallerPrincipal(req, res))`.
  The Express chain has already run `sessionGate` and `resolveAgentIdentity`.
- `apps/server/src/routes/events-socket.ts:75` — `globalEventsRoute.authorize` currently
  takes no argument and throws `attempt.locals` away. It becomes
  `authorize({ headers, locals })` and calls
  `eventFanOut.addClient(client, readCallerPrincipal({ headers }, { locals }))`.
  `StreamUpgradeLocals` is `res.locals`-shaped precisely so this works with no second notion
  of who a caller is (`stream-upgrade-auth.ts:22-26`).

#### 3.3 Addressing `interaction_pending`

`apps/server/src/services/session/session-list-broadcaster.ts:483-506`. Only the `pending`
branch changes:

```ts
const subject: AskSubject = {
  sessionId: change.sessionId,
  ...(binding ? { roomId: binding.roomId } : {}),
};
eventFanOut.broadcast(
  'interaction_pending',
  InteractionPendingEventSchema.parse({
    /* unchanged */
  }),
  (principal) => askEntitlement(principal, subject) !== 'none'
);
```

`interaction_resolved` is **not** addressed, and the method's TSDoc says why: it carries a
session id, an interaction id and an outcome, and no detail at all. A client that never
received the `pending` simply has nothing to close, and addressing the receipt would cost a
second subject resolution on every resolution to withhold a fact that is already public on
the session's own stream.

### 4. The answer routes keep exactly their bar

`requirePersonToAnswer` (`routes/sessions.ts:120-127`) is **not changed and not given a
second gate.** Under one account, an entitlement check behind it could never fail, and a
check that cannot discriminate is worse than none.

What it gains is a binding, so the two can never come to mean different things by "may
answer": `apps/server/src/services/session/asks/__tests__/ask-answer-conformance.test.ts` drives
the same five callers through `requirePersonToAnswer`'s two composed pieces and through
`askEntitlement`, and fails if they disagree. It is modelled on
`services/core/approvals/__tests__/person-proof-conformance.test.ts`, which states the
pattern and its limits, and it is derived from a list of seams rather than routes for the
same reason.

The guard's TSDoc gains one paragraph naming `askEntitlement` as the shared statement of
who may answer, and naming the conformance test as what holds them together.

### 5. The bridged half

#### 5.1 What a bridged chat may receive

New predicate, `apps/server/src/services/relay/chat-bridge/ask-audience.ts`:

```ts
/**
 * Whether an Ask's DETAIL may be delivered into one bridged chat.
 *
 * True only for a `private` chat — one person on the other end — whose single
 * external author is on that adapter's approver allowlist. A group or supergroup
 * is never eligible, however many approvers are in it, because the platform
 * cannot tell us who is READING: a lurker who has never posted has no author row,
 * so the roster under-counts the audience and would licence a leak.
 *
 * An approval binds to the exact action the person saw (ADR 260725-133221), so a
 * card must carry the detail; and detail may only go where every reader may act
 * on it. Those two sentences together are this predicate.
 */
export function bridgedAskIsActionable(input: {
  readonly bridge: Bridge;
  readonly externalAuthors: readonly { readonly platformUserId: string }[];
  readonly approvers: readonly string[];
}): boolean;
```

Body: `bridge.archivedAt === null` and `bridge.platformChatType === 'private'` and
`externalAuthors.length === 1` and `mayApprove(approvers, externalAuthors[0].platformUserId)`.
Every clause fails closed.

`externalAuthors` comes from the room's roster: entries whose `origin` is not `'local'`,
resolved through `AuthorRegistry.getById(authorId).naturalKey`. Reading the platform user id
back off that key needs the parse `author-registry.ts` already owns —
`externalKeyParts` at `:1331`, today private. It is **exported** under the name
`externalAuthorParts` rather than re-implemented, because that module's own doc already
warns: "One parse, two readers… Two parses of one key shape is how they come to disagree
about where a person is."

`approvers` comes from `AdapterManager.getAdapter(bridge.adapterId)?.config.config.approverAllowlist`
(`packages/shared/src/relay-adapter-schemas.ts:160, :314`), read through `toIdList` so the
textarea shape the setup form produces is tolerated exactly as the adapters tolerate it.

#### 5.2 Delivering the card

New module `apps/server/src/services/relay/chat-bridge/ask-card.ts`, class
`BridgedAskDelivery`, constructed in `binding-subsystem.ts` beside `ChatBridgeDelivery` and
wired to the same `resolveSubject` and publisher.

It subscribes to `onProjectorInteractionChange` — the same seam the session-list broadcaster
uses, so a room-bound Ask on any runtime is covered without adapter work — and on `pending`:

1. `bindingForSession(sessionId)` → no binding, stop.
2. `findBridgeByRoom(roomId)` → no live bridge, stop.
3. `bridgedAskIsActionable(...)` → false, stop. (The waiting sentence in §5.4 still runs;
   this is the only place the two diverge.)
4. Build the `approval_required` StreamEvent payload the shipped adapter outbound path
   already renders (`telegram/outbound.ts:479-505` → `handleApprovalRequired`;
   `slack/outbound.ts:306-320`), carrying `toolCallId` (the interaction's `id`),
   `sessionId` (the runtime session id — the same value `POST /api/sessions/:id/approve`
   passes to `runtime.approveTool`), `toolName` and `input` from the DTO, and the room
   binding's `authorId` as the `agentId` segment.
5. Publish it on the chat's `relay.human.*` subject with
   `buildBridgePrincipal('initiate', bridge.adapterId, bridge.chatId)` and
   `serverBridgePrincipal: true`.

**The classification is `'initiate'`, deliberately.** An Ask card is DorkOS starting a
message the person did not just prompt, so an operator who switched initiate off for that
chat does not receive unsolicited approval cards. Claiming `'reply'` would misrepresent
provenance to the consent gate, which is the exact class of thing
`ChatBridgeDelivery.classifyProvenance` guards against (the cross-room leak, `deliver.ts:548-574`).

Only the `approval` kind of interaction produces a card. A question or an elicitation needs
free text back, which the adapters' button path cannot carry; both get the waiting sentence
and nothing else, and the module doc says so rather than leaving it to be discovered.

On `resolved`, the delivery clears its own record for that interaction so §5.4's suppression
does not outlive the turn. The card in the chat is edited by the adapter's own click
handler, exactly as a direct-bind card is; a card nobody pressed is left standing, which is
what the direct-bind path already does and is not this item's to change.

#### 5.3 The click is checked twice

`packages/relay/src/adapters/claude-code/approval-handler.ts` today calls
`agentManager.approveTool(sessionId, toolCallId, approved)` with no authority check of its
own — the adapters' in-process `mayApprove` is the only thing between the relay bus and a
tool running. Adding a new publisher onto that bus without a server-side answer would be a
new way to run a tool, so:

```ts
/**
 * Whether this platform user may authorize this session's tool call.
 *
 * A REQUIRED parameter, never optional and never defaulted: the adapters' own
 * `mayApprove` gate answers for the binding it lives on, and a room-bound Ask
 * reaches this bus by a path no adapter binding covers. A default would be an
 * allow for whatever is added next.
 */
export type ApprovalAuthorizer = (decision: {
  readonly sessionId: string;
  readonly platform: string;
  readonly respondedBy: string | undefined;
}) => boolean;

export function handleApprovalResponse(
  envelope: RelayEnvelope,
  agentManager: AgentRuntimeLike,
  log: Pick<Console, 'warn' | 'debug'>,
  authorize: ApprovalAuthorizer
): void;

export function subscribeApprovalHandler(
  relay: RelayPublisher,
  agentManager: AgentRuntimeLike,
  log: Pick<Console, 'warn' | 'debug'>,
  authorize: ApprovalAuthorizer
): Unsubscribe;
```

A refused decision logs one warn line naming the platform and the session, and returns
without touching the runtime.

The server answers it (`services/relay/adapter-manager.ts`, where
`subscribeApprovalHandler` is wired) as:

- the session is room-bound → `askEntitlement({ kind: 'bridged', platform, platformUserId: respondedBy }, { sessionId, roomId, approvers })`
  must be `'answer'`;
- the session is not room-bound → `true`, the direct-bind path keeping the shipped gate it
  has. That is a stated boundary, not a fail-open default: §Non-Goals says the direct-bind
  path is not widened here, and the follow-up records the residual its own module doc
  already names.

A `respondedBy` of `undefined` refuses on the room-bound branch (`mayApprove` returns false
for an unidentified caller), which is the same answer the adapters give.

#### 5.4 The bridged waiting sentence, per kind

`awaiting_approval` joins `DELIVERABLE_NOTICES` (`chat-bridge/deliver.ts:78`), which becomes
three codes rather than two, and is **re-rendered** for the far end in
`buildNoticeContent` (`deliver.ts:619-626`) rather than forwarded — the same treatment
`turn_failed` already gets, and for the same reason: the room's own line says "Open Ana's
session to answer", which is the right pointer for a cockpit reader and meaningless to
somebody on Telegram.

New copy in `apps/server/src/services/rooms/notices/notice-copy.ts`, beside `WAITING_LINES`
and written under the same constraint its doc states — no tool name, no question, no path,
no countdown:

```ts
/**
 * The far-end rendering of a waiting notice, one sentence per kind.
 *
 * Deliberately vaguer than the room's own line, and by one word: it does not say
 * "open its session", because the reader may not have one. It says where the
 * answer lives and that the wait is bounded, and nothing about what is being
 * asked — the same rule the room's line keeps (DOR-613), for a reader who is
 * further away rather than closer.
 */
export function bridgeWaitingText(agentName: string, kind: WaitingKind): string;
```

The three sentences, in plain words:

- **approval** — `Ana is waiting for someone to approve something before it can carry on. Answer it in DorkOS. It gives up if nobody does.`
- **question** — `Ana has a question that needs answering before it can carry on. Answer it in DorkOS. It gives up if nobody does.`
- **elicitation** — `Ana needs something before it can carry on. Answer it in DorkOS. It gives up if nobody does.`

The kind is read off `entry.body` — `buildWaitingNotice` writes `notice: 'awaiting_approval'`
for all three kinds today, so the entry does not carry which one it was. **It gains one
field**: `RoomEntryBody` already carries `subjectAuthorId`; `buildWaitingNotice` also writes
`waitingKind: WaitingKind`, optional on the schema so every stored entry still parses, and
the bridge falls back to the `approval` sentence when it is absent. That is one field with
exactly one reader, added because the alternative — three notice codes — would change the
damping key the room turn runner depends on.

**A turn that got a real card does not also get the sentence.** `BridgedAskDelivery` records
the `(roomId, interactionId)` pairs it delivered a card for; `ChatBridgeDelivery` asks it
before delivering an `awaiting_approval` notice and skips when a card is standing. Without
this, an approver sees the card immediately and a near-duplicate line a minute later. The
room's own log is untouched either way — the notice is always written, only its delivery is
suppressed — which keeps the cockpit's reading of the room identical to today.

### Code structure & file organization

| Path                                                             | Change                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/lib/caller-principal.ts`                        | **New.** `CallerPrincipal`, `readCallerPrincipal`.                                       |
| `apps/server/src/services/session/ask-entitlement.ts`            | **New.** `AskSubject`, `AskEntitlement`, `askEntitlement`.                               |
| `apps/server/src/services/core/event-fan-out.ts`                 | `addClient(client, principal)`, `broadcast(name, data, audience?)`, `BroadcastAudience`. |
| `apps/server/src/routes/events.ts`                               | Pass the principal.                                                                      |
| `apps/server/src/routes/events-socket.ts`                        | `authorize(attempt)` reads `attempt.locals`; pass the principal.                         |
| `apps/server/src/routes/sessions.ts`                             | Filter the list route; the guard's TSDoc names the shared policy.                        |
| `apps/server/src/services/session/session-list-broadcaster.ts`   | Address `interaction_pending`.                                                           |
| `apps/server/src/services/rooms/author-registry.ts`              | Export `externalAuthorParts` (the existing private parse, renamed and exported).         |
| `apps/server/src/services/rooms/notices/notice-copy.ts`          | `bridgeWaitingText`; `buildWaitingNotice` writes `waitingKind`.                          |
| `packages/shared/src/room-schemas.ts`                            | `RoomEntryBody.waitingKind` — optional.                                                  |
| `apps/server/src/services/relay/chat-bridge/ask-audience.ts`     | **New.** `bridgedAskIsActionable`.                                                       |
| `apps/server/src/services/relay/chat-bridge/ask-card.ts`         | **New.** `BridgedAskDelivery`.                                                           |
| `apps/server/src/services/relay/chat-bridge/deliver.ts`          | `awaiting_approval` deliverable; re-render; suppress when a card stands.                 |
| `apps/server/src/services/relay/binding-subsystem.ts`            | Construct and wire `BridgedAskDelivery`.                                                 |
| `apps/server/src/services/relay/adapter-manager.ts`              | Supply the `ApprovalAuthorizer`.                                                         |
| `packages/relay/src/adapters/claude-code/approval-handler.ts`    | Required `authorize` parameter; refuse-and-log path.                                     |
| `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` | Thread `authorize` through to `subscribeApprovalHandler`.                                |

### API changes

- `GET /api/sessions/pending-interactions` — response SHAPE unchanged; the array is now
  scoped to the caller. The OpenAPI description gains one sentence saying so, which
  regenerates `docs/api/openapi.json` and `docs/api/api/sessions/pending-interactions/get.mdx`.
- `GET /api/events` — no new event names, no changed payloads. `interaction_pending` is
  addressed. `docs/integrations/sse-protocol.mdx` gains one paragraph.

### Data model changes

One optional field, `RoomEntryBody.waitingKind`. No migration: room entry bodies are stored
as JSON and the field is optional with a documented fallback.

## User Experience

Nothing a person operating DorkOS today can see changes. The cockpit presents no agent
header and holds no API key, so it resolves to `operator` and is entitled to everything, on
both transports and on the list route. The header pill, the home triage and the session
card behave exactly as they did.

What changes is for people who are not at the cockpit:

- **On a bridged private chat, if you are on the approver list**, an agent that stops for a
  tool approval now sends you the card, with the tool it wants to run and Approve and Deny.
  Press one and the agent carries on. This is the same card a direct-bound agent already
  sends, arriving for a room-bound one.
- **On a bridged group chat, or if you are not on the approver list**, nothing about what
  the agent wants to run reaches you. A minute after it stops, one sentence says it is
  waiting and that the answer happens in DorkOS.
- **Programs you have given an agent identity to** stop receiving other agents' prompts.
  They could never answer them; now they cannot read them either.

Error and exit paths: an unentitled list read is an empty list, not an error. An unentitled
click on a chat platform is refused by the adapter with the message it already sends
("You are not on this integration's approver list"), and refused again server-side with a
log line and no effect.

## Testing Strategy

Test names below are the file paths; each case carries a purpose comment, and each is
listed with the seeded defect that must turn it red.

### Unit — the policy

`apps/server/src/services/session/__tests__/ask-entitlement.test.ts`

| Case                                                            | Seeded defect that must fail it                   |
| --------------------------------------------------------------- | ------------------------------------------------- |
| an agent gets `none`, for a room-bound and an unbound Ask alike | return `'see'` for `kind: 'agent'`                |
| the operator gets `answer`                                      | return `'see'` for `kind: 'operator'`             |
| a program gets `see`, never `answer`                            | return `'answer'` for `kind: 'program'`           |
| a bridged approver on a room-bound Ask gets `answer`            | drop the `roomId` requirement                     |
| a bridged non-approver gets `none`                              | fall back to `true` on an empty allowlist         |
| a bridged approver on an Ask with no `roomId` gets `none`       | answer from `approvers` without checking `roomId` |
| an empty and an absent `approvers` both give `none`             | treat absence as "anyone"                         |

`apps/server/src/lib/__tests__/caller-principal.test.ts` — the ordering: a caller with a
cookie AND an unresolvable `X-DorkOS-Agent` reads as `agent`. Seed: ask the credential
question first, and this goes red.

### Unit — the fan-out

`apps/server/src/services/core/__tests__/event-fan-out.test.ts` (extended)

- An unaddressed broadcast reaches every client, whatever their principal. Seed: apply the
  audience unconditionally.
- An addressed broadcast reaches only the clients whose principal the audience accepts,
  with two clients of different principals connected. Seed: ignore the audience.
- The audience is asked once per client and the frame is encoded once whatever the audience
  answers, proved by a counting spy on `encodeStreamFrame`. Seed: encode inside the loop.
- A skipped client's `bufferedBytes` is never read and it is never dropped. Seed: run the
  backpressure check before the audience.
- In-process `subscribe` listeners receive an addressed broadcast. Seed: apply the audience
  to the listener loop.

### Server route tests

`apps/server/src/routes/__tests__/sessions-pending-interactions.test.ts` (extended) — the
filtering table, driven through the real router:

| Caller                                         | Expectation                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| a person in the cockpit, login off             | every parked Ask                                                    |
| a person with a session cookie, login on       | every parked Ask                                                    |
| a caller presenting `X-DorkOS-Agent`, resolved | `200`, `interactions: []`                                           |
| a caller presenting `X-DorkOS-Agent: garbage`  | `200`, `interactions: []` — an unresolved header is still a machine |
| a per-user API key, login on                   | every parked Ask (`see` is not `none`)                              |

Seed: make `askEntitlement` return `'see'` for an agent and the two agent rows go red while
nothing else moves.

`apps/server/src/services/session/asks/__tests__/ask-answer-conformance.test.ts` — **new.**
The five callers that can reach both seams, driven through both
`requirePersonToAnswer`'s composed pieces and `askEntitlement`, failing if they disagree
about who may answer. Seed: `askEntitlement` returning `'answer'` for an agent.

### Fan-out addressing, end to end on the broadcaster

`apps/server/src/services/session/__tests__/session-list-broadcaster-asks.test.ts` (extended)

- Two recording fan-out clients, one `operator` and one `agent`; a projector parks a turn;
  only the operator's client holds the frame. Seed: pass no audience.
- `interaction_resolved` reaches both. Seed: address it too, and this goes red — which is
  what pins decision 9 rather than leaving it as prose.

### The bridged half

`apps/server/src/services/relay/chat-bridge/__tests__/ask-audience.test.ts` — the predicate:
a private chat with one allowlisted author (true); a private chat with a non-allowlisted
author (false); a group with two allowlisted authors (false); a supergroup (false); an
archived bridge (false); an empty allowlist (false); a private chat with two external
authors, which a group migration can produce (false).

`apps/server/src/services/relay/chat-bridge/__tests__/ask-card.test.ts` — a room-bound
approval Ask on an eligible bridge publishes one `approval_required` payload on the chat's
subject with an `initiate` bridge principal and the interaction's own id as `toolCallId`; an
ineligible bridge publishes nothing; a question and an elicitation publish nothing; an Ask
on a session no room owns publishes nothing.

`apps/server/src/services/relay/chat-bridge/__tests__/deliver.test.ts` (extended) — an
`awaiting_approval` notice is delivered, re-rendered per kind; the delivered string contains
none of the interaction's `toolName`, `input` or `blockedPath` (asserted against a fixture
whose tool name is a distinctive token); the notice is skipped while a card stands for that
turn and delivered once the card resolves; the room's own entry is written either way.

`packages/relay/src/adapters/claude-code/__tests__/approval-handler.test.ts` — a refused
`authorize` never reaches `approveTool` and logs one line; an accepted one does; the
authorizer is handed the payload's `sessionId`, `platform` and `respondedBy`. Seed: default
the parameter to `() => true` and the refusal case goes red.

### Browser

**No new Playwright spec, and this is a decision rather than an omission.** Everything here
is server-side, and the claim a browser is uniquely able to make — that the cockpit still
receives and can answer an Ask now that the fan-out demands a principal — is already made
by `apps/e2e/tests/conversation/ask-anywhere.ts`, which parks a session, leaves for
`/tasks`, answers there and asserts the agent streams its branch-naming sentence. A cockpit
connection that resolved to anything but `operator` fails that spec at its first
assertion. Adding a second spec asserting the same path would be a duplicate whose only
distinction is intent.

### Mocking strategy

The fan-out tests use recording `FanOutClient`s, as `event-fan-out.test.ts` already does.
The bridge tests use the fake `BridgeStore`, `DeliverPublisher` and `AuthorRegistry` doubles
`deliver.test.ts` already builds. The relay handler test uses a stub `AgentRuntimeLike`, as
its suite already does. No new mocking infrastructure.

## Performance Considerations

The fan-out's hot path gains one optional function call per client, and only for the events
that pass an audience — one event name of the dozens on the bus. The encode is unchanged at
once per broadcast. The list route gains one `askEntitlement` call per row, which is a
switch over a four-member union.

The bridged path adds one subscriber to `onProjectorInteractionChange` (the seam already has
one) and, per room-bound Ask, one roster read plus one adapter-config read. Both are indexed
reads on a path that fires at most twice per parked turn, and it is bounded by the same
thing the room notice is: turns that actually stop for a person.

## Security Considerations

- **The one behaviour this removes** is an agent's ability to read every pending tool prompt
  on the machine. It could never answer one; DOR-1357 already closed the adjacent read of
  where a room's work runs, on the same predicate. Closing it takes THREE doors, not one, and
  all three are the same predicate: the fleet-wide list, the global stream's
  `interaction_pending` **and** the `session_status` frame that carries the blocked tool and
  its target, and the per-session stream's snapshot and live prompt events.
- **What an agent still sees, stated rather than implied:** which sessions exist, their
  working directories, and the tool a session is RUNNING. A running tool is not a person
  being asked for anything, and narrowing that is a separate item.
- **Two independent gates on the bridged click, both failing closed.** The adapter's
  `mayApprove` runs in process on the click and is unchanged; the server's `askEntitlement`
  runs before the runtime is touched. Neither is trusted to be the only one, because the
  relay bus carries no authority of its own.
- **Detail follows the answer right.** An actionable card, which must show the action it
  binds to (ADR 260725-133221), goes only to a chat where every reader may answer. A group
  chat's audience cannot be known — a lurker has no author row — so a group chat never gets
  one.
- **The residual is named, not hidden.** With login off, a program on this machine that
  strips its agent header is indistinguishable from the cockpit, exactly as
  `caller-authority.ts` already states for every other bar. Turning on Require login narrows
  it to a program holding one of the person's keys, which gets `see` and not `answer`.
- **A refusal never says an Ask exists.** The list answers `200` with an empty array, the
  stream simply omits the frame.

## Documentation

- `docs/concepts/answering-agents.mdx` — a short section saying who can answer from where:
  you, in DorkOS; and, if you have named approvers on a chat integration, one of them from a
  private chat. It must not promise a per-agent approver list or a receipt naming who
  answered; the P5 record already cut both claims once.
- `docs/integrations/sse-protocol.mdx` — one paragraph: `interaction_pending` is addressed,
  a connection presenting an agent identity does not receive it, and
  `interaction_resolved` is not addressed.
- `docs/api/openapi.json` + `docs/api/api/sessions/pending-interactions/get.mdx` — regenerated
  from the route's updated description.
- `contributing/` — no new guide. The rule lives in the two modules' TSDoc, which is where
  the equivalent rules for `caller-authority.ts` and `approver-allowlist.ts` live.
- One changelog fragment in `changelog/unreleased/`, written per `writing-for-humans`:
  what changes for a person is the bridged Approve/Deny and the sentence, not the filter.

## Implementation Phases

**One PR.** The four surfaces read one predicate, and landing the predicate without its
consumers would ship a module nothing calls; landing a consumer without the predicate would
ship a second copy of the policy. Within the PR, this order keeps the tree green at every
commit:

1. `caller-principal.ts` + `ask-entitlement.ts` and their unit tests.
2. The fan-out's principal and audience, both transports, and the fan-out tests. The tree
   is behaviourally unchanged at this point — no event passes an audience yet.
3. Address `interaction_pending`; filter the list route; the conformance test.
4. Export `externalAuthorParts`; `ask-audience.ts`; `ask-card.ts`; the
   `ApprovalAuthorizer` and its wiring.
5. `waitingKind`, `bridgeWaitingText`, the deliverable notice and its suppression.
6. Docs, OpenAPI regeneration, changelog fragment.

## What is not done

- **The direct-bind approval card still lands wherever the bot sits.**
  `approver-allowlist.ts`'s module doc records this already: "anyone who can post in a
  channel the bot sits in was never filtered by it at all, and the approval card lands in
  that channel." This spec neither widens nor narrows it. Applying `bridgedAskIsActionable`'s
  reasoning to the direct-bind path would change shipped behaviour for every operator who
  has one configured, and that needs its own item and its own review.
- **There is still one cockpit person.** `askEntitlement` is written so a second one is a
  change to one function, and `AskSubject.sessionId` is on the type for that reason, but
  nothing here provisions, invites or attributes a second account. Until the invites spec
  exists, `'operator'` means "the one account this install allows".
- **A question or an elicitation is not answerable from a chat platform.** The adapters'
  button path carries a boolean; a question needs free text and an elicitation needs a form.
  Both kinds get the waiting sentence and nothing else.
- **A card nobody presses is left standing in the chat** after the interaction times out.
  The direct-bind path behaves the same way, and fixing one without the other would leave
  two cards behaving differently in the same chat.
- **`interaction_resolved` is unaddressed**, so a client that received a `pending` and then
  lost its entitlement mid-connection — which requires a credential change on a live
  socket, and cannot happen today — would still see the receipt. Recorded because the
  asymmetry is deliberate, not because it is reachable.
- **The `program` principal keeps `see`.** If a future posture stops a per-user API key from
  reading `GET /api/sessions/:id/events`, this line should be revisited in the same change,
  not before.

## Open Questions

None open. Two were considered and are resolved here:

- ~~Should the list route answer `403` to an unentitled caller?~~ **(RESOLVED — default
  chosen: `200` with an empty array.)** A `403` tells a machine that Asks exist. The rooms
  domain already settled the equivalent question the same way: "not a member answers exactly
  as no such room".
- ~~Should the bridged card go to a group chat when at least one approver is in it?~~
  **(RESOLVED — default chosen: no.)** The platform cannot tell us who is reading, so the
  roster under-counts the audience, and a card must carry the action it binds to.

## Related ADRs

- `decisions/260725-133221-approvals-bind-to-the-exact-action-shown.md` — an approval binds
  to the exact action the person saw, which is why the card must carry the detail.
- ADR 260727-184933 D6 — one account owns the install, cited by P3's Known Issue 23.
- ADR-0310 — per-runtime aggregation and degradation, which the list route's envelope keeps.
- Draft ADR `260819-022912` (this spec) — an Ask's detail is addressed, not broadcast.

## References

- `specs/unified-conversation/02-specification.md` §3.1–§3.6
- `specs/unified-conversation/04-implementation.md` P3 Known Issues 22–24, and the
  2026-08-18 post-programme entry (DOR-1357)
- `specs/slack-tool-approval/02-specification.md` — the shipped card, its relay subjects and
  its button payloads
- `packages/relay/src/adapters/approver-allowlist.ts` — DOR-609, "absence is not consent"
- `meta/agent-etiquette.md` §9 — a standard nobody checks is decoration
