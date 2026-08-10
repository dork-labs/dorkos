---
title: 'Mid-Turn Input UX Across Coding Agents — Queue, Steer, Stage, Interrupt (Product Survey)'
date: 2026-08-10
type: research
status: active
linear: DOR-1089
project: Persistent session runtime
tags:
  [
    steering,
    message-queuing,
    composer,
    ux-survey,
    claude-code,
    codex,
    opencode,
    cursor,
    amp,
    windsurf,
    copilot,
    dor-1089,
  ]
---

> Companion to `20260610_message_queuing_agent_runtimes.md` (protocol/runtime layer). This is the product/UX layer, researched 2026-08-10 for DOR-1089 P4 (composer affordances, task 4.6).

# Mid-Turn Input Handling in Coding Agents — Industry Survey (August 2026)

**Research depth:** Deep. 12 searches + 9 direct doc fetches. Builds on the existing repo report `research/20260610_message_queuing_agent_runtimes.md` (June 2026), which covers the _protocol/runtime_ layer; this covers the _product/UX_ layer and updates it.

**Verification legend:** **[V]** = stated in vendor documentation or a merged PR I fetched directly. **[V-2]** = vendor docs quoted through a search snippet I did not fetch page-for-page. **[I]** = inferred from community reports / issue trackers (provenance noted).

---

## 0. The vocabulary problem (read this first)

The three verbs are **not** consistently named across products, and two products use the same word for different mechanics. The load-bearing distinction is **where the message lands in the agent's loop**:

| Verb                     | Lands                                                   | Turn boundary                  |
| ------------------------ | ------------------------------------------------------- | ------------------------------ |
| **QUEUE**                | after the current turn completes                        | starts a **new** turn          |
| **STEER**                | inside the current turn, at the next tool/step boundary | **same** turn continues        |
| **INTERRUPT**            | immediately, killing in-flight work                     | current turn aborted, new turn |
| **STAGE / context-only** | transcript only, no turn triggered                      | no turn at all                 |

GitHub's Copilot SDK is the only vendor that has written this down as a formal, two-value API contract, and it's the cleanest definition in the industry **[V]**:

> **Steering (immediate mode):** "Injected into the **current** LLM turn"… "useful for course-correcting without aborting the turn."
> **Queueing (enqueue mode):** "Queued and processed **after** the current turn finishes. Each queued message starts its own full turn."
> "This is the default mode — if you omit `mode`, the SDK uses `"enqueue"`."
> — [Steering and queueing, GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/steering-and-queueing)

Also from that page, the single most useful engineering detail anywhere in this survey **[V]**: steering is _best-effort within the turn_ — "If the agent has already committed to a tool call, the steering takes effect after that call completes but still within the same turn," and if the turn finishes first, "it is automatically moved to the regular queue for the next turn." **Steer degrades to queue automatically.** That's the fallback semantic worth copying verbatim.

---

## 1. Claude Code (Anthropic)

### CLI — default behavior

**Enter mid-turn is STEER, not queue** — despite the UI labelling it "queued." Current official docs **[V]**:

> "**Press `Esc`** to stop Claude immediately. The running tool call is canceled and Claude waits for your next instruction.
> **Type a correction and press `Enter`** to send it without stopping the running tool. **Claude reads it as soon as the current action completes and adjusts before deciding its next step.**"
> — [How Claude Code works § Interrupt and steer](https://code.claude.com/docs/en/how-claude-code-works)

"As soon as the current action completes… before deciding its next step" is tool-boundary injection inside the live turn = steer by the Copilot definition. The desktop app doc uses near-identical wording for its composer **[V]**: "type a correction and press **Enter** to send it without stopping the running action. Claude reads the correction as soon as the current action completes and adjusts before its next step." ([Desktop application](https://code.claude.com/docs/en/desktop))

This wording is _new_. It was previously "Claude will stop what it's doing and adjust its approach," which triggered [issue #36326](https://github.com/anthropics/claude-code/issues/36326) (opened 19 Mar 2026, closed not-planned): _"typing a message and pressing Enter while Claude Code is working does NOT interrupt it. Instead, the message appears as a 'queued message.'"_ **[V]** The docs were corrected rather than the behavior. Net: **Anthropic's stated default is steer-at-next-decision-point; the UI still says "queued."** Terminology debt in the product itself.

### Interrupt / stop semantics **[V]** ([Interactive mode](https://code.claude.com/docs/en/interactive-mode))

| Key             | Behavior                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Esc`           | "Interrupt Claude, or close a dialog… Stop the current response or tool call mid-turn so you can redirect. **Claude keeps the work done so far.** When a dialog such as a permission prompt is open, `Esc` closes the dialog rather than interrupting." |
| `Esc` `Esc`     | **Overloaded.** Input has text → clears draft, saves to history. Input empty → opens the **rewind menu** (restore code/conversation to an earlier checkpoint). _Not_ an interrupt.                                                                      |
| `Ctrl+C`        | "Interrupt, or clear input. Interrupts a running operation. If nothing is running, first press clears input, second exits."                                                                                                                             |
| `Ctrl+B`        | Background the running Bash task/agent (tmux users press twice) — a genuine third escape hatch: don't stop it, get out of its way.                                                                                                                      |
| `Ctrl+X Ctrl+K` | Stop all background subagents; press twice within 3s to confirm.                                                                                                                                                                                        |
| `Shift+Tab`     | Cycle permission modes (not queue-related, but the other mid-flight control).                                                                                                                                                                           |

Note the **divergence from every other product surveyed**: in Claude Code `Esc` is the interrupt and there is **no modifier that means "send now."** Anthropic gives you steer-on-Enter and interrupt-on-Esc, and never asks you to choose a disposition at send time.

### Context without a response

No true "stage context, don't respond" primitive in the CLI UI. The nearest things are the **inverse** — response without context:

- **`/btw`** **[V]**: "Available while Claude is working: you can run `/btw` even while Claude is processing a response. The side question runs independently and **doesn't interrupt the main turn**." Answer is dismissed with Space/Enter/Esc and doesn't enter history.
- **Desktop "side chat"** **[V]**: "ask Claude a question that uses your session's context but doesn't add anything back to the main conversation."

The real staging primitive exists one layer down, in the **Claude Agent SDK**: `SDKUserMessage.shouldQuery: false` — "the message is appended to the transcript without triggering an assistant turn. It will be merged into the next user message that does query," plus `priority: 'now' | 'next' | 'later'`. (Documented in `research/20260610_message_queuing_agent_runtimes.md` §3.2 against the installed `sdk.d.ts`.) **This is the only shipped context-staging primitive found anywhere in the survey, and no product surfaces it in a UI.**

### Queue UI

Weakest in the field. A pending message renders as a line above the input; there is **no list, no edit, no delete, no reorder** **[I]** — the standing feature requests are [#36817 (TUI queue management: view/delete/reorder/interrupt)](https://github.com/anthropics/claude-code/issues/36817), [#48802 (reorder/edit/remove queued prompts)](https://github.com/anthropics/claude-code/issues/48802), and [#62349 (`/cancel` to clear the queue without interrupting)](https://github.com/anthropics/claude-code/issues/62349). Community reports **[I]** say the terminal lets you press `Up` to recall and edit a pending message, while **the desktop app locks it in — no edit, no remove** ([Kilo Loco, Claude Code Desktop first impressions](https://www.kiloloco.com/articles/claude-code-desktop-first-impressions)).

One real mechanic worth noting **[I]**: slash commands sent mid-turn enter a **priority queue and execute between agent iterations** rather than interrupting (e.g. `/compact`). Desktop docs corroborate the shape **[V]**: "You can send a command while Claude is working, the same as any other message, and the session returns to idle once the turn finishes."

### VS Code extension

Behaves as its own surface with its own gaps — [#30677](https://github.com/anthropics/claude-code/issues/30677) asks for queued-send _instead of_ interrupting, and [#34345](https://github.com/anthropics/claude-code/issues/34345) proposes long-pressing the send button for a queue/schedule context menu **[I]**. Read that as: the extension historically leaned interrupt-ish and is being pulled toward the CLI's steer default. Not authoritatively documented.

---

## 2. OpenAI Codex

### CLI — the only product where **steer is the default and queue is the modifier**

The inversion is deliberate and traceable to a single merged PR **[V]**: [openai/codex#9077](https://github.com/openai/codex/pull/9077), titled **"Send message by default mid turn. queue messages by tab"**, merged **13 Jan 2026**, which also replaced a prior `Ctrl+K` queue binding and renamed the beta feature's UI label to **"Steer mode."**

| Key                          | Behavior                                                                                                 | Source                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter` (mid-turn)           | **Steer** — delivers the message into the running turn to redirect it                                    | **[V-2]** [Codex CLI TUI Shortcuts reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/) (updated 10 Aug 2026, v0.135.0); [Dev Genius](https://blog.devgenius.io/codex-clis-busy-week-steer-mode-fork-and-7-releases-in-3-days-ece5c742923e) |
| `Tab` (mid-turn)             | **Queue** — "holds your prompt until the agent finishes its current turn"                                | same                                                                                                                                                                                                                                                                                  |
| `Esc`                        | Interrupt the running task only — does **not** quit Codex                                                | same                                                                                                                                                                                                                                                                                  |
| `Esc` `Esc` (empty composer) | Edit previous user message / **fork** the transcript from that point; keep pressing to walk further back | same                                                                                                                                                                                                                                                                                  |
| `Ctrl+C`                     | Cancel current operation; twice to quit                                                                  | same                                                                                                                                                                                                                                                                                  |

The framing in the community reference is the sharpest articulation of the two-verb split I found **[V-2]**: Enter for _"stop, don't delete that file"_ / _"use the staging database instead"_; Tab for _"after that, run the test suite"_ / _"then update the changelog."_ **Urgency picks the key, not a menu.**

Vendor docs are thin here: the official [Codex CLI page](https://learn.chatgpt.com/docs/codex/cli) only says you can "**Steer the active turn**, inspect commands and diffs as they appear, and keep follow-up work in the same session" **[V]** — it confirms steer is a first-class product verb but defers keybindings to in-app `?`.

Underneath, the app-server protocol exposes `turn/steer` (requires `expectedTurnId`) and `turn/interrupt` as **separate JSON-RPC methods** — the strongest protocol-level evidence that these are distinct operations, not a UI affordance (documented in the June repo report §4.2).

### IDE extension — different default, and it's configurable

The VS Code extension **flips back to queue-by-default** and adds a per-message escape hatch **[I]**, per multiple issue reports: _"when you add prompts while the model is running, the prompt is queued unless you press 'Steer' on it"_ — i.e. a **pending card with a `Steer` button** rendered near the composer ([#30267](https://github.com/openai/codex/issues/30267)). There is a setting, **`chatgpt.followUpQueueMode`**, with at least `queue` and `steer` values ([#31128](https://github.com/openai/codex/issues/31128); [OpenAI community: "Queuing in vscode extension fails unpredictably (steers instead of queues)"](https://community.openai.com/t/queuing-in-vscode-extension-fails-unpredictably-steers-instead-of-queues/1376631)). The official [Codex IDE doc](https://learn.chatgpt.com/docs/codex/ide) documents **none** of this — I fetched it and confirmed the absence. **[V]**

So: **Codex ships two opposite defaults on two surfaces of the same product**, with the IDE one undocumented and reportedly flaky. That's the cautionary tale of the whole survey.

### Codex cloud/web

No documented mid-turn input semantics found. Treat as unknown.

---

## 3. OpenCode (sst/opencode)

**Default: queue.** Typing while busy holds the message; it fires when the current turn ends. There is **no native steer verb** — the gap is filled by a third-party plugin.

| Key                    | Behavior                                                                                                                                                                                              | Source                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Esc`                  | `session_interrupt` — abort the active session/response. **This is the documented default.**                                                                                                          | **[V]** [opencode.ai/docs/keybinds](https://opencode.ai/docs/keybinds/) |
| `Enter`                | `input_submit` (queues when busy)                                                                                                                                                                     | **[V]** same                                                            |
| `Ctrl+C`               | `input_clear` (also `app_exit`)                                                                                                                                                                       | **[V]** same                                                            |
| `Ctrl+G` (desktop app) | "Cancel popovers / abort running response"                                                                                                                                                            | **[V]** same                                                            |
| `Ctrl+Enter`           | **Not native.** A plugin, [`oc-ctrl-enter-force-import`](https://github.com/mynameistito/oc-ctrl-enter-force-import), binds it to _interrupt-then-submit_ so the prompt doesn't sit behind the queue. | **[V]**                                                                 |

That plugin exists at all is the tell: **users want a "send now" modifier badly enough to build it**, and it has to fake steer by interrupting — it dispatches `session.interrupt` **twice** to get past OpenCode's guarded abort flow, then `prompt.submit`.

**Queue UI is the best-developed in the TUI/CLI class** **[I]** — visual queue separation between `queuedMessages` and `activeMessages`, a **pinned queue section**, a **"Queued" shimmer** on pending items with a **✕/trash cancel button**, and `cancelQueued()` / `getQueuedMessageIds()` in the queue logic with `loopId` tracking to prevent dequeue races. Provenance caveat: these details come from the opencode issue tracker as surfaced by search ([#12707 "queued message controls with send now in prompt"](https://github.com/anomalyco/opencode/issues/12707), [#13304](https://github.com/anomalyco/opencode/issues/13304), [#24472](https://github.com/anomalyco/opencode/issues/24472), [#8685](https://github.com/anomalyco/opencode/issues/8685), [#4821](https://github.com/anomalyco/opencode/issues/4821), [#6942](https://github.com/anomalyco/opencode/issues/6942)). **The search index returned these under the org `anomalyco/opencode` rather than `sst/opencode`; I could not reconcile that and did not fetch the issues directly. Treat issue numbers as indicative, the behaviors as INFERRED.**

The known failure mode is unchanged from the June report: **queued messages are dropped when the session is interrupted** ([#5333](https://github.com/anomalyco/opencode/issues/5333)). No context-staging primitive.

---

## 4. Cursor

**Default: queue. Modifier: interrupt-and-send.** The most mature _management_ UI in the field.

Current docs **[V]** ([Cursor Agent overview](https://cursor.com/docs/agent/overview)):

> "Queue follow-up messages while Agent is working on the current task. Your instructions wait in line and execute automatically when ready." — type, press **Enter** to queue; "messages appear in order **below the active task**"; **drag to reorder**.
> "Pressing **Cmd+Enter** sends your message immediately rather than waiting," creating "a more responsive experience for urgent follow-ups" and letting you "**interrupt or redirect** Agent's current work."

Note the verb: Cursor's Cmd+Enter is documented as **interrupt**, not steer. A forum-sourced detail **[I]** adds that the immediate message "is appended to the most recent user message in the chat and processed right away" — which is closer to steer-by-concatenation than a clean turn abort. Unresolved; flag as ambiguous.

**Timeline** **[I]/[V-2]**: queueing shipped in **Cursor 1.2** (July 2025) alongside agent to-dos ([changelog 1.2](https://cursor.com/changelog/1-2)); **2.4** added "improved message queueing with better handling and **drag-and-drop reordering**." Bindings and the default are **user-configurable**: `Opt+Enter` queues, `Cmd+Enter` interrupts-and-sends, and the default is switchable at **Settings → Chat → Queue messages** ([forum](https://forum.cursor.com/t/cursor-agent-send-queued-message/147962)).

**Can queued messages be edited / reordered / cancelled?** Reorder: **yes** (drag, documented). Edit and individual cancel: **contested** — Cursor's docs describe reordering only, and user reports say there's still no way to edit or remove an individual queued prompt without cancelling everything ([forum](https://forum.cursor.com/t/queued-messages-not-being-processed-in-order/135939)). **[I]** Ordering bugs are reported. No context-staging.

---

## 5. Short takes

**Amp (Sourcegraph)** — **the cleanest three-tier ladder in the industry, all on one key family** **[V]** ([Owner's Manual](https://ampcode.com/manual)): _"If you send a message when the agent is still working, your message is queued and will be sent when the agent is done. Press **Enter Enter** to steer it sooner, which sends the message when the agent is done with its current step (such as a command or thinking block). Press **Esc Esc** to forcibly stop the agent and send your message immediately."_ Three dispositions, one mental model — **Enter = later, Enter Enter = sooner, Esc Esc = now** — with each escalation named by _when it lands_, not by internal mechanism. Amp also exposes `{"steer": true}` in its stream-json input, so the UI ladder maps 1:1 to the API.

**Windsurf (Cascade)** — queue-by-default with two refinements **[V-2]** ([Cascade overview](https://docs.windsurf.com/plugins/cascade/cascade-overview)): type while Cascade works and press Enter to queue; **"press Enter again on an empty text box to send a message right away"** (a double-Enter-style escalation, like Amp, but on an _empty_ composer); and **"you can remove any message from the queue before it's sent."** Windsurf and OpenCode are the two products where individual queue-item removal is clearly a shipped feature.

**GitHub Copilot agent mode** — formally the best-specified (§0 above): `mode: "immediate" | "enqueue"`, **default `enqueue`**, steer auto-demotes to queue if the turn ends first **[V]**. The _product_ surfaces lag the SDK: in Copilot CLI, queued messages can't be cleared without cancelling the running job ([#2055](https://github.com/github/copilot-cli/issues/2055), [#1857](https://github.com/github/copilot-cli/issues/1857)), and messages sent while background subagents run get **stranded in a `Queued (N)` UI region** that doesn't drain ([#3344](https://github.com/github/copilot-cli/issues/3344)) **[I]**. VS Code has an active work item ([microsoft/vscode#297145](https://github.com/microsoft/vscode/issues/297145), Feb 2026) specifying exactly the target UI: _"Queued messages should be editable per usual, with context menu / hover actions to **send a queued/steering message immediately**, **remove it**, or **remove all** queue/steered messages"_ **[I]** — the most explicit statement anywhere of where the industry is heading.

---

## Synthesis

### (a) Has the default converged? — Yes on **queue**, with Codex CLI as the loud dissenter and Claude Code as a quiet one

| Product             | Enter mid-turn (default)        | "Send now" modifier          | Distinct steer verb?                     | Context-only?                  |
| ------------------- | ------------------------------- | ---------------------------- | ---------------------------------------- | ------------------------------ |
| Claude Code CLI     | **Steer** (next decision point) | — (none)                     | Yes, but unnamed in UI; UI says "queued" | SDK-only (`shouldQuery:false`) |
| Claude Code desktop | Steer (same wording)            | Stop button                  | same                                     | Side chat (inverse)            |
| Codex CLI           | **Steer**                       | `Tab` = **queue** (inverted) | **Yes, named "Steer mode"**              | No                             |
| Codex IDE ext.      | Queue                           | per-message **Steer** button | Yes (`followUpQueueMode`)                | No                             |
| OpenCode            | Queue                           | plugin-only `Ctrl+Enter`     | No                                       | No                             |
| Cursor              | Queue                           | `Cmd+Enter` (interrupt+send) | No (interrupt-framed)                    | No                             |
| Amp                 | Queue                           | `Enter Enter` = steer        | **Yes**                                  | No                             |
| Windsurf            | Queue                           | `Enter` on empty box         | No                                       | No                             |
| Copilot             | Queue (`enqueue` default)       | `mode:"immediate"`           | **Yes**                                  | No                             |

**Six of nine surfaces default to queue.** The two exceptions are both worth understanding rather than dismissing:

- **Codex CLI chose steer-by-default on purpose** and made queue the deliberate act (`Tab`). Rationale: the common mid-turn message is a _correction_, and corrections are worthless late.
- **Claude Code is steer-by-default but calls it queue.** Its steer lands at the next tool boundary, which feels like a queue for a slow tool call and like a steer for a fast one. This ambiguity generated a real bug report against its own docs.

**Enter never means "interrupt" anywhere.** That is the one universal. Every product protects in-flight work from a naive Enter.

Second-order convergence: **steer's landing point is always a step boundary, never token-level.** Copilot ("after that call completes"), Claude Code ("as soon as the current action completes"), Amp ("when the agent is done with its current step (such as a command or thinking block)"). Nobody injects mid-tool-call. Any implementation should define its **injection points** explicitly and document them in those terms.

### (b) Emerging UI patterns for rendering queued/steered messages

Ranked by how many products have converged on them:

1. **Pending items render inline in the transcript, below the active turn, in submission order** — Cursor ("appear in order below the active task"), OpenCode (pinned queue section), Copilot (`Queued (N)` region), Claude Code (single line above input). Universal direction: _the queue is part of the conversation, not a separate panel._
2. **A distinct visual state, not just placement** — OpenCode's **"Queued" shimmer** is the most-copied idea (animated/dimmed rather than a static badge), signalling "not yet real." **[I]**
3. **Per-item affordances on hover/context-menu**: `✕` remove (OpenCode ✓, Windsurf ✓, Copilot planned, Cursor ✗, Claude Code ✗), **"send now"** (Codex IDE's `Steer` button on the pending card; Copilot's planned "send immediately"), **remove all** (Copilot planned; Claude Code has an open `/cancel` request).
4. **Drag-to-reorder** — Cursor only, shipped in 2.4. The clearest current differentiator.
5. **Queued vs steered rendered differently** — only the Codex IDE extension distinguishes them visibly today (a _pending_ card that carries a `Steer` action, i.e. the disposition is chosen _after_ composition). Copilot's spec treats "queue/steered messages" as one list with per-item disposition. **This is the least-solved UI problem in the space and the most open opportunity.**

**Anti-patterns, all reported in the wild:** silently swallowing input with no indicator (Claude Code); queue drained only on an event that may never fire (Copilot's stranded `Queued (N)`); queued messages **dropped on interrupt** (OpenCode #5333); "cancel the queue" only reachable via "cancel the whole job" (Copilot CLI); and the same product shipping opposite defaults on two surfaces (Codex CLI vs IDE).

### (c) Shortcut conventions worth adopting

- **`Enter` mid-turn must never abort.** Universal. Non-negotiable.
- **Two escalation grammars exist. Pick one and stay consistent:**
  - **Modifier grammar** (Cursor `Cmd+Enter`, OpenCode-plugin `Ctrl+Enter`, Codex `Tab`): fast, discoverable via tooltip, but requires the user to decide disposition _before_ pressing send.
  - **Double-tap grammar** (Amp `Enter Enter` / `Esc Esc`, Windsurf `Enter` on empty box, Claude Code `Esc Esc`): no new keys, and it reads as _escalation_ — press again to mean it more. **Amp's is the most learnable ladder in the survey.**
- **`Cmd/Ctrl+Enter` = "send now" is the closest thing to a cross-product idiom** in GUI surfaces (Cursor native, OpenCode by plugin, Copilot planned). Adopt it for a GUI cockpit.
- **`Esc` = stop the current turn, keeping completed work** (Claude Code, Codex, OpenCode all agree). `Ctrl+C` = harder stop, second press exits (Claude Code, Codex agree).
- **`Esc Esc` is dangerously overloaded** — Claude Code: clear draft / open rewind. Codex: edit-and-fork previous message. Amp: **interrupt and send**. Three products, three incompatible meanings, all reachable from an empty composer. **Do not bind `Esc Esc` to anything a user could confuse with a competitor's binding.** Prefer an explicit modifier for interrupt-and-send.
- **Make the default configurable and label the setting in user language.** Cursor (`Settings → Chat → Queue messages`) and Codex IDE (`chatgpt.followUpQueueMode`) both do it. Given that the industry hasn't converged, a setting is honest.
- **Escalation should be reachable after composing**, not only at send time — the Codex IDE "pending card with a Steer button" pattern lets a user queue, then change their mind while the turn is still running. That's strictly more forgiving than a send-time modifier, and it's what Copilot's VS Code spec is building toward.

### (d) Genuinely novel, one product each

1. **Claude Agent SDK — `shouldQuery: false` (context staging).** "Appended to the transcript without triggering an assistant turn… merged into the next user message that does query." **The only shipped context-without-response primitive in the entire survey, and no product exposes it in a UI.** Paired with `priority: 'now' | 'next' | 'later'`, this is a three-axis model (when, whether, how urgent) that every product UI collapses into one axis. **This is the whitespace.** A cockpit that shipped a visible "add context, don't answer" action would be first.
2. **Copilot SDK — automatic steer→queue demotion.** "If the turn finishes before it is processed, it is automatically moved to the regular queue." The steer/queue race is the #1 real-world bug class (Codex IDE's "steers instead of queues" flakiness, OpenCode's drop-on-abort), and Copilot is the only one that specifies the resolution. **Copy this rule.**
3. **Claude Code — `Ctrl+B` backgrounding and `/btw` side questions.** Two escape hatches nobody else has: _don't stop it, get out of its way_, and _ask something without touching the turn or the transcript_. `/btw` is context-staging's mirror image — response without context — and is the only "talk to the agent while it works, with zero effect on the work" affordance in the field.
4. **Codex CLI — steer-as-default with queue as the deliberate act (`Tab`).** Inverts everyone else's assumption and has held for ~7 months. If your users' mid-turn messages are mostly corrections rather than follow-ups, the evidence says this default is defensible.
5. **Cursor — drag-to-reorder a live queue.** Treats the queue as an editable plan rather than a FIFO buffer. Nobody else ships it.
6. **Amp — naming each disposition by _when it lands_** ("queued… sent when the agent is done" / "steer it **sooner**… when the agent is done with its current step" / "**immediately**"). No internal mechanism leaks into the copy. This is a writing lesson as much as a UX one.

### Bottom line for a multi-runtime cockpit

The June repo report's recommendation — standardize **queue / steer / interrupt** as three dispositions at the runtime boundary, server-owned queue, per-adapter capability declaration — is **confirmed and strengthened** by eight more months of product evidence. Three refinements this survey adds:

1. **Default to queue, but expose steer as a named, one-key escalation** (`Cmd+Enter` for send-now; consider an Amp-style double-Enter for steer). Queue is the converged default; Codex CLI is the informative exception, not the trend.
2. **Specify the steer→queue demotion rule** (Copilot's) and the **drop-on-interrupt rule** (OpenCode's bug) _before_ implementing, and test both. These are the two failure modes every shipped product has hit.
3. **Ship the queue as an editable, inline, per-item-controllable list** — remove, send-now, reorder — because Cursor, Windsurf, OpenCode and Copilot are all converging there and Claude Code's absence of it is the single most-filed complaint against it. And consider surfacing **context-staging** as a distinct action: the primitive exists in the SDK DorkOS already depends on, and no competitor has put a UI on it.

**Sources:**

- [How Claude Code works — Interrupt and steer](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code — Interactive mode (keyboard shortcuts)](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code — Desktop application](https://code.claude.com/docs/en/desktop)
- [anthropics/claude-code#36326 — "Docs say Enter interrupts mid-task, but it only queues"](https://github.com/anthropics/claude-code/issues/36326)
- [anthropics/claude-code#36817 — TUI queue management](https://github.com/anthropics/claude-code/issues/36817)
- [anthropics/claude-code#48802 — reorder/edit/remove queued prompts](https://github.com/anthropics/claude-code/issues/48802)
- [anthropics/claude-code#62349 — /cancel for queued messages](https://github.com/anthropics/claude-code/issues/62349)
- [anthropics/claude-code#30677 — VS Code queued send](https://github.com/anthropics/claude-code/issues/30677)
- [anthropics/claude-code#34345 — VS Code long-press queue menu](https://github.com/anthropics/claude-code/issues/34345)
- [openai/codex#9077 — "Send message by default mid turn. queue messages by tab"](https://github.com/openai/codex/pull/9077)
- [Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli) / [Codex IDE docs](https://learn.chatgpt.com/docs/codex/ide)
- [Codex CLI TUI Shortcuts and Slash Commands reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/)
- [Codex CLI's Busy Week: Steer Mode, /fork — Dev Genius](https://blog.devgenius.io/codex-clis-busy-week-steer-mode-fork-and-7-releases-in-3-days-ece5c742923e)
- [openai/codex#31128 — queued follow-ups disappear](https://github.com/openai/codex/issues/31128) / [#30267 — resurrected message in Steer bar](https://github.com/openai/codex/issues/30267)
- [OpenAI community — "Queuing in vscode extension fails unpredictably (steers instead of queues)"](https://community.openai.com/t/queuing-in-vscode-extension-fails-unpredictably-steers-instead-of-queues/1376631)
- [OpenCode — Keybinds](https://opencode.ai/docs/keybinds/)
- [oc-ctrl-enter-force-import — interrupt-and-submit plugin](https://github.com/mynameistito/oc-ctrl-enter-force-import/tree/main)
- OpenCode queue issues (provenance caveat, see §3): [#5333](https://github.com/anomalyco/opencode/issues/5333), [#12707](https://github.com/anomalyco/opencode/issues/12707), [#13304](https://github.com/anomalyco/opencode/issues/13304), [#24472](https://github.com/anomalyco/opencode/issues/24472), [#8685](https://github.com/anomalyco/opencode/issues/8685), [#4821](https://github.com/anomalyco/opencode/issues/4821), [#6942](https://github.com/anomalyco/opencode/issues/6942)
- [Cursor Docs — Agent overview](https://cursor.com/docs/agent/overview) / [changelog 1.2](https://cursor.com/changelog/1-2) / [changelog 2.4](https://cursor.com/changelog/2-4)
- [Cursor forum — send queued message / bindings & setting](https://forum.cursor.com/t/cursor-agent-send-queued-message/147962), [queue ordering bug](https://forum.cursor.com/t/queued-messages-not-being-processed-in-order/135939)
- [Amp Owner's Manual](https://ampcode.com/manual)
- [Windsurf — Cascade overview](https://docs.windsurf.com/plugins/cascade/cascade-overview)
- [GitHub Docs — Steering and queueing (Copilot SDK)](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/steering-and-queueing)
- [github/copilot-cli#2055](https://github.com/github/copilot-cli/issues/2055), [#1857](https://github.com/github/copilot-cli/issues/1857), [#3344](https://github.com/github/copilot-cli/issues/3344); [microsoft/vscode#297145](https://github.com/microsoft/vscode/issues/297145), [#260330](https://github.com/microsoft/vscode/issues/260330)
- Prior repo research: `research/20260610_message_queuing_agent_runtimes.md`
