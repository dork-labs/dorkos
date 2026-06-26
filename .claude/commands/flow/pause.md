---
description: Halt every autonomous /flow mode from one place (drain sentinel + Pulse cron)
category: flow
allowed-tools: Read, Edit, Write, Glob
argument-hint: '[issue-id to reclaim, or empty to halt all autonomy]'
---

# /flow:pause — halt autonomy

Stop the `/flow` loop from advancing on its own: $ARGUMENTS

Halting every mode is ONE action: pause toggles BOTH autonomous surfaces together
so nothing keeps running behind your back:

1. **The drain sentinel.** If `.dork/flow/auto-run.json` exists (a live `/flow auto`
   terminal drain), set its `active` to `false`. The `flow-loop.mjs` Stop hook then
   allows the session to stop at the next gate instead of looping to the next item.
2. **The Pulse cron.** Set `enabled: false` in the `.dork/tasks/flow-drain`
   frontmatter, so the Pulse seat stops claiming work on its schedule.

Report what changed (sentinel paused, cron disabled) and what was in flight. To see
the in-flight items before or after pausing, use `/flow:status`.

## Reclaiming or redirecting a specific item

To stop ONE running item rather than all autonomy, name its identifier. Via the
`linear-adapter`, apply the **`agent/paused`** marker to that item. A running tick
honors `agent/paused` **at stage boundaries**: it finishes no further stage, stops
advancing the item, and releases the claim cleanly (drops `agent/claimed`) rather
than abandoning a half-done stage. To hand the item to a human or another agent
instead, use the ownership-policy reassignment (reassign on the tracker via the
`linear-adapter`); the loop's `classifyOwnership` then treats it as not-ours.

## Finer-grained control (a config edit, not a command)

To disable or reprioritize ONE reconciler loop rather than pausing everything, edit
the `loops` config in `.agents/flow/config.json`: `loops.<id>.enabled: false`
silences that loop (e.g. `loops.triage`, `loops.hygiene`), and `loops.<id>.priority`
reorders the tick. See the dials guide (`docs/guides/flow/the-dials.mdx`). Resume
everything with `/flow:resume`.
