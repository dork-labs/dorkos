# Filing and prioritizing work (MoSCoW)

Every DOR issue is triaged the moment it is filed. Whoever files it (a person, an agent, a skill or a schedule) gives it a MoSCoW priority, a size and a project, and checks it is not a duplicate. Nothing waits in Triage for a sweep.

This guide is the one rubric. The `/flow` plugin's `flow create`, triage and groom follow it; every agent that files issues points here. DOR-4546 introduced it (Nov 2026), after the backlog grew by about 1,000 issues in eight weeks because issues were filed faster than anyone triaged them.

## The four buckets

MoSCoW maps onto **Linear's own priority field**. Never use a label for it.

| Bucket     | Linear priority                    | Means                                                         | Where it goes                                            |
| ---------- | ---------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| **Must**   | High (Urgent only if broken now)   | Needed for the current milestone or launch. Worked this week. | Its project, **Todo**, once the PM confirms it           |
| **Should** | Medium                             | Important, but there is a workaround or it can wait a week.   | Its project, **Backlog**, re-checked every Monday        |
| **Could**  | Low                                | Nice to have.                                                 | Its project, **Backlog**, closed after 60 days untouched |
| **Won't**  | not filed, or Canceled with reason | Not worth doing. Never kept "just in case".                   | Closed now, with a one-line reason                       |

**Most items are Should.** Must has to stay rare enough to mean something: if more than about one item in five you file is a Must, your bar is too low. When in doubt between two buckets, pick the lower one.

**Urgent** is only for something broken right now: `main` red, an open security hole, data loss, or broken UX that blocks a user with no workaround. Urgent work starts today, not this week.

**A cycle is one week.** **The PM confirms every Must** (the Linear priority, not a Security Must on a PR review, which blocks that PR whatever the priority): a filer may suggest Must (or Urgent); @dorkos-pm confirms it or lowers it. Until then it counts as a Should.

### Must (High)

- A feature in the current launch milestone shows the wrong agent's name on its main card.
- A migration that loses rows on upgrade for some installs (Urgent if a release already shipped it).
- The merge queue ejects every PR on one flaky required check, so nothing lands.
- A security finding that lets an agent read another agent's connection, on a released build (Urgent).
- A promised launch-scope item (in `meta/ROADMAP.md`) with no other ticket carrying it.

### Should (Medium)

- A settings toggle that works but says the wrong thing after a restart.
- A flaky test that fails one run in twenty and is not a required check.
- A refactor that shrinks a file past the 500-line limit.
- A server error message that names an internal id instead of the agent.
- Docs that describe last month's behavior of a shipped feature.

### Could (Low)

- A keyboard shortcut for an action that already has a button.
- An empty state that could say a bit more.
- A small speed-up nobody has complained about.
- A dev-only script that would save a minute a week.

### Won't (Canceled)

- A follow-up that restates a ticket already open: comment there instead.
- An idea for a surface the roadmap retired (for example, the Obsidian plugin).
- A "maybe someday" with no user, no proof and no done-when.
- A test-only or junk ticket.

## What every issue has at filing

Missing any of these means **don't file it yet**: ask the one person who knows, or decide yourself.

1. **Type:** one of `Bug`, `Feature`, `Improvement`, plus the `/flow` `type/*` label when flow files it.
2. **MoSCoW priority:** the Linear priority from the table above.
3. **Size:** a Linear estimate. `1` under an hour, `2` half a day, `3` a day, `5` a few days, `8` about a week. Anything bigger is a project or an epic: split it.
4. **Project:** every issue belongs to one project. No project-less Backlog. If none fits, use the current maintenance project.
5. **Proof:** what you saw. A log line, `file:line`, the failing command, or the steps to reproduce. "I think" is not proof.
6. **Done when:** one to three checkable lines saying what is true when it is finished.
7. **Duplicate check:** search open DOR issues for the key words first. If a near match exists, **comment on it** with your new detail instead of filing. Say in the description what you searched for.

**One parent, not ten children.** Small follow-ups from one review or one PR go in **one** issue with a checklist, not one issue each.

## After triage

- **Must:** its project, Todo, worked this week, once @dorkos-pm confirms it.
- **Should:** its project, Backlog. Every Monday, @dorkos-pm re-checks the Should list: promote to Must, keep, or drop to Could.
- **Could:** its project, Backlog. The groom closes it as Canceled after **60 days with no update** (flow's `couldExpiryDays` setting, default 60), with a comment saying it closed as a stale Could and can be reopened if it matters. Reopening is cheap; carrying it forever is not. A Could labelled `security` or `needs-security-design` never expires (flow's `neverExpireLabels`): keep that label on every security Could, so a known risk never drops off the list unseen.
- **Won't:** Canceled now, with a one-line reason.

The expiry applies only to an issue a person or agent deliberately marked Could. Never bulk re-bucket, demote or close old issues with a script.

## Cleaning the existing Backlog: a scalpel, not a hatchet

Each weekly cycle, @dorkos-pm reviews **one** project's Backlog. It closes an issue only with a written reason on that issue: shipped (name the PR), duplicate (set the relation first), or Won't (say why). A ticket that shipped in part is rewritten to what remains, not closed.

## Where this is enforced

- **`flow create`** (the `/flow` plugin) refuses an item missing a field and names what is missing, runs the duplicate search, and sets the project.
- **`/flow:triage` and the daily `flow-triage` schedule** apply the buckets to anything still in Triage.
- **`/flow:groom`** closes stale Could items and flags project-less ones.
- **Agents** that file issues read this file through the shared filing rules in their own instructions.
