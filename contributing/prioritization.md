# Filing and prioritizing work (MoSCoW)

Every DOR issue is triaged the moment it is filed. Whoever files it (a person, an agent, a skill or a schedule) gives it a MoSCoW priority, a size and a project, and checks it is not a duplicate. Nothing waits in Triage for a sweep.

This guide is the one rubric. The `/flow` plugin's `flow create`, triage and groom follow it; every agent that files issues points here. DOR-4546 introduced it (Nov 2026), after the backlog grew by about 1,000 issues in eight weeks because issues were filed faster than anyone triaged them.

## The four buckets

MoSCoW maps onto **Linear's own priority field**. Never use a label for it.

| Bucket     | Linear priority                    | Means                                                          | Where it goes                                            |
| ---------- | ---------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| **Must**   | High (Urgent only if broken now)   | Needed for the roadmap item being built now. Worked this week. | Its project, **Todo**, once the coordinator confirms it  |
| **Should** | Medium                             | Important, but there is a workaround or it can wait a week.    | Its project, **Backlog**, re-checked every Monday        |
| **Could**  | Low                                | Nice to have.                                                  | Its project, **Backlog**, closed after 60 days untouched |
| **Won't**  | not filed, or Canceled with reason | Not worth doing. Never kept "just in case".                    | Closed now, with a one-line reason                       |

**Most items are Should.** Must has to stay rare enough to mean something: if more than about one item in five you file is a Must, your bar is too low. When in doubt between two buckets, pick the lower one.

**Urgent** is only for something broken right now: `main` red, an open security hole, data loss, or broken UX that blocks a user with no workaround. Urgent work starts today, not this week.

**A cycle is one week.** **The coordinator confirms every Must** (the Linear priority, not a Security Must on a PR review, which blocks that PR whatever the priority): a filer may suggest Must (or Urgent); the coordinator (DorkOS Code) confirms it or lowers it. Until then it counts as a Should.

### Must (High)

- A feature in the roadmap item being built now shows the wrong agent's name on its main card.
- A migration that loses rows on upgrade for some installs (Urgent if a release already shipped it).
- The merge queue ejects every PR on one flaky required check, so nothing lands.
- A security finding that lets an agent read another agent's connection, on a released build (Urgent).
- An item `meta/ROADMAP.md` lists as being built now, with no other ticket carrying it.

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

- **Must:** its project, Todo, worked this week, once the coordinator confirms it.
- **Should:** its project, Backlog. Every Monday, the coordinator re-checks the Should list: promote to Must, keep, or drop to Could.
- **Could:** its project, Backlog. The groom closes it as Canceled after **60 days with no update** (flow's `couldExpiryDays` setting, default 60), with a comment saying it closed as a stale Could and can be reopened if it matters. Reopening is cheap; carrying it forever is not. A Could labelled `security` or `needs-security-design` never expires (flow's `neverExpireLabels`): keep that label on every security Could, so a known risk never drops off the list unseen.
- **Won't:** Canceled now, with a one-line reason.

The expiry applies only to an issue a person or agent deliberately marked Could. Never bulk re-bucket, demote or close old issues with a script.

## How the order is computed

`flow order` (the `/flow` plugin) is the only answer to "what's next". It ranks the open DOR issues from Linear fields alone, so the same data always gives the same list. Nobody keeps a second list: not a brief, a digest, a chat or a file in `.temp/`. If an item sits in the wrong place, change the field that put it there, never the list.

```bash
flow order --projects          # the project order: Started projects now, Planned next
flow order -n 5 --json         # the top five issues, each with its reasons and the run time
flow order --why DOR-1234      # why one issue sits where it does, and which field would move it up
flow order --rank-of DOR-1234  # its place number, or why it does not rank
```

`flow next` stays the drain's picker. With `dispatch.ladder: "v2"` in `.agents/flow/config.json`, it picks from the same order: the first issue that is ready and not held. At the PR or WIP cap an issue keeps its place there, marked `held: PR cap`: the caps stop new work from starting, they do not change the order.

### Projects come first

- Only **Started** projects feed the order. Planned projects wait as "next", and so do their issues, except Urgent ones and release gates. Paused and Backlog projects are out.
- At most **6** projects are Started at once: `projects.startedCap` in `.agents/flow/config.json`. Dorian and the PM own that number; it changes only on their word. Over the cap, `flow order` says so and names the lowest projects. It never changes a project's status itself.
- Projects rank by pin, then priority, what they wait on (a project waiting on another open project can't start), remaining work (smaller first), created time and name. A project's target date is not a key: we sequence for the best product, not for dates we set ourselves.

### Bands

Every issue falls into one band, and a higher band always comes first.

| Band             | Linear fields                                                   |
| ---------------- | --------------------------------------------------------------- |
| **Pin**          | Label `pin` (its reason goes in a `pin:` comment). Above Urgent |
| **Urgent**       | Priority Urgent                                                 |
| **Release gate** | Label `release-gate`: needed by the next release                |
| **Must**         | High, in Todo (the PM confirmed it)                             |
| **Should**       | Medium, or High still in Backlog (not confirmed yet)            |
| **Could**        | Low                                                             |

Inside a band, in this order: due date (earliest first, none last; only for a real outside deadline, such as a certificate expiring or a vendor cutoff, never one of our own), its project's rank (Urgent skips this one: broken is broken), how many open issues it unblocks (more first), size (smaller first, unsized last), age (older first), then the issue number. The key list is `dispatch.orderKeys` in the flow config.

**Inheritance.** A blocked issue does not rank. Its blocker takes the better of its own place and the place of what it blocks, through any number of steps, and the output says `inherits DOR-x's place`.

**Readiness is an output, not a filter.** Every ranked issue says whether it is ready and, if not, why: needs a size, needs a done-when, needs a decision, blocked by another issue. An unready top issue gets made ready first, or goes to a person with `agent/needs-input`. It is never skipped in silence. An agent still needs `agent/ready` before it starts building.

### What does not rank

Each of these is listed with its reason, so nothing drops out unseen:

- **In Progress or In Review:** listed after the order, with their state, never re-ranked.
- **Needs triage:** Triage state, or no priority or project. The missing field is named. Urgent issues and release gates rank without a project. An issue with no size still ranks, marked "needs a size".
- **Waits for project:** its project is not Started, or is a Started project that waits on another open project.
- **Dorian's list:** the label `owner/dorian` on the issue or its project takes it out of the agent order. Only Dorian or the PM sets it.

### Pins

A pin is the one way to move an issue against its fields. The `pin` label puts it in the pin band; the reason goes in a comment starting `pin:`. Only Dorian sets pins (`order.pinSetters` in the flow config holds his Linear user). The output shows each pin with its reason, who added it and when, and the groom flags a pin with no reason or one added by anyone else.

When an Urgent issue ranks below a pin, the output opens with one line: `Urgent below pins: DOR-x, DOR-y`. The banner changes nothing in the order. It keeps a fire from hiding under a pin.

### Where Security ranks

- An exploitable hole with an outsider in the attack is **Urgent**.
- A Security issue at High with a due date (a real outside deadline, such as a disclosure date) is a **Must** in any state except Triage, and ranks by that date.
- The `Urgent below pins` banner names Security's Urgent issues too.

### The Linear view

The "What's next" view in Linear (team DOR) shows the `flow order` list. A schedule rewrites its order every hour with `flow order --write-order`. Nobody drags items in that view. `flow order --check-order` compares the view with the function and fails when they differ. A difference is reported to DorkOS Code, then overwritten, because the fields are the truth.

### Who can change the order

The trust boundary is write access to Linear. Anyone who can edit a field can move an issue, and every agent writes to Linear as the same Linear user, so Linear cannot tell agents apart. Three things guard it:

- **Grants:** each agent's DorkOS grants on the Linear connection decide which chats can write priorities and labels. Only Dorian's and the PM's chats should hold them.
- **The pin check:** the groom (GRM-17) reports any pin added by someone outside `order.pinSetters`.
- **The drift alarm:** `flow order --check-order`.

A wrong field only sends effort to the wrong place. It grants no tool, no trust level, no secret and no way to merge.

## Cleaning the existing Backlog: a scalpel, not a hatchet

Each weekly cycle, the coordinator reviews **one** project's Backlog. It closes an issue only with a written reason on that issue: shipped (name the PR), duplicate (set the relation first), or Won't (say why). A ticket that shipped in part is rewritten to what remains, not closed.

## Where this is enforced

- **`flow create`** (the `/flow` plugin) refuses an item missing a field and names what is missing, runs the duplicate search, and sets the project.
- **`/flow:triage` and the daily `flow-triage` schedule** apply the buckets to anything still in Triage.
- **`/flow:groom`** closes stale Could items and flags project-less ones.
- **`flow order`** ranks the work; see [How the order is computed](#how-the-order-is-computed).
- **Agents** that file issues read this file through the shared filing rules in their own instructions.
