---
slug: plugin-reload-cache-cost
number: 260911-191240
created: 2026-09-11
status: ideation
---

# Plugin reloads that respect the prompt cache

**Slug:** plugin-reload-cache-cost
**Date:** 2026-09-11
**Source:** `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/` — filed there as a product question rather than an adoption

---

## Problem statement

You install a plugin from the marketplace while you have sessions open. DorkOS
does the obviously right thing: it tells every live session about the new
plugin, so the commands and skills it brings show up without anyone restarting
anything.

What nobody tells you is what that costs. Changing the tool list mid-conversation
throws away the work the model had already cached about that conversation. The
next thing you say makes it read the whole conversation again — you pay for those
tokens, and you wait for them. On a long session that is the most expensive
single moment of the day, and it is triggered by an action that felt free: you
clicked install.

Nobody sees a number, a warning, or a line in the transcript. The only symptom is
that the next reply is slower and the day's spend is higher than the work would
suggest. Someone running ten sessions pays it ten times for one install.

The reverse failure is just as real. Because the reload is silent and cheap-looking,
it is also used liberally — every plugin change refreshes every live session. If we
made it visible and expensive-looking, we would be tempted to stop doing it, and
then you would install a plugin and wonder why it did nothing.

So the question is not "should reloads be cheaper". It is: who decides to spend
this, and what do they see when it is spent.

## What the SDK now offers

`@anthropic-ai/claude-agent-sdk` 0.3.268 adds an option to the existing control
call:

- `Query.reloadPlugins({ holdOnCacheImpact })` — the CLI runs the same check the
  interactive `/reload-plugins` command makes. When applying the reload would
  change the session's tool list while the conversation's cache depends on it,
  **nothing is applied** and the response comes back with `held: true` plus a
  `cache_impact` object:
  - `mcp_servers_added`
  - `lsp_tool_change`
  - `estimated_cache_write_usd`
- Calling `reloadPlugins()` again without the option applies it anyway. So the
  protocol is two calls: ask what it costs, then decide.

Changelog entry: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`,
Features → "Plugins, skills, styles, settings", item 21 (and Performance, item 3).
Impact assessment: same directory, `impact-assessment.md`, "HIGH — `Query.reloadPlugins({ holdOnCacheImpact })`".

Where it would land in DorkOS. Every caller funnels through one method,
`reloadPlugins()` in `apps/server/src/services/runtimes/claude-code/messaging/runtime-cache.ts`,
which is what makes this tractable. Three things reach it:

1. `POST /api/sessions/:id/reload-plugins` (`routes/sessions.ts`) — the explicit ask.
2. `reloadCommandsForLiveSessions()` in `claude-code-runtime.ts` — the marketplace
   install path, fanning out to every session that still holds a reloadable query.
3. The `plugins` pin in `sessions/launch-live-settings.ts` — a warm process taking
   a new plugin set.

The impact assessment counts 23 `reloadPlugins` references across `apps/server/src`.
ADR-0239 is why they exist at all: DorkOS owns installing plugins to disk, the SDK
owns loading them, and the reload is the handshake between the two halves.

## Users

- **Kai** (`meta/personas/the-autonomous-builder.md`) — ten agents across five
  projects, and the person most exposed: he installs packages while work is in
  flight, and he is the one who notices spend he cannot account for. He does not
  want a dialog; he wants the number to exist and the default to be sane.
- **Ikechi** (`meta/personas/the-ai-native-founder.md`) — installs a plugin
  because something told him to. A modal about cache writes in dollars, MCP
  server counts and LSP tool changes is four ideas he has no use for. If he sees
  anything at all it is one sentence in plain words.
- **Priya** (`meta/personas/the-knowledge-architect.md`) — will want to know that
  the number came from the runtime and is an estimate, not a DorkOS guess dressed
  up as a fact.

## Options

### Option 1 — Leave the behavior, log the number

Pass `holdOnCacheImpact`, read `cache_impact`, immediately call again to apply,
and write what it cost to the log. Nothing changes for anyone using the app.

- **For:** honest internally, zero interface risk, one afternoon of work. It also
  gives us real numbers before we design around a guess.
- **Against:** the person still cannot act on it, which is the actual complaint.
  A log line is not a control panel.
- **Effort:** small.

### Option 2 — Quiet by default, visible when it matters

Always ask first. Under a small threshold, apply immediately and say nothing.
Over it, hold the reload and apply it at the next natural break in that session —
between turns, when nothing is waiting on it — and put one plain line in the
session saying the new plugin switches on after the current reply. An explicit
"apply now" stays available for someone who wants it immediately.

- **For:** matches how the product already treats noise (the background task bar
  already hides bash commands that finish in under five seconds rather than
  flashing them). The cost lands where it is cheapest, nobody is interrupted, and
  the expensive case is the only one that gets words.
- **Against:** a session can now be running a plugin set the disk no longer
  matches, for a bounded window. That state has to be honest — a plugin that is
  installed but not yet live in this session must never look broken.
- **Effort:** moderate. The call is one option; the work is the deferred-apply
  queue, the copy, and making the in-between state legible.

### Option 3 — Ask every time it costs anything

Hold the reload and show the person the choice with the estimate attached.

- **For:** maximum honesty, no spend without a decision.
- **Against:** the estimate is small and frequent. A question you answer the same
  way every time is a question that trains you to stop reading it, which is exactly
  the failure the approval-card work keeps guarding against. It also puts a dollar
  figure in front of Ikechi for a decision he cannot evaluate.
- **Effort:** moderate, and mostly in copy that will age badly.

## Recommendation

**Option 2.** The default should be that installing a plugin still just works and
costs nothing anyone notices; the exception is worth one sentence, not a dialog.
Holding to the next break is the part that makes it possible to be both cheap and
silent — the cost is real, but paid at a moment when nobody is waiting.

Ship Option 1's logging first inside the same piece of work, so the threshold in
Option 2 is chosen from measured reloads rather than from a number someone liked.

## Open decisions

Each of these is answerable in a sentence.

1. What is the threshold below which a reload applies silently — a dollar figure,
   or "no MCP servers added and no tool-list change"?
2. Is that threshold something an operator can see and change, or a constant?
3. What counts as the "next natural break" — the moment the current turn ends, or
   the next message the person sends?
4. Should a reload the person triggered by hand behave differently from one an
   agent triggered by installing something on its own?
5. Does the person ever see a dollar amount, or only "the agent will re-read this
   conversation"?
6. When a plugin is installed but not yet live in an open session, where does that
   show — in the session, on the marketplace item, or both?
7. Codex and OpenCode sessions have no plugin reload at all. Do they say something
   ("this applies to your next session") or stay quiet?
8. Does a spent reload earn a record in the activity feed, or is the session line
   enough?

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` — the version bump, PR **#1798**. The
  option does not exist below 0.3.268, so nothing here can start until that lands.
- ADR-0239 (plugin activation through the SDK's own plugin option) — the reason the
  reload handshake exists and the constraint any answer here has to respect.

## Out of scope

- How plugins are installed, updated or removed. This is only about telling a
  live session that the set changed.
- The MCP server set on a session (`setMcpServers`), which has its own path and
  its own cost.
- Making the estimate exact. It is the runtime's estimate and we report it as one.
- Cross-runtime parity. Only the claude-code runtime has plugins to reload today.

## Risks

- **A held reload is a session running yesterday's plugins.** If that state is not
  visible, the failure mode is worse than the one we are fixing: the person
  installs something, nothing happens, and nothing explains why.
- **Two control calls instead of one.** Every reload now costs a second round trip
  on a channel that already has a timeout and a documented habit of going
  unanswered (`sessions/bounded-control.ts`). The "ask, then apply" pair must
  degrade to today's behavior when the second call never lands.
- **A silent threshold is still spending someone's money.** Whatever number we
  pick, it should be discoverable by someone who goes looking — an honest default
  is not the same as a hidden one.
- **The estimate can be wrong.** It is a forecast from the runtime, and showing it
  as a firm price would be the kind of false precision this codebase avoids
  elsewhere.
- **Fan-out multiplies everything.** One install touches every live session, so a
  per-session decision becomes ten decisions unless the design answers once.
