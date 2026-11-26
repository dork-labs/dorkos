---
slug: your-dorkos-on-the-web
number: 261125-225407
created: 2026-11-25
status: specified
---

# Your DorkOS on the web

**Slug:** your-dorkos-on-the-web
**Linear:** umbrella DOR-2932 (project "Everything is a space")
**Decisions:** ADR [`261015-042933`](../../decisions/261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md) (everything is a space, rules 3 to 5), as amended by ADRs [`261124-194115`](../../decisions/261124-194115-your-mac-is-the-home-of-your-private-space.md) (your Mac is home) and [`261125-113808`](../../decisions/261125-113808-an-agent-that-runs-in-the-cloud-has-its-home-in-the-cloud.md) (each agent has one home); ADR [`261015-125850`](../../decisions/261015-125850-this-computer-and-other-devices.md) (this computer and other devices)
**Roadmap:** `meta/ROADMAP.md` item 13. Needs item 8 (spec [`space-computer-contract`](../space-computer-contract/02-specification.md)) for the list of a home's computers, item 12 (spec `member-checks`, pull request #4476) for the member question on a person's DorkOS in the cloud, and DorkOS Cloud's half through `packages/cloud-api`, contract first. Many steps need none of these and can start now.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

Roadmap item 13 is "your DorkOS on the web": open the app anywhere, see every agent you have, chat with your Mac's agents, see one inbox, and search. Three older plans describe how to build it. They were written when a person's DorkOS in the cloud was going to hold everyone's private space, with the Mac as a peer that did not sync.

That is no longer the design. Two records changed it:

- ADR `261124-194115`: if you have a computer of your own, it is the home of your private space. Your DorkOS in the cloud is a way in, and the home only for someone with no computer.
- ADR `261125-113808`: each agent has one home. An agent that runs on a cloud agent computer lives in your DorkOS in the cloud. The cloud never holds a copy of an agent that lives on your Mac.

So the web is not a third home. It is a window onto your homes. It shows what lives in your DorkOS in the cloud directly, and it shows what lives on your Mac by asking the Mac, while the Mac is on, through a link the Mac controls. Nothing from the Mac is copied to the cloud to make that work. When the Mac is off, its things show as away.

## The older plans

| Plan                                                                                                     | What it is                                                                    | State                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`everything-is-a-space/02-specification.md`](../everything-is-a-space/02-specification.md) (the parent) | Steps A1 to A11, B1 to B10, C1 to C13, F0, F1, F3, F4, F5, S1, D, L1a and L1b | Banners already flag B7, B10 and the cloud "Private" |
| [`accounts-l1a-end-to-end/02-specification.md`](../accounts-l1a-end-to-end/02-specification.md)          | Twelve steps that carry the parent to an end-to-end run                       | No banner for the two newer ADRs                     |
| [`accounts-l1b-hardening/02-specification.md`](../accounts-l1b-hardening/02-specification.md)            | Eleven steps of hardening and the rest of the accounts work                   | No banner for the two newer ADRs                     |

Much of the parent is built: the hub role, its image, its sign-in and its address checks; the request classifier, the gate sweep, the desktop app signing itself in, route-bound sessions and setup codes; both ends of the relay for chats, and the Mac's consent, levels and pin. Some of it is built in the old shape: every hub calls its one space "Private", and the public contract's directory still describes two peers that do not sync. No screen on the web calls the relay's chat routes yet.

## What changed, in one table

| Older plan said                                                         | Now                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The cloud hub holds everyone's private space                            | It holds it only for a person with no computer                                                                           |
| New Mac agents post to the cloud private space                          | Dropped. A Mac agent lives on the Mac                                                                                    |
| Quiet hours and time zone move to the account                           | A space's settings stay on its home; working hours stay on the Mac; the account holds neither                            |
| The account directory tells every DorkOS about every computer and agent | The account lists your homes and whether each is reachable. Each home lists its own agents and computers                 |
| One inbox in the hub for every computer                                 | One inbox view. Each home keeps its own items. A Mac may send a notice for delivery                                      |
| Search from the hub over its own rooms and mirrors                      | Search asks each home. The Mac answers while it is on                                                                    |
| The sidebar puts "Private" first                                        | One list of agents, grouped by where each lives                                                                          |
| Cloud hubs sleep when idle                                              | A cloud home that holds an agent with a schedule tells the hosted service when to wake it                                |
| Nothing said when a person whose home is the cloud links a Mac          | Whether a cloud home is the home or a way in is recorded once, when it is first made; linking a Mac never moves the home |

## What the spec settles

- **Nine invariants** (W1 to W9) that win over the older plans, the per-step map and the code.
- **A verdict for every step** of the three plans: stands, changes (with its new text), dropped, or moved to item 14 or another item.
- **The link from the cloud to a Mac, exactly**: the chat operations it carries today, and four additions (the Mac's list of agents with its presence, the cloud home's list for the Mac, the notice, and the search read), each named in the Mac's consent line, behind its own switch at the Mac, capped and recorded by the Mac, with who may call it and what it never returns.
- **The web's view**: one list by home, chats with a Mac's agents, the page move for everything else, the inbox and the notice, search across homes, and the away states and their words.
- **Your DorkOS in the cloud, re-read** for a person with a Mac and a person with none, what changes in the code built in the old shape, its wake report, and what happens on upgrade.
- **The contract changes**, contract first, in `packages/cloud-api`.
- **The sixteen stale sentences** in older records (and eighteen more found while writing and in review), each with its replacement, for the architect to apply.

## What is left out

- Cloud agent computers: their start, their placement and their DorkBot (roadmap item 14). Steps A7 to A11 move there.
- Team spaces (item 15). The private space as a tenant on the space store (item 16). Publishing (item 19).
- Two homes working together: what a cloud agent may do on the Mac, where a room shared by a Mac agent and a cloud agent lives, and how a message between them is carried and trusted. It is its own later piece of work, with its own ticket.
- Moving a home, or one agent between homes.
- A copy of a Mac's chats in the cloud, and any widening of the link beyond what this spec names.
- Prices and plans.
