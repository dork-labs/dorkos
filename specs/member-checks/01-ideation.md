---
slug: member-checks
number: 261125-210729
created: 2026-11-25
status: specified
---

# Member checks replace the Mac's owner checks

**Slug:** member-checks
**Linear:** DOR-5150
**Decision:** server-merge decision D8 ([`server-merge/02-specification.md`](../server-merge/02-specification.md)), confirmed and ordered by ADR [`261122-173853`](../../decisions/261122-173853-one-space-model.md); its form is ADR [`261123-170830`](../../decisions/261123-170830-http-api-is-a-projection-of-capabilities.md) ("member checks become the capability's visibility rule, run once by the registry before `invoke`").
**Roadmap:** `meta/ROADMAP.md` item 12. Needs nothing above it. Shares one builder with item 10's `context.caller` (spec [`send-to-an-agent`](../send-to-an-agent/02-specification.md) §6.2) and respects item 6's wall (spec [`computer-side-starts-alone`](../computer-side-starts-alone/02-specification.md)). Unlocks 13, 15, 16 and equal accounts.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

Today the DorkOS server asks "is this the owner?" in hundreds of places, through 17 named checks, three wrappers, and a dozen methods and fields. On a Mac that is the right question: there is one person, the first account ever made, and every agent is theirs. In a shared space it cannot be asked. A team space has many people, each at a level, and a person's DorkOS in the cloud holds the same private space a Mac does.

This spec moves the question. For everything that is space data, one question, "may this member do this in this space?", is asked in one place: the capability registry asks it once, before a capability runs. On a Mac the answers do not change, because the only person is the owner and every agent is the owner's. What changes is where the question lives, so one definition can serve a private space, a person's DorkOS in the cloud and a team space.

## What exists today

| Piece                                                               | State                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who the owner is                                                    | The first account ever made (`findOwnerAccount`); registration closes after it                                                                                                             |
| Owner checks                                                        | 386 sites in 161 server files (§8 of the spec). 54 ask whether a caller may act on space data; the rest are the front door, place, this computer's own things, or checks of who is calling |
| A member and a level                                                | Only in the space store: `members.role` is `owner`, `admin` or `member`, with one predicate, `requireLiveRole`. Agents are members of kind `agent` with an owner link                      |
| On this computer                                                    | No member or level. The rooms store knows the owner's author record and nothing more                                                                                                       |
| The capability registry's gate                                      | Twelve steps from lookup to `invoke`; none asks about a member or a space                                                                                                                  |
| Which space a call is in                                            | Not known. The private space's id exists (`localSpaceId()`) and is read only for provenance                                                                                                |
| The front door (login, remote access, credentials, package sources) | One bar, `refuseFrontDoorChange`: the owner, in person, at this computer or on an encrypted connection                                                                                     |
| "At this computer"                                                  | A fact about the request (`isAtThisComputer`), read in 36 places                                                                                                                           |
| A count that holds the move                                         | None. The computer wall (item 6) is the model                                                                                                                                              |

## What the spec settles

- **The predicate**, `mayMember(member, action, space)`, pure, in `packages/shared`: a level type with four values, two rows decided (a person at Owner and an agent of an Owner, both allowed everything), and placeholder rows for equal accounts that no path on a Mac reaches.
- **The space in a call**: `registry.invoke` sets `context.space` on every call from one builder; no caller supplies it.
- **Who the member is**: a `MemberDirectory` port on the space side, whose private-space implementation is today's two room caller resolvers moved into one function, with one table from caller, door and posture to member.
- **The gate step**: where the member check runs in `registry.invoke`, what a refusal answers on each surface, and how the catalog and the tool lists show a member only what it may use.
- **The inventory**: every one of today's owner checks in one of five classes (member check, front door, place, this computer's own things, who is calling), from one stated search, each with the step that moves it.
- **The computer-owner check**: an identity test for the owner of this computer, on the computer side, with each site's place and session halves kept beside it.
- **The ratchet**: a count of every owner test by resolved binding outside a named allowed list, which may only fall and does not reach zero: the front door, place and the checks of who is calling stay until equal accounts.
- **The order**: the ratchet; then the predicate, the space, the directory and the gate; then the work queue, search, Direct chats and two small reads, then rooms; beside them the computer-owner check; last, after the Community Space opens, the space store shares the level type.

## What is left out

- Equal accounts: the values of the Admin, Member and Guest rows, editable switches, more than one person on a Mac, agents as admins.
- Opening approvals to anyone but a person.
- The manager's yes on the always-a-yes list.
- Moving the private space onto the space store (item 16).
- Changing any rule in the frozen space code. Its sharing of the level type is a named later step that waits for the Community Space to open.
- Changing the checks of who is calling (a person, an agent, a program, the owner in person).
- Redesigning "at this computer" for a hub (item 13).
- Moving folders into kernels (DOR-4925). New code goes where item 6's side map puts it, in folders DOR-4925 can move whole.
