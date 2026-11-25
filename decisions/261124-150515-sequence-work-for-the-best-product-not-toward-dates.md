---
id: 261124-150515
title: Sequence work for the best product, not toward dates; a milestone is an outcome, never a date
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends:
  [
    261006-235238,
    261006-235239,
    261006-235240,
    261006-235241,
    261006-235242,
    261015-042933,
    261015-125850,
    261018-124422,
    261122-173853,
    261122-161025,
  ]
---

# 261124-150515. Sequence work for the best product, not toward dates; a milestone is an outcome, never a date

## Status

Accepted (operator decision, 2026-11-24: "Work towards the best product, not towards arbitrary dates. We'll sequence work in a way that will give us the best overall outcome and product, and we'll work towards that as fast as we can.").

**Amends** (each stays Accepted; only the named clause is retired):

- [261006-235238](261006-235238-one-dorkos-server-in-every-size.md), [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md) and [261015-125850](261015-125850-this-computer-and-other-devices.md): every launch date (late November 2026, December 8, late January 2027, early February 2027) and the December 8 date for the Community Space are retired. What each record decided to build stands. "Launch scope" now reads as "the next set of work, in order". The "at launch" and "after launch" order in rule 7 of 261015-042933 (which runtimes a cloud agent computer runs first) is retired as a date; the order itself stands.
- [261006-235239](261006-235239-people-and-agents-hold-equal-accounts.md), [261006-235240](261006-235240-one-message-system.md), [261006-235241](261006-235241-shared-docs-are-yjs-documents.md) and [261006-235242](261006-235242-everything-is-a-plugin.md): the status line of each calls its work "after-launch work". That phrase is retired. Each decision stands, and its place in the order is in `meta/ROADMAP.md`.
- [261018-124422](261018-124422-one-program-before-launch.md): "before launch" and "after launch" are retired as reasons for an order. The order of its steps stands wherever one step needs another.
- [261122-173853](261122-173853-one-space-model.md): "after launch" is retired as the gate on the private space becoming a tenant. Its order stands: the shared HTTP kit, the member checks, the PGlite measurement and its gates, then the move one area at a time, agents last. Its freeze stops being a date: see Decision.
- [261122-161025](261122-161025-one-work-order-computed-from-linear.md): a project's target date is no longer a ranking key. Projects rank by pin, priority, what they wait on, remaining work, age and name. An issue's due date stays a key, and may only hold a real outside deadline.

## Context

DorkOS planned around two dates: a Community Space opening on December 8, 2026 and a launch in early February 2027. The launch date moved three times in October 2026, and each move rewrote the roadmap, the specs and the tracker. Work was split into "before launch" and "after launch", so the order was decided by what could fit before a date, not by what makes the product best: the work graph, the member checks and the one message system were all pushed "after launch" for schedule reasons alone. A freeze, the tracker's target dates and a week-by-week build table all hung on those dates. No date was promised in public: the site, the docs and the app say only "coming".

## Decision

We will sequence work by what gives the best product, and do it as fast as we can. We will not plan, rank or describe work by a date or by "the launch".

- **One ordered list.** The roadmap is one list in build order. An item sits where it does because of what it needs and what it unlocks, and the reason is written beside it.
- **A milestone is an outcome.** It has a name that says what a person can do ("the Community Space is open", "the full app on the web takes sign-ups") and a short, fixed list of checks. It is reached when the checks pass. It has no date.
- **Claims follow what is built.** The demo-claim gate stands: nothing unbuilt is ever said to work. Its classes are named by state (built today, still unverified, next, later), not by launch. The product is an "early alpha", not "pre-launch".
- **Dates that stay.** A real outside deadline (a certificate that expires, a vendor that shuts something off, a law) keeps its date, with the reason on the issue. A Security item at High whose due date is a real outside deadline (for example a disclosure date) is a confirmed Must (added 2026-11-24 with the work-order lead). Facts about the past keep their dates. Decision records and dated research are not rewritten.
- **The tracker.** No project has a target date, and no project or initiative is named for a date or a launch. An issue has a due date only for an outside deadline.
- **A freeze is tied to an event.** A freeze names what it protects and the event that ends it, never a calendar day. The one-space-model freeze on `services/spaces`, `apps/space`, the community wire and `spaces/migrate.ts` now holds until the Community Space has opened and its opening checks are green, and then it ends.
- **Speed is what we measure.** We watch how long work takes from merged to released, and how long each item waits on the one in front of it.

## Consequences

### Positive

- The order can be the right one. Work that was parked "after launch" for schedule reasons is placed by what it unlocks.
- One roadmap to keep true, with no dates to move when a step takes longer.
- No rush to hit a day at the cost of the foundation.
- The work order needs fewer fields kept by hand: no target dates and no "needs a target date" flag.

### Negative

- Nothing forces a cut. Without a date, scope can grow unnoticed, so each milestone's list of checks is fixed and changes only on purpose.
- People outside cannot be told "when". Public copy says "coming" and never names a day.
- Work with DorkOS Cloud can no longer line up on a shared day. It lines up on an agreed order and on contracts landing first.
- Marketing has no day to build toward. It follows each milestone as it is reached.
- Dates already written in decision records, specs and research stay there, so a reader must know this record retires them.

## Alternatives considered

- **Keep the dates and move them again.** Rejected: three moves in one month showed the dates were guesses, and each move cost a rewrite of the plan.
- **Keep a private target date for the team only.** Rejected: a date nobody may see still decides the order, which is the thing this record removes.
