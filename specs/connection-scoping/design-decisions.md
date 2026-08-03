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
