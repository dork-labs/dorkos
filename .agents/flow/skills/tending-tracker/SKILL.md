---
name: tending-tracker
description: The /flow engine's agent-as-team-member loop — the agent participates in a shared tracker like a teammate. Each tick it polls its inbox (assigned-to-me + @mentions + new comments), decides respond/act/ignore per the five comment-response rules, claims work with durable agent/* labels, asks the human via comment+assign when genuinely stuck (soft-escalation), and writes answers back as durable memory so the same question is never asked twice. Use when the agent is operating continuously inside a shared tracker. PM-agnostic; all tracker I/O routes through the linear-adapter skill.
---

# Tending the Tracker — the agent-as-team-member loop

> **What this is.** The behaviors that let the `/flow` agent operate inside a
> **shared** tracker the way a good teammate does (spec §5, §7; Phase 3
> acceptance): watch its inbox, speak only when it should, claim work durably,
> ask when stuck, and remember the answers. It is the inbound-comms counterpart
> to the stage skills — they advance one item through the pipeline; this skill
> keeps the agent a well-behaved participant in a board it shares with humans and
> other agents.
>
> **This is a prose contract the agent follows.** It composes already-built
> pieces: the `linear-adapter` verbs (the only place that touches a tracker) and
> three pinned TypeScript oracles in `packages/flow/src/` — `classifyOwnership`
> (`identity.ts`), `shouldRespondToComment` (`comment-response.ts`), and
> `resolveInvolvement` (`calibration.ts`). The agent reasons in the agent layer;
> the oracles are the tested source of truth for _what_ the rules decide.

## The one tracker rule

This is a generic skill. **It never touches a tracker API string.** Every
inbox read, comment, claim, label change, assignment, and link goes through the
**`linear-adapter`** skill by naming its verbs (`getInbox`, `claim`, `comment`,
`assignToHuman`, `needsInput`, `transition`, `link`). No raw tracker tool name,
CLI invocation, or slug lives here — the `tracker-confinement` Vitest guard
enforces this for the whole flow bundle.

## The team-member tick

Run this on each inbox poll. It is a loop, not a one-shot stage:

1. **Poll the inbox** — via the adapter, `getInbox(agent)`.
2. **For each entry, decide respond / act / ignore** — the five comment-response
   rules, driven by `classifyOwnership`.
3. **Act on what you own** — claim eligible work with a durable label, advance it
   through the stage skills, or resume a parked item.
4. **When genuinely stuck, hand off** — soft-escalation: stop, comment, assign to
   the human, park.
5. **When you get an answer, remember it** — write the resolution where the next
   decision's evidence test will find it, so the question is never re-asked.

---

### 1. Poll the inbox — `getInbox(agent)`

Via the adapter, `getInbox(agent)` returns everything the agent must look at this
tick: **assigned-to-me + @mentions + new comments since the last tick**. Each
entry carries the triggering comment so the rules below can decide:

```
InboxEntry {
  item,                       // the WorkItem the comment is on
  comment: { author, mentions[], body },
}
```

Track the last-tick watermark so "new comments since the last tick" stays
gap-free across restarts — the watermark is a durable cursor, not in-memory
state. The adapter owns the tracker-native query; this skill only names the verb.

### 2. Decide respond / act / ignore — the five rules

For each inbox entry, classify the item's ownership, then walk the five
comment-response rules **in precedence order** (first match wins). The pinned
oracle is `shouldRespondToComment` in `comment-response.ts`, consuming the
`OwnershipClass` from `classifyOwnership` (`identity.ts`) — this skill is the
prose the agent reads; that module is the tested truth.

First, classify ownership (`classifyOwnership(item, identity)` → `mine` /
`reviewer` / `other` / `unassigned`), comparing the item's `assignee` (or, for a
project, its `lead`) against the **resolved** `identity.agent` / `identity.reviewer`.
In **shared-account** mode (no distinct reviewer account) the agent acts _as_ the
human, so a self-assignment is still `mine` — the agent recognizes its own
authorship by `identity.marker`, not by account.

Then the rules:

1. **Never answer its own comments.** `author == identity.agent`, **or** the body
   carries `identity.marker` (`— 🤖 /flow`). In shared-account mode the marker is
   the _only_ signal — author alone can't tell agent from human. Highest
   precedence: it breaks self-reply loops before any other rule fires. → **ignore**.
2. **Always respond when directly addressed.** An @mention of the agent account,
   or (shared mode) an explicit `/flow` / `@flow` token in the body. **Overrides
   ownership** — respond even on a teammate's (`other`-owned) thread. → **respond**.
3. **Resume a parked `agent/needs-input` item on a non-agent comment.** Rule 1
   already excluded the agent's own writes, so a non-agent comment on a parked
   item _is_ the answer the agent stopped for via `needsInput`. → **resume** the
   run (un-park and continue — distinct from merely posting a reply).
4. **Stay out of `other`-owned threads unless mentioned.** Rule 2 already handled
   the mention case; an `other`-owned thread with no address is a teammate's
   conversation. → **ignore**.
5. **Soft zone leans quiet.** Everything left — the agent's own / `unassigned` /
   `reviewer` threads, not addressed, not parked — is the ambiguous middle. With
   `comments.ambiguousBias: "quiet"` (the default) silence is the safe default;
   `"engage"` flips it to respond. **Over-responding is the worse failure** (a
   chatty bot on every thread), so quiet ships as the default. → **ignore** unless
   `engage`.

`comments.respondWhen: "addressed"` and `comments.ambiguousBias: "quiet"` are the
§9 defaults; re-tuning chattiness is a config edit, never a code change.

### 3. Act on what you own — durable label claims

When the tick surfaces eligible, unclaimed work the agent should pick up:

- Via the adapter, **`claim(item)`** — writes the `agent/claimed` **label** AND
  moves the item into a `started`-category state, in that order, so the claim
  **survives a restart**. The **state machine is the `agent/*` labels**, never the
  ephemeral plan/checklist field (the Huginn durability lesson, spec §3). After a
  crash, any `agent/claimed` + `started` + not-`agent/needs-input` item is
  recoverable as the agent's orphaned work.
- **Shared-account caveat:** in shared mode a `mine`-classified item is the
  agent's _own work to act on_ only when it **also** carries the `agent/claimed`
  label — the assignee alone is ambiguous because agent and human share the
  account. `classifyOwnership` reports raw ownership; this label gate lives in the
  claim step (see `SHARED_MODE_CLAIM_LABEL` in `identity.ts`).
- Claim **only permitted classes** — never silently take over a teammate's
  (`other`-owned) item. Then hand the claimed item to the right stage skill to
  advance it, or **resume** a rule-3 item where it parked.

### 4. Comment, assign, and hand off

The agent's outbound moves on the board, all via the adapter:

- **`comment(item, body)`** — post a comment. The agent's own comments **always
  carry `identity.marker`** so rule 1 can recognize them next tick (essential in
  shared mode).
- **`assignToHuman(item)`** — set the assignee to the reviewer / authenticated
  human (fires a tracker notification). Used at handoff and the review gate.
- **`needsInput(item, question)`** — the **elicitation primitive**, four atomic
  effects in order: (1) post the question as a `comment` (multiple-choice when
  possible, carrying the marker); (2) apply the `agent/needs-input` label;
  (3) `assignToHuman`; (4) **stop** — the loop parks here. "Parked on a human" is
  a distinct, durable state the stall sweep must never reclaim; it resumes **only**
  on a non-agent reply, surfaced by `getInbox` and matched by rule 3.

### 5. Soft-escalation — stop, comment, assign when stuck

**Any time the agent is genuinely stuck, it stops, comments, and assigns to the
human** (spec Decision #2a) rather than guessing. This is not stage-gated — it is
**uncertainty-gated**, driven by the calibration ladder (pinned in
`resolveInvolvement`, `calibration.ts`):

- Walk the ladder for the decision at hand. A `stop-and-ask` outcome (the floor —
  irreversible / outward-facing / secrets-or-spend / scope-change — or sticky +
  not-confident, or the ambiguous middle routed to `ask`) is exactly the
  soft-escalation trigger: call **`needsInput`** with a crisp, preferably
  multiple-choice question, then park.
- A `proceed-with-trail` outcome means proceed on the best default and leave a
  durable `agent/assumption` trail (auditable at the review gate); `proceed-silently`
  means just act. Escalate on the first matching `stop-and-ask` row — don't burn a
  human interrupt on a decision the ladder says to proceed on.
- Frame every handoff as a real question with options, not "I'm stuck." Honest by
  design: tell the human exactly what's blocked and what you'd do absent an answer.
  When you surface the item to the human in a live session (an `AskUserQuestion`,
  not the parked tracker comment), name it as identifier with title
  (`DOR-157 - Title`, per the linear-adapter display convention).

### 6. Answers become memory

When a human answers — a rule-3 resume, or any decision the human resolves —
**write the resolution where the next decision's evidence test will find it, so
the same question is never asked twice**:

- A reusable decision → the **decisions table / an ADR** (`/adr:create`,
  `decisions/`).
- A durable preference or threshold → **`config.json`** (the engine's config).
- A point answer scoped to one item → back onto the **item** via the adapter's
  `comment` (carrying the marker), plus the relevant label change.

The adapter writes the _tracker_ side (the comment + label); the **durable answer
lives in the repo artifact**, not in a separate store — the filesystem stays
canonical, the tracker holds pointers + state + conversation. On the next tick the
agent's evidence test reads the artifact and proceeds `confident` instead of
re-parking.

---

## Guardrails

- **Over-responding is the worse failure.** When unsure whether to speak, stay
  quiet (rule 5 default). A teammate who chimes in on every thread is noise.
- **Never claim a teammate's (`other`-owned) work.** Claim only permitted classes;
  use `link` only for genuinely typed relations, never to annex an item.
- **The state machine is the `agent/*` labels**, not the plan field — every claim,
  park, and completion is a durable label written via the adapter so it survives a
  restart.
- **Recognize your own writes by the marker**, especially in shared-account mode —
  a missing marker on the agent's own comment can trigger a self-reply or
  self-resume loop.
- **All tracker I/O through `linear-adapter`.** No tracker strings in this skill.
  If the tracker is unavailable, explain the limitation clearly rather than
  guessing or fabricating inbox state.
- **Live dry run is a human step.** Validating this loop against a real shared
  tracker (read-only first) is a manual human verification — this skill never
  performs unattended live writes during that validation.
