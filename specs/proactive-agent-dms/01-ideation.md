# Proactive agent DMs: an agent that reaches you without being spammy

## Problem statement

An agent that finishes a long job, notices something breaking, or hits a wall
has nothing to reach you with unless you happen to be looking at its session.
Two paths exist today and both are narrow:

- **`relay_notify_user`** resolved only external chat bindings (Telegram,
  Slack). On a stock install nobody has connected one, so a notification was a
  **silent no-op** — the agent believed it had told you, and you heard nothing.
  This is point 3 of DOR-793, and slice 1 of DOR-1209 fixed it: with no
  integration bound, the message now lands in the agent's direct message with
  you inside DorkOS (see "What already shipped" below).
- **The task completion notifier** (`services/tasks/task-completion-notifier.ts`)
  resolves through the same external-only resolver, so a scheduled task that
  finishes on a stock install is still silent.

Making delivery work is the easy half. The hard half is the one every product
that has shipped this gets wrong: an agent that **can** reach you will reach you
too often, and the failure mode users complain about is over-participation, not
silence (`meta/agent-etiquette.md`). A notification channel that becomes noise
gets muted once and is then worth nothing — including for the message that
actually mattered.

So this program is not "let agents send DMs". It is **the guardrails that make a
proactive message worth reading**, with delivery as the smallest part.

## What already shipped (slice 1, DOR-1209)

`relay_notify_user` now has a first-party destination:

- An external binding is still first preference, under exactly the rules it had
  (`resolveNotifyTarget`, `canInitiate`, bridge principals).
- When nothing external can carry the message (`NO_BINDING` /
  `NO_ACTIVE_SESSIONS`) **and** the caller did not name a channel, the message is
  posted into the 1:1 DM between the sending agent and the operator —
  `services/relay/notify-dm.ts`, through `RoomService.createRoom`'s DM branch
  (idempotent on the member set) and `RoomService.post`.
- It is a **post by the agent**, not a notice in the room's own voice, and it
  carries no trigger — so `deriveCascade` stamps it at the cascade ceiling and it
  cannot open a fresh reply budget.
- `INITIATE_NOT_ALLOWED` never falls back: routing around a switch a person set
  would be worse than not delivering.
- The tool's reply says `surface: "integration" | "dorkos-dm"`, so the agent's
  next sentence can be true about where the message went.

Everything below is what slice 1 deliberately did **not** do.

## Prior art this steals from

The comparison of DorkOS's room architecture against Block's Buzz and **QM**
lives in `research/20260813_room-architecture-vs-buzz-qm.md` §4 (landing with
PR #1005). That report was not yet in the tree when this was written, so the
guardrails below are written from the program brief; **re-read §4 at SPECIFY and
reconcile** rather than treating this section as settled.

In-repo prior art that already encodes the same instincts, and which this must
compose with rather than duplicate:

- **The welcome-back greeter** (`services/rooms/welcome-back.ts`,
  `specs/team-room-home` D5.2) — the one path that already speaks without being
  asked. Four of its outcomes are deliberately **silent**, and it is bounded by
  a setting, a claim, and the ordinary turn budget.
- **The cascade guard and the turn budget** (`.claude/rules/room-conduct.md`) —
  bounds are mechanisms, never prompts. "Do not be spammy" is not a rule an agent
  can follow, for the same reason "do not get into a loop" is not.
- **E15, E17, E18** in `meta/agent-etiquette.md` — one acknowledgment, batch
  related notices, and a very high bar for claiming attention.

## The five guardrails

### G1. Recurring deliveries need the recipient's consent, once

A one-off message ("the deploy finished") is the agent answering something you
set in motion. A **repeating** one ("your morning digest", "I'll ping you when
this changes") is a standing claim on your attention that you never agreed to,
and it is the shape that turns a channel into noise.

So: the **first** delivery of anything that intends to repeat arrives with an
accept/decline, and **it does not repeat until you accept**. Decline is durable
and per-schedule, not a mute of the agent.

Properties this needs to have:

- The consent is the RECIPIENT's, recorded server-side against the schedule, not
  a promise in a prompt. An agent cannot mark its own digest as consented.
- Consent is per **recurring delivery**, not per agent and not per channel: one
  agent may have a daily digest you want and a "watching the build" ping you do
  not.
- Silence is a decline. A first delivery nobody answered does not repeat.
- Revocation is one action from the message itself, and stops the schedule
  rather than muting the messenger.

Open: what counts as "intends to repeat" — declared by the caller, or inferred
from the schedule that fired it? (See Q1.)

### G2. Silence is the success case for a scheduled fire

When a scheduled agent turn runs and finds nothing worth saying, the correct
outcome is **to end the turn and say nothing**. Not "nothing to report", not a
summary of having looked. The failure mode this prevents is the one that makes
every scheduled agent worthless within a week: an agent that believes a fire
must produce a message will invent work to justify the message.

This is a **prompt-level standard with a mechanical backstop**, in that order:

- The standard belongs in the same place E15 does, and it is stated in the
  agent's own instructions for the fire.
- The backstop is that a scheduled fire's output is not automatically delivered.
  An agent that ends its turn with prose but nothing addressed to the person
  produces no delivery at all. Delivery is an explicit act (`relay_notify_user`
  or its successor), never a side effect of a turn having produced text.
- A fire that says nothing writes nothing user-visible: no digest entry, no
  "checked, all clear" line. The room's own record of a turn that ran is enough
  (`.claude/rules/room-conduct.md`'s "an agent that ran a turn and chose to say
  nothing" is already an accepted silence).

### G3. Quiet hours belong to the delivery layer

Quiet hours implemented as an instruction ("do not message the user at night")
fail exactly the way the cascade guard's own doc describes: each agent sees only
its own turn, and the property is global. They also fail differently per model.

So quiet hours are a **delivery-layer batch**, not a prompt and not a per-agent
setting:

- Every proactive delivery carries an **urgency**. Non-urgent deliveries that
  arrive inside a quiet window are **held and batched**, then delivered as one
  message when the window opens — never dropped, and never delivered as five
  separate messages at 8am.
- Urgent deliveries are not held. What qualifies is a bounded, declared set (see
  G4), not a model's own opinion of its news.
- The window is a person's setting, held once for the install (`~/.dork/config.json`,
  with the timezone question in Q4), not per agent and not per channel — one
  place to set it, one place to reason about it.
- Batching composes with E17: three finished tasks inside one window are one
  message, which is the rule the etiquette standard already asks for and nothing
  currently enforces.

### G4. The escalation ladder, gated by urgency

Not everything deserves the same interruption. Four rungs, quietest first:

| Rung        | What it is                                     | Reaches you             |
| ----------- | ---------------------------------------------- | ----------------------- |
| **Thread**  | A reply under the message it belongs to        | Only if you are reading |
| **Channel** | A post in the room the work belongs to (#team) | On your next look       |
| **DM**      | The agent's 1:1 with you                       | Unread badge, sidebar   |
| **Push**    | An external channel you carry (Telegram/Slack) | On your phone           |

Rules:

- **Default is the quietest rung that can carry the message.** Work that belongs
  to a room stays in that room; the DM is for something that is about YOU rather
  than about the work.
- **A rung is earned by urgency, never chosen for convenience.** Urgency is
  declared at the delivery call and validated against a bounded set — an agent
  that marks everything urgent is a bug we can see, and cap.
- **Escalation is upward and bounded**: one message may escalate at most one rung
  after a no-response interval, and only for the top urgency. It never
  re-delivers the same thing on four surfaces.
- **Push does not exist yet.** There is no web push in this repo; the top rung
  today is an external chat integration, which is exactly the surface slice 1's
  fallback stands in for when it is absent. Treat "push" as a rung the ladder is
  shaped for, not one that ships with it.

### G5. How this composes with Tasks (Pulse) and with `relay_notify_user`

Three existing pieces, and this program is mostly about giving them one seam
rather than three:

- **Tasks / cron** (`services/tasks/`, the scheduler formerly called Pulse) is
  what makes a delivery recurring. G1's consent record and G3's quiet-hours batch
  therefore hang off the SCHEDULE, not off the message: a task that fires daily
  is the recurring thing, and its first delivery is the one that asks.
- **`TaskCompletionNotifier`** is a proactive sender that no agent chose — it
  fires from the run-terminal hook. It resolves through the same
  `resolveNotifyTarget` and is still external-only, so the obvious next slice is
  to give it the same DM fallback slice 1 gave the tool. It also already carries
  a per-binding opt-in (`notifyOnTaskComplete`), which is a narrower ancestor of
  G1's consent and should be reconciled with it rather than left beside it.
- **`relay_notify_user`** is the agent-chosen sender, and after slice 1 it is the
  one path that always has somewhere to go. It is the natural place for the
  urgency argument (G4) and the natural gate for the quiet-hours batch (G3) —
  which argues for the guardrails living in ONE delivery service that both the
  tool and the notifier call, rather than in the tool.

The shape that falls out: a **delivery service** owning consent, urgency, quiet
hours, batching and rung selection; `relay_notify_user` and
`TaskCompletionNotifier` as its two callers; rooms and the relay bus as its two
transports.

## Open questions

- **Q1.** What declares a delivery "recurring"? The caller saying so is
  spoofable-by-omission (an agent that never declares it never asks for consent);
  inferring it from the firing schedule misses an agent that self-schedules with
  its own loop. Is the honest answer "recurring = fired by a Task", with
  agent-initiated repeats simply not possible?
- **Q2.** Is urgency a declared enum, a derived signal, or both? A declared one
  is the only thing an agent can act on, and the only thing an agent can inflate.
  What is the cap — per agent per day, per rung, or a decay?
- **Q3.** Does the consent prompt (G1) belong in the DM itself (an accept/decline
  on the message) or in Settings? The message is where the person is; Settings is
  where a durable list of standing deliveries can be reviewed and revoked. Both
  probably, but which one is authoritative?
- **Q4.** Whose timezone bounds quiet hours, and what happens to a batch held
  across a laptop that was asleep? (`~/.dork/config.json` has no timezone today;
  the scheduler has one.)
- **Q5.** Does a quiet-hours batch survive a server restart? It has to, or the
  guarantee is "held, unless" — which means a durable queue, which is a bigger
  slice than it looks.
- **Q6.** Group DMs and channels: G4's rung table assumes a 1:1 DM. Does a
  delivery ever go to a DM with more than one agent in it, and if so who is it
  from?
- **Q7.** Reconciling `notifyOnTaskComplete` (per-binding, defaults ON) with G1
  (per-schedule, defaults OFF until accepted). Two consent models cannot both be
  the answer; the migration is a real question, not a detail.
- **Q8.** What does the cockpit show for a delivery that is HELD by quiet hours?
  A held message that is invisible until 8am is indistinguishable from a lost
  one, which is the failure `.claude/rules/room-conduct.md` calls a refusal
  nobody was told about.
- **Q9.** Slice 1 **un-archives** a DM the person had tidied away, because
  `createRoom`'s DM branch revives whatever it matched and a message that reaches
  nobody is the worse failure. Once G1 and G3 exist, should a declined delivery
  or a quiet window suppress the un-archive — or is archiving a DM already an
  implicit "not now" that consent should read? (Named in
  `services/relay/notify-dm.ts` as accepted behavior until this is answered.)

## Suggested approach (phasing)

1. **Delivery seam.** One service both senders call, with urgency on the call.
   No behavior change yet — the point is that there is one place to add it.
2. **`TaskCompletionNotifier` gets the DM fallback** slice 1 gave the tool, so a
   scheduled task on a stock install stops being silent (the smallest piece with
   real user value).
3. **Quiet hours + batching** at that seam (G3), durable queue included.
4. **Consent for recurring deliveries** (G1), reconciled with
   `notifyOnTaskComplete` (Q7).
5. **The ladder** (G4) — rung selection and bounded escalation.
6. **Silence-as-success** (G2) belongs with whatever ships scheduled agent turns;
   the standard is cheap, the backstop (delivery is never a side effect of a
   turn) is the part that needs to be true before 1–5 are worth anything.

**Effort:** significant. It crosses tasks, relay, rooms and config; it needs a
durable queue and a consent record; and every one of the five guardrails is a
mechanism rather than a prompt, which is the whole reason the program exists.
