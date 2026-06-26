---
description: Restore autonomous /flow operation that /flow:pause halted
category: flow
allowed-tools: Read, Edit, Write, Glob, SlashCommand
argument-hint: '[issue-id to un-pause, or empty to restore all autonomy]'
---

# /flow:resume — restore autonomy

Undo a `/flow:pause`: $ARGUMENTS

Resume is the inverse of pause: it restores the autonomous surfaces pause halted:

1. **The Pulse cron.** Set `enabled: true` in the `.dork/tasks/flow-drain`
   frontmatter so the Pulse seat resumes claiming work on its schedule. (Pulse is
   the one mode that needs a running DorkOS server; the terminal drain does not.)
2. **The terminal drain.** If a paused `.dork/flow/auto-run.json` sentinel is still
   present (`active: false`), restart the drain with `/flow auto`, which rewrites the
   sentinel to `active: true` and continues from the ready queue. If no sentinel
   exists, there is no terminal drain to resume; start one with `/flow auto` when you
   want it.

## Un-pausing a specific item

To release a single item that `/flow:pause` parked with `agent/paused`, name its
identifier: via the `linear-adapter`, remove the `agent/paused` marker so the next
tick may advance it again. If the item was reassigned to a human or another agent
via the ownership policy, hand it back the same way (reassign on the tracker via the
`linear-adapter`).

## Re-enabling a single reconciler loop

If you silenced one loop via `loops.<id>.enabled: false` (see `/flow:pause`), flip
it back to `true` in `.agents/flow/config.json`. See the dials guide
(`docs/guides/flow/the-dials.mdx`).
