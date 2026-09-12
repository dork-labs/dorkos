# Implementation Summary: Plugin reloads that respect the prompt cache

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** `specs/plugin-reload-cache-cost/02-specification.md`
**Tracker:** none — shipped directly from the spec.

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

**PR #1819** — installing a plugin while agents are busy no longer forces every open
chat to re-read its whole conversation right away.

An agent keeps a copy of the conversation ready so it does not re-read everything each
time you speak. Adding a plugin can change its tools, which throws that copy away. One
click on Install used to charge that rebuild to every open chat at once.

- A **cheap** reload — a short chat, or one where nothing the agent uses would
  change — applies at once, exactly as before.
- An **expensive** one waits. DorkOS re-asks the agent every five minutes whether
  switching the plugin on has become free yet, and applies it the moment it has. A
  fifteen-minute ceiling ends the wait and applies it anyway, so nothing runs on
  yesterday's plugins for long.
- A reload **a person triggers by hand** always applies immediately, whatever it costs.
- Every reload that cost something lands in the **Activity feed** with the size of the
  conversation, how long it waited, and whether it ended up free. Free reloads stay
  silent.

Every cost check writes one debug line — session, held, context tokens, threshold and
the three `cache_impact` fields — so a week of debug logging produces the distribution
that sets the real threshold.

## Accepted deviations from the spec

All three are already recorded in the 02's own addendum (2026-09-12, at implementation);
they are repeated here in short.

- **The threshold is a token count, not a dollar figure.** The spec and the upgrade
  notes both said the held response carries `estimated_cache_write_usd`. It does not —
  that field belongs to the model-switch hook inputs, verified against `sdk.d.ts`,
  against `sdk.mjs` (zero occurrences) and against the CLI binary's own schema.
  `cache_impact`'s three real fields are set by **every** held reload, so they cannot
  separate cheap from expensive. What can is the size of the conversation being
  re-read, which DorkOS already knows for free. Shipped as
  `PLUGIN_RELOAD_SILENT_TOKENS = 25_000`, a placeholder until measured. Cost is monotone
  in tokens, so the cap orders reloads exactly as a dollar cap would.
- **There is no quiet line in the session** (decision 6, not honored). The only
  per-session channel a background path can reach is `system_status`, which is absent
  from `RECORDED_EVENT_TYPES` and rendered only as a transient strip inside an
  in-progress turn. Every durable notice mechanism that exists is room-shaped and needs
  a `roomId`, which a plain chat has none of. Rather than push a line nobody would read,
  the implementation emits none and the Activity feed carries the fact instead.
- **The moment is asked for, not assumed** (decision 3). The first draft applied held
  reloads after five minutes idle. `Options.promptCacheTtl` is unset, and unset means
  automatic — one hour on a Claude subscription inside its limits, five minutes on an
  API key, Bedrock, Vertex or Foundry. On the signed-in path that rule would have paid
  for a rebuild fifty-five minutes out of sixty and filed a record calling it free. So
  nothing asserts coldness: the scheduler re-issues the same
  `reloadPlugins({ holdOnCacheImpact })` call, and `held: false` is the runtime saying it
  has just applied the reload because nothing was left to disturb.

## Four races settled explicitly

Adversarial review found four things that can land during an ask, and the obvious code
got three of them wrong:

- A hand trigger during an in-flight recheck **billed one reload twice**; only the
  record's owner accounts for it now.
- An eviction during a recheck, or during the ceiling's apply, **recorded a cost nobody
  pays** — the rebuild is only ever charged on the session's next turn.
- An **unanswered** ask was treated as a dead session, stranding the reload for the life
  of that warm process. An unanswered ask now keeps the wait; a genuinely gone session
  throws `PluginReloadSessionGoneError` and drops it.
- At the ceiling a failure stays terminal, or retrying an unanswered ask would make the
  ceiling unbounded.

## Follow-ups

- Replace the placeholder threshold with the measured value once the debug distribution
  exists (decision 9's measurement).
- A durable per-session notice kind is its own piece of work; decision 6 becomes
  possible once the session event store has one.
