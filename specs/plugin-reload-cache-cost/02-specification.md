---
slug: plugin-reload-cache-cost
id: 260911-191240
created: 2026-09-12
status: specified
---

# Plugin reloads that respect the prompt cache

**Status:** Specified
**Date:** 2026-09-12
**Ideation:** `specs/plugin-reload-cache-cost/01-ideation.md`
**Decisions taken with the operator:** 2026-09-12

## Intent

Installing a plugin while sessions are open should keep working the way it does
today, and should stop quietly spending money nobody chose to spend. The runtime
can now tell us what a reload will cost before it applies one
(`Query.reloadPlugins({ holdOnCacheImpact })` → `held: true` plus
`estimated_cache_write_usd`). DorkOS uses that answer to decide when to pay: a
cheap reload applies at once and says nothing, an expensive one waits for a
moment when the payment is free, and a person who asked for a reload by hand
never waits at all.

## Framing correction

The ideation's Option 2 said a held reload should be applied "at the next
natural break — between turns, when nothing is waiting on it". That saves
nothing. The prompt-cache write is paid on the **next turn** whenever the tool
list has changed, whether the change was applied between turns or during one.
Deferring by one turn moves the bill; it does not cancel it.

**The only free moment is a cold cache.** When a session has sat idle past the
prompt cache's lifetime, the cached prefix is gone anyway, so the next turn
re-reads the conversation whether or not the plugin set changed. Applying the
reload then costs nothing extra. Everywhere below, "next natural break" means
"once the cache is cold", never "after this turn" and never "on the next
message".

Two facts settled while deciding bound the blast radius:

- Every launch rebuilds `options.plugins`, so a session that starts a fresh
  process per turn picks up a newly installed plugin on its next turn with no
  reload at all. The hold only ever matters for a **warm process** (persistent
  session mode).
- Room turns run on the agent's own session through the same path, so a room
  agent takes a new plugin at its next quiet stretch (warm) or its next message
  (fresh). Rooms need no special case.

## Resolved design

### 1. Threshold — a small dollar cap on the runtime's estimate

A reload whose `estimated_cache_write_usd` falls at or below a fixed dollar cap
applies immediately; above it, the reload is held. Option 1's
measurement/logging ships **first inside the same piece of work**, and the cap's
number is chosen from those measured reloads rather than guessed.

_Reason:_ the runtime already answers in dollars, so the threshold should be
expressed in the same unit the decision is actually about.

### 2. Threshold visibility — a named constant, documented

The cap is a named exported constant in the claude-code runtime with a TSDoc
block that says where its value came from. There is no config field and no
environment override.

_Reason:_ an honest default is discoverable by anyone who reads the source,
and a knob nobody should turn is a knob that should not exist.

### 3. Natural break — the cache is cold

A held reload is applied when the session has been idle past the prompt cache
lifetime, so the next turn re-reads the conversation regardless.

_Reason:_ that is the only moment the reload is genuinely free (see the framing
correction).

### 4. Hand-triggered reloads bypass the threshold

`POST /api/sessions/:id/reload-plugins` — the reload a person asked for —
applies immediately whatever it costs. Install fan-out
(`reloadCommandsForLiveSessions`) and the warm-process plugin pin go through the
threshold.

_Reason:_ someone who asks for a thing has already decided to pay for it; the
threshold exists for the spend nobody asked for.

### 5. No dollar amount in the session

The session line says only that the plugin switches on after a short pause. The
estimate goes in the activity record and in the log, never in session prose.

_Reason:_ a dollar figure is a number Ikechi cannot act on and Kai can find
where the other numbers already live.

### 6. Held state shows in the affected session only

One quiet system line in the session whose reload is held. Nothing appears on
the marketplace item.

_Reason:_ the marketplace item is installed and correct; the only thing that is
temporarily out of date is one conversation.

### 7. Codex and OpenCode stay quiet

Neither runtime says anything about plugin reloads. They pick a new plugin set
up at their next launch, as they always have.

_Reason:_ a message about a mechanism a runtime does not have is noise, not
honesty.

### 8. Activity record for held or above-threshold reloads only

A held reload and an above-threshold reload each earn one activity record
carrying the estimate. Below-threshold reloads are silent everywhere except the
log.

_Reason:_ the feed should record the spend that was decided, not every routine
refresh.

### 9. A held reload has a maximum hold

A reload held for cache reasons is applied anyway after a bounded wait of about
fifteen minutes, paying the cache write.

_Reason:_ a room agent that never goes quiet must not run stale plugins for
hours; a bounded wrong price beats an unbounded wrong plugin set.

## Affected files

- `apps/server/src/services/runtimes/claude-code/messaging/runtime-cache.ts` —
  `reloadPlugins()` (line ~673) is the single funnel every caller passes
  through. It gains the two-call protocol: ask with `holdOnCacheImpact`, read
  `cache_impact`, then either apply or record a hold. Both calls stay inside the
  existing `requestWithinBound` / `PLUGIN_RELOAD_ACK_TIMEOUT_MS` bound.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` —
  `reloadCommandsForLiveSessions()` (line ~673, called from line ~649) is the
  install fan-out and the main threshold consumer; it also owns the per-session
  hold registry and the cold-cache / maximum-hold timer that drains it.
- `apps/server/src/services/runtimes/claude-code/sessions/launch-live-settings.ts` —
  the `'plugins'` pin case (line ~183) drives `query.reloadPlugins()` on a warm
  process and takes the same threshold.
- `apps/server/src/routes/sessions.ts` — `POST /api/sessions/:id/reload-plugins`
  passes an explicit "apply now" so the hand-triggered path skips the threshold.
- `apps/server/src/services/activity/activity-service.ts` — the record written
  for a held or above-threshold reload, carrying the estimate.

## Acceptance criteria

Written as behavior somebody can observe.

1. Installing a plugin while a warm session is open, where the runtime's
   estimate is at or below the cap, changes nothing a person can see: the
   commands appear, no session line is written, no activity record appears.
2. The same install, where the estimate is above the cap, leaves one quiet
   system line in that session saying the plugin switches on after a short
   pause. The line contains no dollar amount.
3. That held session takes the new plugin set the first time it is used after
   sitting idle past the cache lifetime, and no sooner.
4. A session held for about fifteen minutes without ever going idle takes the
   new plugin set anyway.
5. `POST /api/sessions/:id/reload-plugins` applies immediately and writes no
   held-state line, whatever the estimate says.
6. Every held or above-threshold reload leaves exactly one activity record
   carrying the runtime's estimate, described as an estimate. Below-threshold
   reloads leave none.
7. A session that starts a fresh process per turn shows the new plugin on its
   next turn with no reload, no line and no record.
8. When the second control call never lands, the reload behaves exactly as it
   does today — applied best-effort, error swallowed by the caller's existing
   catch — and nothing is left permanently held.
9. Codex and OpenCode sessions produce no plugin-reload line, record or log
   entry.
10. The plugin is never described as broken or failed while a reload is held.

## Test plan

- **Unit, `runtime-cache.ts`:** a fake `Query` returning `held: true` with an
  estimate above and below the cap; assert the second apply call is made in one
  case and withheld in the other, and that both stay within the bound.
- **Unit, degradation:** the second control call times out; assert today's
  behavior is preserved and no hold is left registered.
- **Unit, fan-out:** a hold registry with several live sessions; assert one
  install produces one decision per session and that the cold-cache drain and
  the fifteen-minute ceiling each apply the held reload exactly once.
- **Unit, route:** the hand-triggered route applies over the cap and writes no
  held line.
- **Unit, activity:** one record per held/above-threshold reload with the
  estimate present; none for a below-threshold reload.
- **Copy test:** the session line's exact text is pinned, and a test asserts it
  contains no currency symbol or numeric amount.
- **Measurement:** the logging half lands first, and the PR reports the
  distribution of `estimated_cache_write_usd` over real reloads that the chosen
  cap is derived from.

## Out of scope

- How plugins are installed, updated or removed.
- The MCP server set on a session (`setMcpServers`), which has its own path and
  its own cost.
- Making the estimate exact — it is the runtime's forecast and DorkOS reports it
  as one.
- Cross-runtime parity; only claude-code has plugins to reload.
- Any config field, per-agent setting or UI control for the threshold.

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` (PR #1798) — the option does not
  exist below 0.3.268.
- ADR-0239 — plugin activation through the SDK's own plugin option, the reason
  the reload handshake exists.
