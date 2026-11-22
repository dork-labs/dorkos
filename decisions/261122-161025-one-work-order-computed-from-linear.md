---
id: 261122-161025
title: Compute one work order from Linear with one function
status: proposed
created: 2026-11-22
spec: null
superseded-by: null
amends: null
---

# 261122-161025. Compute one work order from Linear with one function

## Status

Proposed. Asked for by the operator on 2026-11-22 (#proj-dork-architecture, 09:54 CT) and designed in [research/20261122_work-sequencing.md](../research/20261122_work-sequencing.md). The PM, who owns priorities, signs off the method before anything in it writes to Linear.

## Context

Six things decide what DorkOS works on next: the filing rubric, the PM's rules and decision log, a retired fix-queue file, the flow plugin's picker, DorkOS Code's lane briefs and room asks, and the heavy-job line. On 2026-11-22 they gave four different answers to "what is next", and the autonomous picker gave none: it hides every item without an `agent/ready` label, only 4 of the 83 open Urgent or High issues had one, and at the open-PR cap it considers only Urgent items. The order among Musts lived in a chat log, not in a field.

## Decision

We will have one function that ranks work: `flow next` in the flow plugin, extended from today's `selectDispatch`. It reads only Linear fields (priority, state, labels, estimate, due date, relations, project status, priority, target date and relations, created time) and returns the same order for the same data, with a reason per item. Projects rank first (Started projects feed the order, Planned ones queue, and a config cap limits how many are Started), then issues in bands: pinned, Urgent, release gate, confirmed Must (High in Todo), Should, Could; inside a band by due date, what it unblocks, its project's rank, type, size, age and number. A blocked item does not rank and its blocker inherits its place; the only override is a `pin` label with a reason comment, set only by Dorian or the PM and shown at the very top, above Urgent (Dorian's call, Nov 22). DorkOS Code, the PM and `/flow` all call this function and nothing else sorts work.

## Consequences

### Positive

- A pin can never make a fire invisible: whenever an Urgent item ranks below a pin, the output opens with a one-line "Urgent below pins" banner. A display rule, not a ranking rule (the PM, Nov 22).
- One answer to "what's next", the same from a person, an agent and Linear, with the reason beside it: a saved Linear view shows the function's order, rewritten from it on a schedule, and a drift check plus a determinism test keep them equal.
- Judgment moves into fields a person can see and change; a chat message can no longer reorder work.
- Unready work is visible at the top instead of hidden, so triage happens to the right item.
- Projects are sequenced by the same method as issues, with a cap that is a number in config.
- The fix queue stays retired, and the heavy-job line orders machine time only.

### Negative

- The fields have to be kept: project priorities, target dates, a few relations and three labels, with a one-time pass and a Monday habit.
- Writing the order back into Linear's manual sort order fights anyone who drags in that view; the view is read-only by convention, a drag is reported to the PM by the drift check, and the next hourly run overwrites it.
- The ladder has eight keys (the band and seven inside it). Each is one field, but the sentence that explains it is long.
- One rule of the PM's ("user-facing before team-productivity") has no field and is not modelled until a label group is added.
