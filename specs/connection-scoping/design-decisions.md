# Connection Scoping Backend — Design Decisions

Companion to `02-specification.md`. Named `design-decisions.md`, not
`04-*.md` — a `04-*` filename auto-promotes the spec's manifest status to
"implemented," which is premature while this document is being written
alongside the code (see `spec-design-decisions-naming` memory).

## D1 — Persistence home: SQLite, not `~/.dork/config.json`, not a new file

Three candidates: (a) fold into `conf`-backed `config.json`, (b) a new
per-connector JSON file (relay's `bindings.json` pattern), (c) SQLite tables
alongside `connected_accounts`.

Chose (c). Reasons:

- `connected_accounts` already lives in SQLite as the derived routing cache
  for exactly this domain — a sibling table is the path of least surprise,
  not a new convention.
- `config.json` is for global preferences a person edits via Settings, keyed
  by a fixed Zod schema (`adding-config-fields` skill). Agent×account and
  session×account rows are open-ended relational data (grows without bound,
  keyed by two foreign ids), which is what a table is for and a config
  object is not.
- A new JSON file (`bindings.json`-style) was rejected specifically because
  session-level rows churn far more than adapter bindings ever do (every
  session attach/detach writes), and file-watcher-based hot reload
  (`BindingStore`'s chokidar dance) buys nothing here — there is no
  multi-process external editor to detect.

## D2 — Ladder semantics: session fully overrides per-account, never merges fields

Considered: (a) session ∪ agent (session can only ADD, never suppress), (b)
session fully replaces agent's WHOLE set (attach one account at session
level and you lose every other agent-level account too), (c) per-account
override (chosen).

(a) fails the spec's explicit ask — "session-level attach/detach remains as
override" implies detach must be able to suppress an inherited exposure, not
just add. (b) is what "MCP ladder" sounds like if read carelessly, but the
actual Claude Code MCP ladder overrides per SERVER NAME, not per scope
wholesale — a project `.mcp.json` entry for `foo` overrides the user-level
`foo`, but a user-level `bar` with no project entry still applies. That is
(c): per-account (the DorkOS analogue of "per server name"), and it is the
one interpretation that makes "no merge" a meaningful sentence about a single
account's state rather than a confusing all-or-nothing session behavior.

## D3 — Uniqueness scope excludes `channelType`

`(adapterId, chatId)` alone, not `(adapterId, chatId, channelType)` and not
`(adapterId, channelType)` for wildcards. A concrete `chatId` already
identifies one real conversation; a second binding on the same `chatId` that
only differs by `channelType` is not "the same chat scoped differently," it
is the exact duplicate-specificity tie the audit found (`binding-store.ts`
scoring: two bindings both matching `chatId` score identically at tier 5 or
7 regardless of `channelType` agreement, since `channelType` only adds to an
ALREADY-`chatId`-matched score). Widening uniqueness to include
`channelType` would not close that hole — the tie is on `chatId` — and would
narrow it to falsely permit the exact bug being fixed (two bindings, same
chat, differing only by an unrelated field). Wildcard bindings (no `chatId`)
are legitimately differentiated by `channelType` (a DM-wide policy vs a
group-wide policy) and are out of scope for "one chat, one agent" because
they are not a chat.

## D3-addendum — legacy load-time collisions are disabled in place, never deleted (adversarial review finding)

The first cut of `dedupeChatCollisions` kept the oldest binding for a
colliding `(adapterId, chatId)` and **deleted** every other one on load. That
was wrong on two axes review caught: main deliberately supports two bindings
on one `chatId` differentiated by `channelType` (proven by the ORIGINAL test
this method's first version deleted — `'prefers chatId+channelType over
chatId alone'`, which asserted `resolve('tg','123','dm')` and
`resolve('tg','123','group')` returned two DIFFERENT bindings), and deleting
on load is irreversible the moment the reconciled file is saved — a person's
real configuration disappearing on an upgrade with no recovery path.

The fix keeps D3's routing invariant (one ENABLED binding answers a chat)
without destroying data: the oldest colliding row keeps `enabled` untouched;
every other colliding row is set `enabled: false` **in place** — `id`,
`agentId`, `label`, `channelType`, everything else, unchanged — and the full
pre-disable row is also written to a `bindings.discarded-<timestamp>.json`
sidecar before the reconciled file saves, so the exact bytes are recoverable
even without reading `enabled` history out of the live file. `resolve()`
already filters `enabled` (D5), so routing is unambiguous immediately; a
disabled row can still be inspected, re-enabled, or moved by a person the
same way any other paused binding can.

The superseded delete-based test does not exist in this branch's history as
a separate regression case; its replacement,
`'AC2.6 (revised — see design-decisions.md D3-addendum) …'` in
`binding-store.test.ts`, pins BOTH properties explicitly: both rows survive
`getAll()`, only the loser's `enabled` changed, and the sidecar file exists
with the loser's untouched bytes.

## D4 — Move is a dedicated endpoint targeting the existing binding, not a `force` flag on create

A `force: true` flag on `POST /bindings` would create a SECOND binding row
and orphan the first (or silently delete-then-recreate, losing the row's
`id` and therefore its session-map entries and its `createdAt`). "Move"
should be boringly literal: the SAME binding, re-pointed. That only works as
an operation on the existing row's id, which a `force` flag on a create
request does not have access to (the conflicting binding's id is only known
from the 409 body). `POST /bindings/:id/move` takes that id directly.

## D5 — `resolve()` filters `enabled`, but the paused-notice UX is preserved via a second method, not lost

The audit fact is literally "`resolve()` doesn't filter enabled." The naive
fix (filter unconditionally, return `undefined` on an all-disabled
candidate set) would turn "your chat is paused" (an explicit, told refusal —
the entire point of DOR-789) into a silent `no_binding` drop, which is a
regression against a named, deliberate invariant elsewhere in this codebase.
`resolveIncludingDisabled()` as a second, narrow-purpose method (only called
by the router's fallback, never by `testBinding` or anything else that
should stay enabled-only) keeps both properties true: an enabled wildcard is
no longer blockable by an unrelated disabled specific binding (the actual
audited bug), and a chat whose only binding is paused still hears "paused,"
not silence.

## D6 — Claim feed never stores or forwards message text, structurally

The table schema has no body/text column. The router's claim-feed call site
is fed a struct built from `parseHumanSubject` (adapter/chat/channelType,
already subject-derived, no body) and a narrow `platformData` identity
parser — the SAME parser shape `extractPlatformUserId` already uses for
`per-user` session keys, extended with a display-name field. It is never
handed `envelope.payload` itself. This is enforced by the call site's
signature, not by a runtime check, which is why AC3.3 greps the actual
persisted row and broadcast payload for a sentinel rather than asserting a
type — a signature can be widened later without the compiler noticing;
concrete captured bytes are what the test protects.

## D7 — Agent-level revocation does not force-refresh already-hydrated live sessions

Deleting an agent-level attachment removes future standing consent
(new/rehydrating sessions never get it) but does not reach into an
ALREADY-hydrated session's in-memory cache and strip the tool mid-flight.
This mirrors `invalidateProvider`'s existing behavior for a provider going
away — consent revocation there also doesn't retroactively edit a live
session's already-resolved cache entries beyond nulling the connection
(which the running session would only notice on its next factory call,
i.e. next turn) — and is the more conservative choice: yanking a tool a
session is mid-turn with is a stranger failure mode than "detach takes
effect from the next turn/session." **Account disconnect is different and
DOES cascade live** (spec §Part 1 Revocation) because a disconnected account
means the credential itself is gone — continuing to serve tool calls with a
dead credential is not a grace period, it is a guaranteed error surfaced
later instead of now.

## D8 — DOR-749 is superseded, not paralleled

DOR-749 asked for session-level connector attachments to survive a restart.
Building that in isolation from the agent-level ladder would have meant two
migrations touching the same conceptual data (session×account intent) months
apart, and the ladder literally cannot be correct without session-level
persistence anyway (precedence needs both sides durable to mean anything
after a restart). `session_connector_attachments` ships as part of this
spec; DOR-749 is closed as done-via-DOR-856 per the ticket's explicit
instruction, not implemented a second time.

## D9 — `hydrateSession` retries a failed account on the NEXT turn, never the same one (adversarial review MAJOR 2)

A provider's `toolServerForAccount` is third-party HTTP inside the turn path
— it can genuinely reject. Two failure modes were both wrong: letting the
rejection propagate would fail the whole turn over a connector tool nobody
asked about this message; catching it but still marking `_hydrated` would
strand that account unexposed for the rest of the process (no code path ever
clears the flag otherwise). The fix makes both failure modes structurally
unreachable: each account resolves inside its own try/catch (log, continue —
one bad account never blocks its siblings), and `_hydrated` is only set after
a pass where every account resolved without throwing. A partial failure
keeps the session eligible to retry on its very next turn. `ClaudeCodeRuntime`
ALSO wraps its own call to `hydrateSession` (belt and suspenders) — connector
tools are additive to a turn, never load-bearing for it, and that property
should hold even if a future change to the service breaks the never-throws
contract this decision establishes.

## D10 — A session rekey must move persisted state, not just the in-memory cache (adversarial review MAJOR 3)

`SessionConnectorService.migrateSession` already moved the live `_sessions`
cache across the claude-code canonical-id remap (a brand-new session's id
changes mid-first-turn). What it did NOT move: the PERSISTED
`session_connector_attachments` override rows, or `_hydrated` set membership.
Both are consent state, and both silently regressing is worse than the
original stranding bug `migrateSession` was written to fix — a `'detached'`
tombstone written under the pre-remap id would be invisible to
`hydrateSession(newId, …)`, quietly un-suppressing an account someone
explicitly turned off. `SessionConnectorAttachmentStore.rekey` moves override
rows per-account (not a bulk `UPDATE`) because the new id may already carry
its own override for the same account — that conflict resolves "new id
wins," mirroring the projector rekey's existing "active wins" convention,
rather than violating the `(sessionId, accountId)` primary key.

## D11 — Blocked-chat check moved after the paused-binding fallback, not before resolve() (adversarial review MAJOR 5)

The first cut checked `isBlocked` before `resolve()` — reasoning "block
should win outright." Review found the actual consequence: a chat blocked
once, then later given a real, manually-created, enabled binding (someone
decided to let this stranger in after all) would keep silently dropping
forever, because the block check never let the router get far enough to see
the new binding. `resolve()` (and its paused-binding fallback) now runs
FIRST; `isBlocked` is only consulted inside the "truly nothing claims this
chat" branch — a real binding always outranks a stale block, matching what
the spec's own step ordering already said (§Part 3 step 1: "isBlocked(...) →
true" is listed as the first thing the NO-BINDING branch does, not the first
thing `handleInbound` does). This also removes a per-message SQLite read for
every ordinarily-bound chat, which the original ordering paid on every
single inbound message regardless of whether it would ever matter.

## D12 — Two independent caps for the claim feed, not one (adversarial review MAJOR 4)

A publicly-discoverable bot means the claim feed is reachable by anyone who
can message it. Per-chat damping (`UnclaimedChatStore.recordSighting`, D6's
neighbor) already bounds repeat messages from the SAME chat to one row and
one broadcast — but it does nothing against a burst of MANY DIFFERENT chats,
which is the shape a real spam wave takes. Two separate mechanisms, because
they bound two separate resources: `MAX_PENDING_CHATS` (200, oldest-evicted)
bounds the TABLE — unbounded storage growth; the router's
`admitUnclaimedBroadcast` rate limit (20/minute, one summary event beyond
that) bounds the BROADCAST — an SSE flood to every connected client. A chat
past the broadcast cap is still recorded (the table cap is independent and
much higher), just not individually announced — the summary event says a
burst happened without claiming to enumerate it.

## D13 — chatTitle: yes, it was cheap (adversarial review MINOR 12)

The ticket asked whether Telegram inbound carries a chat title/group name
cheaply enough to capture. It does, and DorkOS was already computing it: both
Telegram (`extractChannelName(chat)` reading `chat.title`) and Slack
(`resolveChannelName`) already put a group/channel display name at the
TOP LEVEL of `StandardPayload.channelName` for the message's own routing
metadata — the exact same field shape `senderName` already reads from. No
new platform lookup, no new field on the wire; `chatTitle` on
`unclaimed_chats` just reads the field that was already there. Nullable for a
DM (no title exists) and truncated to 200 chars alongside `senderName` (D
below) since it is equally stranger-controlled.

## D14 — senderName/chatTitle length cap (adversarial review MINOR 11)

Both are stranger-controlled strings (a Telegram/Slack display name or group
title, set by whoever is on the other end) flowing untouched from an inbound
payload into a durable row. The repo already treats stranger-controlled
display strings as worth bounding elsewhere; an unclaimed-chat row is no
different. Truncated at 200 chars, not rejected — a claim card showing a
clipped name is still useful, and refusing to record the sighting over an
oversized display string would be a worse outcome than a clipped one.
