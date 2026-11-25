---
id: 261124-194115
title: If you have a computer of your own, it is the home of your private space; your DorkOS in the cloud is home only when you have none
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends: [261015-042933]
---

# 261124-194115. If you have a computer of your own, it is the home of your private space; your DorkOS in the cloud is home only when you have none

## Status

Accepted (operator decision, 2026-11-24: asked which holds a person's private space when they have both a Mac and a DorkOS in the cloud, he answered "The mac should be your home", which was option A as put to him: the Mac is home if you have one, and the cloud is home only for people who use DorkOS on the web alone). The rules below about copies, moving the home and a home that is off are the architect's reading of that answer.

"A computer of your own" means any computer you run DorkOS on yourself: a Mac today, and a server you host yourself.

**Amends** [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md), which stays Accepted:

- Its consequence "Two hubs (Mac and cloud) are peers that do not sync" is retired. They are not peers. One is the home, and the other is a way in.
- Its roles table lists where a person's hub can be: "Your Mac; your **cloud hub**, made the first time you open the full app on the web; a self-hoster's server". That stands as a list of where a home can be. This record says which one it is.

Everything else in it stands: everything is a space, the private space is locked by structure, servers connect only by pairing, and a shared host never holds a member's credentials or a key to a member's computer.

**Amended by** [261125-113808](261125-113808-an-agent-that-runs-in-the-cloud-has-its-home-in-the-cloud.md) (accepted 2026-11-25): each agent has one home, and an agent that runs on a cloud agent computer has its home in the person's DorkOS in the cloud. That settles the open point below about cloud agents, and "when the home is off, the space is away" now means the agents that live on that home.

**Builds on:** [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md) (a Mac can be the home that other computers attach to, with no cloud) and [261122-173853](261122-173853-one-space-model.md) (a space holds its members' data).

## Context

A person's private space holds what is theirs alone: their agents, their chats with those agents, their rules, memory, schedules, connections and settings. The plan gave a person two places that could hold it, a Mac and a DorkOS in the cloud, and said the two "do not sync". That left a question with no answer: when someone has both, which one is their private space? With two homes, an agent made on one is missing on the other, a setting changed on one is stale on the other, and "open your private space from anywhere" shows a different space depending on where you are. The principles say a founder's agents, tools and data stay theirs, and that DorkOS is local first with the cloud as an option.

## Decision

We will have one home for a private space, and it is the person's own computer whenever they have one.

- **You have a computer running DorkOS:** it is the home of your private space. It holds the space side for your own agents and chats.
- **You have none:** your DorkOS in the cloud is the home. This is the person who signs up on the web and never installs anything.
- **Your DorkOS in the cloud, when your computer is the home, is a way in.** It lets you reach your private space from anywhere you sign in, lists your computers and whether each is on, and is where team spaces and other people meet you. It does not keep a second copy of your private space.
- **One home at a time.** Moving the home (from the cloud to a new Mac, or from one Mac to another) is a deliberate move of the whole space, never two copies that drift.
- **When the home is off, the space is away.** The cloud shows it as away, and nothing pretends otherwise.

## Consequences

### Positive

- One answer to "where is my private space", and no sync between two copies to build or to get wrong.
- A founder's own data sits on a machine they own, by default. The cloud never has to hold it for someone who has a computer. (Since ADR `261125-113808`, it holds the agents such a person chooses to run in the cloud, and nothing else.)
- A person with a Mac can use DorkOS fully with no cloud at all, and add the cloud later without moving anything.

### Negative

- A private space on a Mac is only as available as the Mac. When the Mac sleeps, its agents and schedules stop, and the web shows the space as away. (An agent that lives in the cloud keeps working: ADR `261125-113808`.)
- **Settled since by ADR `261125-113808`:** what a cloud agent computer does for a person whose home is a Mac. Its agent's rules and tools would be on the home, so while the Mac is off it could not call a DorkOS tool or fire a schedule. The choice was between its work waiting for the Mac and such agents getting a home in the cloud. They get a home in the cloud.
- A person who starts on the web and later installs DorkOS on a Mac has to be offered a move of their home, and that move has to be safe to run once and never half done.
- Some of the work already planned assumed the cloud holds the private space for everyone: decision P4 and steps B7 and B10 of `specs/everything-is-a-space/02-specification.md`, and roadmap item 13. Each has to be re-read against this record before it is built.
- **Also open** for a person whose home is a Mac: where the list of their computers and their one inbox live; what the web shows, and what search across spaces can reach, while the Mac is off; and how a cloud way in that sleeps when idle wakes for them. The move of the private space onto the space store (ADR `261122-173853`) happens on the Mac for these people.
- Where ADR `261124-150516` and the target guide say "a cloud home", read: the home of a person with no computer, or the way in of a person who has one.

## Alternatives considered

- **The cloud is always the home, and a Mac is one of its computers.** Rejected by the operator, who chose the other option. The architect's reason: it makes a paid, hosted service the keeper of every founder's private data, against "ownership" and "local first, cloud optional".
- **Both are homes and they sync.** Rejected: it is the hardest thing to build correctly, and the 2026-10-15 plan had already ruled sync out.
- **Both are homes and they do not sync** (the plan until now). Rejected: it gives a person two private spaces and no way to tell which is real.
