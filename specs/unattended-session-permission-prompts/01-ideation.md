---
slug: unattended-session-permission-prompts
number: 260911-191243
created: 2026-09-11
status: ideation
---

# Sessions with nobody to answer

**Slug:** unattended-session-permission-prompts
**Date:** 2026-09-11
**Source:** `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/` — filed there as a product question rather than an adoption

---

## Problem statement

A task runs at three in the morning. Partway through, the agent needs permission
for something. There is nobody awake to say yes, so the agent waits ten minutes,
then refuses itself and writes "waited 10m 0s" into its own transcript. The rest
of the run is built on top of a refusal nobody made.

You find out in the morning, from a run that half-finished. The ten minutes are
pure loss: they buy a chance that somebody answers, on a surface where the whole
point is that nobody is there. Meanwhile the session held a slot the whole time
(a parked session declines reclaim, and there are twelve slots on the machine),
so one abandoned prompt at 3am can crowd out an agent somebody actually launches.

DorkOS already knows about this problem and has solved half of it. A session the
scheduler starts carries an `unattended` flag, and an unattended prompt is
refused at ten minutes instead of parking for four hours
(`messaging/interaction-wait.ts`, spec `ask-parks-on-timeout` §7). What it still
does is **wait first**, because waiting was the only tool available. And the flag
is set in exactly one place: the task scheduler. A room turn is never marked
unattended, even though ADR `260908-170643` says in so many words that a room is
the surface with nobody watching and no control of its own.

So today there are two gaps: agents burn ten minutes waiting for an answer that
cannot arrive, and the one surface most exposed to it is not even labelled.

## What the SDK now offers

`@anthropic-ai/claude-agent-sdk` 0.3.259 adds an option:

- `permissionPrompts?: 'host' | 'none'` — `'none'` auto-denies permission prompts
  in a session with nobody to answer them, **without** disabling auto mode's
  classifier. Auto mode goes on allowing everything it would have allowed on its
  own; what disappears is the part where a question is asked of an empty room.

Changelog entry: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`,
Features → "Options", item 10. Impact assessment: same directory,
`impact-assessment.md`, "MEDIUM — `permissionPrompts: 'none'`".

Two facts about where it would sit in DorkOS, because they bound the whole design:

- The option governs the runtime's own permission prompts — the ones that reach
  `canUseTool` in `messaging/interactive-handlers.ts`. DorkOS's own capability
  approvals for its tools run through a different path (`core/mcp-tool-gate.ts`),
  and a late verdict on one of those now wakes the session that asked
  (ADR `260909-123910`). Which of the two a given ask travels on has to be
  confirmed at execution, not assumed.
- The session flag already exists (`unattended` on the session record), so this is
  mostly a question about **who gets the flag**, not about new plumbing.

## Users

- **Kai** (`meta/personas/the-autonomous-builder.md`) — runs scheduled work
  overnight and judges the product by what the morning looks like. A run that
  stopped for a reason he can read beats a run that idled and then quietly
  denied itself.
- **Ikechi** (`meta/personas/the-ai-native-founder.md`) — talks to his agents in
  rooms. He has no idea a permission prompt exists; he sees an agent that went
  quiet. ADR `260908-170643` was written after exactly this report.
- **Priya** (`meta/personas/the-knowledge-architect.md`) — cares that "denied"
  is recorded as denied, and that nothing was skipped without a trace.

## Options

### Option 1 — Declare it everywhere DorkOS already knows nobody is watching

Set `permissionPrompts: 'none'` on every session carrying the `unattended` flag,
and extend the flag to the surfaces that qualify but never got it — room turns
first.

- **For:** honest and fast. The prompt is refused at the moment it is raised,
  the ten dead minutes disappear, the slot is freed, and auto mode keeps deciding
  everything it can decide. It also says out loud what the product already
  believes: an unattended surface runs at the operator's level, and where that
  level still asks, asking is a dead end.
- **Against:** it removes the small chance that a person was in fact watching the
  activity feed and could have answered. On the relay path that chance is not
  small — `interaction-wait.ts` records a deliberate decision that a relay-bound
  turn is _not_ unattended precisely because its prompt is answerable from chat
  (DOR-1440).
- **Effort:** small for the option itself; moderate for deciding and wiring which
  surfaces get the flag.

### Option 2 — Keep waiting, and make the wait pay

Leave prompts alive on unattended surfaces, but route them somewhere a person
actually is (a notification, the DM the operator shares with the agent), so the
wait is a real chance rather than a formality.

- **For:** nothing is lost that could have been saved; a late answer still lands,
  which is the machinery ADR `260909-123910` just built.
- **Against:** does not solve the 3am case at all, and turns every unattended
  prompt into a push notification. That is over-participation moved from the
  session into the person's phone.
- **Effort:** moderate to large, and most of it is notification policy.

### Option 3 — Split by whether the ask can reach anyone

Use `'none'` only where the prompt has no destination: a scheduled run, and a
room turn whose ask reaches no answerable surface. Keep today's wait wherever the
ask is published somewhere a person can answer it — the relay paths that already
publish an approval to their reply address, and the DorkOS capability approvals
that can now be answered hours later.

- **For:** matches the rule the codebase already wrote down: the question is not
  "is a human present" but "can anybody answer this". It keeps the late-verdict
  path intact instead of silently pre-empting it.
- **Against:** two behaviors instead of one, and a rule someone has to maintain
  as new surfaces appear. A surface added later gets the wrong default unless it
  is classified on purpose.
- **Effort:** moderate. The classification is the work; the option is a line.

## Recommendation

**Option 3**, with Option 1's extension of the flag to rooms folded in.

The deciding argument is that DorkOS has, in the last month, built the ability
for an answer to arrive late and still matter. Turning every unattended prompt
into an instant denial would throw that away on surfaces where it works.
Answering instantly is right exactly where the ask is a dead letter — and that
set is knowable, not guessed: the scheduler's runs, and room turns whose ask
reaches no answerable surface.

The second half of the recommendation is what the person sees afterwards. An
instant denial is only an improvement if the run says so: "asked to run X,
nobody was there to approve it, so it stopped" is a result. A silent denial
buried in a transcript is the same failure in less time.

## Open decisions

1. Which surfaces carry the unattended flag — scheduler only (today), plus rooms,
   plus relay-triggered turns?
2. Should a room turn triggered by a message from off this machine (a bridged
   Telegram or Slack sender) be treated differently from one a local agent raised?
3. Does an operator who accepted full power get a different answer here than one
   who declined, or is this independent of the trust level?
4. When a prompt is auto-denied, where is that reported — the run's result, a
   notification, the activity feed, or all three?
5. Does the ten-minute wait stay for anything, or does the flag now mean "refuse
   immediately" everywhere it is set?
6. Should an unattended run that hits a denial stop, or keep going with the tool
   refused (today's behavior)?
7. Do DorkOS's own capability approvals stay on today's path with their late
   verdict, while only runtime prompts go to `'none'`?
8. Is there a per-task or per-room override, or is the rule global?

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` — the version bump, PR **#1798**. The
  option does not exist below 0.3.259.
- ADR `260822-235759` (full power by default is consent-led), ADR `260822-235802`
  and ADR `260908-170643` (unattended surfaces follow the operator's level) —
  nothing here may re-open those; this decides what happens when a surface at the
  operator's level still hits a question.
- ADR `260909-123910` (a late approval verdict wakes the session that asked) — the
  reason Option 1 is not simply better than Option 3.

## Out of scope

- Changing which actions need permission at all. That is the trust ladder, and it
  is settled.
- The permission mode an unattended surface runs in. Also settled, by the two ADRs
  above.
- Notification routing and phone delivery.
- Codex and OpenCode. The option belongs to one runtime; the classification of
  which surfaces are unattended is shared and should be written so it can be
  reused, but nothing else crosses.

## Risks

- **An instant denial can read as a broken agent.** The failure it replaces is
  slow and confusing; the one it introduces is fast and confusing. Everything
  depends on the sentence the person reads afterwards.
- **Pre-empting an answer that was coming.** If a surface is misclassified as
  unreachable, a person who would have approved from their phone loses the
  chance, and nothing tells them it happened.
- **Two rules drifting.** A new unattended surface added next quarter inherits
  whichever default nobody thought about — the exact way rooms were left out of
  ADR `260822-235802`'s enumeration in the first place.
- **The classifier is still deciding.** `'none'` does not make auto mode stricter;
  a run at full power will simply do more without asking. That is the intent, and
  it is also the thing to state plainly rather than let people discover.
