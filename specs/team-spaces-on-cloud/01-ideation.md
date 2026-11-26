---
slug: team-spaces-on-cloud
number: 261126-043205
created: 2026-11-25
status: specified
---

# Team spaces on DorkOS Cloud

**Slug:** team-spaces-on-cloud
**Linear:** umbrella DOR-2932 (steps DOR-2954 to DOR-2961)
**Roadmap:** `meta/ROADMAP.md` item 15. Needs item 12 (spec [`member-checks`](../member-checks/02-specification.md)) and item 13 (spec [`your-dorkos-on-the-web`](../your-dorkos-on-the-web/02-specification.md)).
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

Roadmap item 15 is team spaces: create one, invite people, count seats, and have agents that wake and reply. A member signs in with a DorkOS account and gets the full app, even with no computer. Teammates reach your agents through the space, and big actions come to you to approve.

Its steps, C5 to C12, were planned in [`everything-is-a-space`](../everything-is-a-space/02-specification.md) and carried by the L1a and L1b plans. Since then, eight newer specs changed the ground under them: member checks (item 12), your DorkOS on the web (item 13), cloud agent computers (item 14), the one wake (item 9), send to an agent (item 10), the one message system (item 17), the contract over the wire (item 8) and publish and share (item 19). Three of the eight steps are built. Most of what is left touches the space server's code, which is frozen until the Community Space opens.

## What the spec settles

- A verdict for each of C5 to C12, and for the L1a and L1b steps that carry them.
- What a team space needs on top of items 12, 13 and 14, and nothing more.
- Which steps can start now, which wait on a named step of another item, and which sit inside the freeze, named only.

## What is left out

- The full design of the space server's half. It is written after the Community Space opens.
- Prices and plans. Two homes working together. A team space's doc as a published page.
