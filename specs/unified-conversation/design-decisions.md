# Design Decisions — unified-conversation

Visual companion session: `specs/unified-conversation/design/` — one screen, `01-messaging-exploration.html`, in three parts (component tree · approvals · the working line). Clicks recorded in `design/picks.jsonl` (four choices, 2026-08-17). Rationale table: `01-ideation.md` §6. This file is the design record an implementer builds from; the **Final Design Summary** at the end is written so nobody has to open the HTML.

Two of the four picks went **against** my recommendation. Both are recorded below with the reason the operator's choice wins, because a spec that quietly adopts the operator's pick and keeps my rationale is how a design drifts back.

---

## 1. How much of the component tree we unify

**Screen:** part 1 — the audit ("nine duplicates; the seam is already there"), the proposed `Conversation` compound drawn as a box tree, and the four-step sequence.

**What the audit found:** DMs are already rooms (same route, same widget; `kind: 'dm'` changes only the name). So it is **two** implementations to merge, not three. The two already share the composer primitives (`Composer.*`), the row layout tokens (`messageItem` `tailwind-variants`, with `anchor: corner | rail`), the grouping math (`buildTimelineRows`) and the a11y feed — and duplicate the row, the list, the composer host, hover actions, markdown, scroll-pinning, and the "busy" and "waiting on you" vocabularies.

**Options:**

- **A) Row + live lane first, then list, then composer host.** Ship the visible wins (parts 2 and 3) on a shared foundation early. **My recommendation.**
- **B) Whole tree in one programme.** One PR train, everything lands together. Cleaner end state, longer before anything is felt.
- **C) Live lane only.** Fastest, least clean; leaves rows and lists forked.

**Chosen: B** (`unify-B`).

**Why B wins over my A:** A and B differ only in whether the programme is allowed to stop halfway. A's honest end state, if priorities move, is a tree with a shared row and a shared lane sitting on two lists and two composer hosts — which is where the codebase already is, one layer up. The repo's standing rule is "no half-finished migrations, no tolerated legacy patterns" (`AGENTS.md`), and B is that rule applied to a refactor big enough to tempt an exception. The cost B pays — nothing is felt until P2 — is bought back by keeping A's _sequence_ inside B: the spec's PR train is row → lane → timeline/Ask → composer host, so each PR is reviewable and shippable to `main` on its own. B is the scope; A is the order.

---

## 2. Where the Ask lives

**Screen:** part 2 — the dead-line problem, then the one card, then three ambition tiers (each includes the ones before it), then six edge cases.

**The problem, stated on the screen:** the room shows _"Meeting Notes is waiting for you to approve something… Open Meeting Notes's session to answer."_ You go hunting. Ten minutes later it auto-denies and the agent guesses.

**Two findings from the code that changed the plan, both recorded on the screen:**

1. DorkOS already has a global approvals queue — the header pill plus `ApprovalCard` / `ApprovalList` — but it carries only **capability** approvals (a two-hour window). The SDK "may I read / write / run" prompts (a ten-minute window) are session-only. Two systems, one meaning.
2. The room notice deliberately hides the file path and the command, because a shared room may hold people who should not see one member's approval decisions.

So: **the Ask becomes one object, and detail shows only to whoever can answer it.**

**Options:**

- **A) Inline, in the room where the agent is talking.** The Ask appears live in the room's live lane the moment it is raised; the durable late notice stays for the log. Answer there; it collapses to a one-line receipt.
- **B) A, plus one global "Needs you" tray** built by extending the queue that already exists: header pill, sidebar _Heads up_ row, home triage header, one card. Answer from any route. `⌘⇧A` jumps to the next Ask. Server side this is one honest change: broadcast the pending prompt on the global stream, plus a list-on-mount endpoint — the exact pattern capability approvals already use. **My recommendation.**
- **C) B, plus reach you off-screen and change what a timeout means.** Desktop / Telegram / Slack notifications with Allow and Deny actions; on timeout the agent **parks** instead of auto-denying and guessing; scope options ("don't ask again for this file / folder / this agent in this room").

**Chosen: B** (`ask-B`). C is the named follow-on and is out of scope here (`01-ideation.md` §1, §6 #13).

**Why B and not C now:** C's park-instead-of-deny is the change that removes the lunch-break failure, and it is the most valuable single thing in the whole exploration. It is also a change to the _runtime's_ hold semantics, not a UI change, and it lands differently on each of the three runtimes (DOR-803 is already open on Codex/OpenCode timeout parity). B removes the hunting for every runtime today, with no runtime change at all; C should be specified against a runtime interface that B's Ask object gives it for free.

**The six edge cases, agreed on the screen and carried into the spec verbatim:**

| Case                             | Behaviour                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Two people in the room           | First answer wins; others see "Dorian allowed this". Only an eligible approver sees the card at all — everyone else sees the vague notice. |
| Ask arrives while you are typing | Never steal focus. `A` / `D` fire only when the card is focused. Draft untouched.                                                          |
| Burst of asks                    | Same agent, five reads → one stacked card, "wants to read 5 files ▾ · Allow all". Different agents → separate cards.                       |
| Answered elsewhere               | Card morphs into a receipt with who and when. A second answer gets "already allowed by Dorian at 2:01".                                    |
| Session gone / agent restarted   | Ask goes stale → "no longer needed". Never a button that does nothing.                                                                     |
| Mobile                           | Full-width card, two buttons per row, details in a sheet, long-press for scope.                                                            |

---

## 3. The Ask card itself

**Screen:** part 2, "The one card (rendered the same everywhere)". Not an options group — presented as the single design and accepted.

The compact first line carries, left to right: the agent's face · **who** · the verb ("wants to **edit**") · the target as inline code · the origin as a small tag ("from #mio") · time left, right-aligned. Under it, indented past the face, the agent's own reason in quotes plus a scale hint ("+14 −2 lines · preview"). Then the actions: **Allow** (`A`) · Allow & don't ask again ▾ · **Deny** (`D`) · Open session →. A thin progress bar across the bottom is the countdown.

Everything below the first line is progressive disclosure. Non-approvers in a shared room see today's vague line instead of this card, never a redacted version of it.

**Carried into the spec with two amendments, both mine, both recorded so the HTML is not read as more current than the spec:**

- **"Allow & don't ask again ▾" is not built here.** It is scope options, which is tier C. The card keeps its slot in the action row so C drops in without a re-layout, and ships with Allow · Deny · Open session.
- **"+14 −2 lines · preview"** ships only where the raised prompt already carries the material. The SDK prompt gives `title`, `displayName`, `description` and `blockedPath`; a diff stat is not among them, and inventing one from the tool input is exactly the kind of guess that makes a permission dialog untrustworthy. The card renders what the prompt says and nothing else.

---

## 4. Where the working line sits

**Screen:** part 3a — three placements, each drawn as a room.

**The tension, stated on the screen:** `specs/room-presence` §5.1 put the line **under** the composer on purpose — _"putting it above would push the last message every time an agent picked something up."_ So the real question is how to sit above the composer without shoving the conversation.

**Options:**

- **A) Reserved lane above the composer (the Slack model).** Fixed height, always there, empty when nobody works. Zero layout shift. Cost: ~22px of blank in every quiet room.
- **B) Floating pill over the bottom edge of the timeline.** Out of flow, on the avatar rail, over the last message's bottom padding. No reserved space, no push; grows in place into the peek; on hand-off the pill's avatar slides up into the new message's avatar slot. **My recommendation.**
- **C) A thin status strip that is part of the composer** — where the session chat already puts `ChatStatusStrip`. All three surfaces share one strip and one vocabulary; push happens but reads as "the composer told me something".

**Chosen: A** (`place-A`).

**Why A wins over my B, on reflection rather than deference.** My case for B was that it keeps quiet rooms visually quiet. That case is weaker than it looked, for three reasons the spec now depends on:

1. **A floating pill over the timeline is a layer, and a layer has to be dodged.** It covers the last message's bottom padding — which is exactly where the newest message lands, the thing you are most likely reading when an agent picks something up.
2. **The session chat already pays the reserved cost** and nobody has complained: `ChatStatusStrip` is mounted above the composer today. Choosing B for rooms would have left the two surfaces with different physics, which is the opposite of this programme's point.
3. **A is the only option where "zero layout shift" is a structural property rather than a promise.** The lane's height is a constant; the assertion a browser test makes is "the timeline's scroll offset does not change when presence starts", and under A that test cannot go red for a reason a stylesheet edit introduced.

The accepted cost is A's own: one blank 22px line in a quiet room. Recorded as a cost, not smoothed over.

**What A inherits from B:** the growth-in-place gesture and the hand-off. The lane's content is a single morphing container, so clicking presence content grows it into the peek rather than popping a detached menu, and when the reply lands the lane's content fades over 160ms while the reply rises — the indicator visibly becomes the answer.

**Amended in P3 (DOR-1330), and the amendment is a trade rather than a slip.** Both things the lane opens — the peek and the Ask card — are drawn in a popover anchored to the lane, not grown inside it. The lane is exactly 24px so that nothing it shows can move the conversation, and a card that grew inside it would break that promise on every prompt; a popover also becomes a bottom sheet on a phone through one implementation, and closes on Escape with the caret handed back. What is lost is the growth gesture this paragraph asks for. If a later phase wants it back, the honest shape is an overlay anchored to the lane animating its own height from 24px, not a lane that grows.

---

## 5. Every state the line can be in

**Screen:** part 3b — twelve states as cards, each with a "why". Green dot is the one animated thing; amber is needs-you; copy stays plain. Accepted as drawn, with the amendments noted.

| State                    | Line                                                                             | Why (from the screen)                                             |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Idle                     | nothing rendered _(amended: the lane is present and empty)_                      | A quiet room looks quiet.                                         |
| Just started (< 10s)     | ● MN **Meeting Notes** is working on it                                          | No timer yet — a number starting at 0s draws the eye for nothing. |
| Working (≥ 10s)          | ● MN **Meeting Notes** is working on it · 42s                                    | Ticks locally. Same as today.                                     |
| Doing something specific | ● MN **Meeting Notes** _is reading_ `standup.md` · 1m 04s                        | **Deferred** — needs a new wire field (tier 3).                   |
| Taking longer than usual | ● MN **Meeting Notes** is still working — this is taking longer than usual · 12m | Server's late threshold. Same words.                              |
| Needs you                | ◆ MN **Meeting Notes** needs your OK to edit `standup.md` · <u>Answer</u>        | The bridge to part 2: amber, and it grows into the Ask.           |
| Two or three agents      | ● MN PM **Meeting Notes** and **Mio Clicker PM** are working on it · 42s         | Oldest claim's time. Avatars stack.                               |
| Four or more             | ● MN PM DB +2 **5 agents** are working on it ▾                                   | Expands to names and each one's time.                             |
| Hand-off (reply lands)   | the line at 55% opacity, fading                                                  | Fades 160ms while the avatar rides up into the new message.       |
| Stream stalled           | hidden; the stalled notice speaks                                                | A client that cannot read the stream does not claim to know.      |
| Thread scope             | ● MN **Meeting Notes** is replying in a thread · 20s                             | One claim, one line, announced in the thread panel.               |
| Reduced motion           | same line, dot does not pulse                                                    | No pulse, no slide.                                               |

**Two amendments from the placement choice, both mine:**

- **"Idle" is now "the lane is mounted and empty", not "nothing is rendered".** Under placement A the lane's whole value is that it does not appear and disappear. The state's _appearance_ is unchanged (nothing visible); its _implementation_ is the opposite.
- **The lane also has to hold everything `ChatStatusStrip` shows today** — elapsed, tokens, permission-mode warning, operation progress, activity, and the completed flash. Part 3b was drawn against the room, where those do not exist. They become lane content at a lower priority than presence, not a second strip.

---

## 6. What the click does — the peek, and how much of it ships

**Screen:** part 3c (the peek card, two rows) and part 3d (three tiers).

**The peek, as drawn:** hover gives a tooltip with per-agent times. Click or Enter grows the line in place into a small card. Esc closes. It never steals focus from the composer. Per agent, exactly: **who + how long** · **what it is answering** (a link that scrolls to the triggering message — we carry `entryId`) · **what it is doing now** (the verb glimpse, if we add the signal) · **two actions**, _Open its session_ and _Stop_. Steering stays in the composer via `@mention`.

**The delight budget, spent carefully and listed exhaustively on the screen:** the avatar breathes (soft halo, only while working); the line grows into the peek instead of popping a menu; the hand-off when the reply arrives. That is the list.

**Options:**

- **1)** Move + click → names, times, jump-to-message, Open session. No new server data.
- **2)** 1 + Stop + the amber needs-you state. **My recommendation** (paired with placement B).
- **3)** 2 + the verb glimpse ("is reading standup.md"). New presence field: current verb + target, republished with the claim.

**Chosen: 2** (`peek-2`). Tier 3 rides with approvals tier C.

**One thing tier 2 needs that the screen did not price:** _Open its session_ needs a room-author → session mapping on the client, and the room's presence signal deliberately does not carry `sessionId` (`specs/room-presence` §15: an in-flight session id "waits for a design that checks the caller's right to it"). The spec pays that price explicitly rather than smuggling the id onto the presence wire — see §7 of `02-specification.md`.

---

## Final Design Summary

**One component tree.** There is one `Conversation` compound and every messaging surface composes it: the agent session, a channel, and a DM. `Conversation.Root` carries the context — which surface this is, what it can do, and how to send to it. Inside it: a `Header` slot the host fills, one `Timeline` (virtualized, with the scroll thumb, the unread cursor, the day and unread dividers, thread grouping and the a11y feed), one `Message` row family (`Root · Gutter · Author · Body · Attachments · Reactions · Actions`), one `LiveLane`, one `Composer` host, and a `Footer` slot. Look is decided by variants — `surface`, `anchor` (`corner` or `rail`), `density`. Behaviour is decided by **capability flags** — reactions, threads, run-with, attachments, tool cards. A row never asks which surface it is on. The bodies stay typed and pluggable: session parts (text, tool cards, thinking, prompts) and room bodies (markdown plus mention pills) are two renderers behind one map, not one forced union.

**A live lane above the composer.** Every surface mounts a reserved, fixed-height, one-line lane directly above its composer. It is always there and usually empty, so nothing it ever shows can push the conversation — that is the whole reason it is reserved. Its content is one morphing container with a strict priority order: an **Ask** (amber; grows into the card) beats a **stalled stream** (which hides everything, because a client that cannot read the stream must not claim to know), which beats **presence** ("Meeting Notes is working on it · 42s"; two or three names; four or more counted; "still working, this is taking longer than usual"; "replying in a thread"), which beats the **session's own status** (elapsed, tokens, permission-mode warning, operation progress, the completed flash — everything today's `ChatStatusStrip` says), which beats a **queue** note ("1 queued"), which falls through to empty. Content crossfades in 150–200ms. The working dot is the only thing that moves, and under reduced motion it stops moving and stays visible. On a phone the lane truncates rather than wrapping; the peek carries the rest.

**Clicking the lane opens the peek.** A popover, one row per working agent: face · name · state · elapsed · what it is replying to (a link that scrolls to that message) · **Open its session** · **Stop**. Esc closes it. It never takes focus from the composer. When the lane is amber, clicking opens the Ask card instead.

**One Ask, answerable from anywhere.** A tool prompt, a question, or an elicitation is one object — an **Ask** — and it is broadcast to the whole app the moment it is raised, not just to the session that raised it. It shows up in five places at once, all drawing the same card: the header pill, the sidebar's _Heads up_ row, the home triage header, the room's live lane, and inline in the session itself. The card reads _"**Meeting Notes** wants to **edit** `standup.md`"_, tagged with where it came from, with time left and a thin countdown bar. Allow, Deny, or Open session. `A` and `D` work only when the card has focus, so an Ask that lands while you are typing cannot swallow a keystroke; `⌘⇧A` jumps to the next one. Answer it once and it resolves everywhere — the other copies become a receipt ("You allowed this", or "already allowed by Dorian at 2:01"), and an Ask whose session has gone says "no longer needed" instead of offering a button that does nothing. Five reads from one agent stack into one card with **Allow all**.

**Who may answer, and who may see.** Detail goes only to someone who can act on it. On this machine that is the operator. In a room bridged to Telegram or Slack it is the configured approvers, and the agent that raised the Ask can never answer its own. Everyone else sees exactly what the room shows today: the vague, durable, late notice, with no file path, no command and no countdown. That notice does not change, and the live card does not replace it — the card is instant and ephemeral, the notice is the log.

**What goes away.** The room's presence line under the composer, the session's status strip and its in-composer status section, the room's own timeline and row, the second composer host, the second scroll-pinning hook, the second time formatter, and the two hover-action systems. Each is replaced by the one shared thing, in the same pull request that deletes it.
