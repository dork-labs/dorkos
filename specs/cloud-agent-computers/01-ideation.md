---
slug: cloud-agent-computers
number: 261125-235613
created: 2026-11-25
status: specified
---

# Cloud agent computers

**Slug:** cloud-agent-computers
**Linear:** umbrella DOR-2932 (project "Everything is a space"); the item's own steps DOR-2939 to DOR-2943, and DOR-3067
**Decision:** ADRs [`261015-042933`](../../decisions/261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md) (rules 3 and 7), [`261124-150516`](../../decisions/261124-150516-space-side-and-computer-side-one-contract-two-entries.md) (two sides, one contract) and [`261125-113808`](../../decisions/261125-113808-an-agent-that-runs-in-the-cloud-has-its-home-in-the-cloud.md) (an agent that runs in the cloud has its home in the cloud)
**Roadmap:** `meta/ROADMAP.md` item 14. Needs item 8 (spec [`space-computer-contract`](../space-computer-contract/02-specification.md)), item 6's computer entry (spec [`computer-side-starts-alone`](../computer-side-starts-alone/02-specification.md)) and item 13's wake of a sleeping home (spec [`your-dorkos-on-the-web`](../your-dorkos-on-the-web/02-specification.md)).
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

A person who has no computer of their own, or who wants agents that keep working while their Mac is off, needs a computer in the cloud for those agents to work on. The decisions are made: such an agent has its home in the person's DorkOS in the cloud, and runs on a cloud agent computer that speaks the same contract any other computer speaks (item 8). The hosted service already publishes how such a computer boots, links and reports whether it is busy (`packages/cloud-api/src/hubs.ts`). Nothing in the app calls any of it.

Item 8's spec builds the channel, the computer record, placement, the waits and the computer entry over the wire, and says in so many words that starting and stopping a cloud computer, its image and its link code are item 14's. This spec adds only that.

## What is built today

| Piece                                                                                                  | State                                                                                               |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The hosted contract for computers: list, make, start, stop, delete, link code, assignment, busy report | Built as contract only (`packages/cloud-api/src/hubs.ts`); no app code calls it                     |
| The test version of the hosted service                                                                 | Serves no computer route; it throws on any request it does not know                                 |
| The `agent-computer` server role                                                                       | The whole server with features switched off, OpenCode only. Item 6 turns it into the computer entry |
| The channel, the computer record, placement, the waits                                                 | Specified by item 8 (steps W1 to W24); not built                                                    |
| "Works on" in agent creation, DorkBot on a cloud computer, web onboarding with no computer             | None                                                                                                |

## What the spec settles

- **When the home asks for a start:** only for work that waits, or when the owner asks. Never for a list, a sidebar or opening a chat.
- **Nothing is refused because a computer is stopped:** work is accepted and waits, and the person sees why.
- **When a computer may stop:** the hosted service stops an idle one from the computer's own busy report; the owner's Stop says what it will end and asks.
- **What each stop reason looks like**, in words a person reads.
- **Linking with no code typed:** the home makes and links its owner's computer.
- **The first computer:** when it is made, the card step, and DorkBot for a person with no computer.
- **What the computer boots, which runtime it runs and how it reaches models.**
- **A verdict for every older step** for agent computers.

## What is left to later parts

- The contract between a home and a computer (item 8).
- Team spaces (item 15), a second computer for one person, and moving an agent between homes.
- A copy of a computer's chat history on the home.
- The image's build and hosting, prices and plans.
- Claude Code and Codex on a cloud computer; Doe waits for its spike.
