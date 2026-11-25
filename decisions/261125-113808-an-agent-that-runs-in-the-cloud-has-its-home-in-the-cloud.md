---
id: 261125-113808
title: Each agent has one home; an agent that runs in the cloud has its home in the cloud, and a person may choose that for good
status: accepted
created: 2026-11-25
spec: space-computer-contract
superseded-by: null
amends: [261124-194115]
---

# 261125-113808. Each agent has one home; an agent that runs in the cloud has its home in the cloud, and a person may choose that for good

## Status

Accepted (operator decision, 2026-11-25). Asked what a cloud agent should do when its person's Mac is off, wait for the Mac or get a home in the cloud, he answered: "give cloud agents a cloud home when the mac is off. That said, some cloud agents should/could live in the cloud (not on the mac) permanently".

His first sentence could mean two things, so it was put to him as its own question the same day: does a cloud agent always live in the cloud, or does it live on the Mac and move to the cloud only while the Mac is off? He chose the first. So rules 1 to 4 are his: a cloud agent lives in the cloud, an agent may live there for good, and there is no hand-back when the Mac returns. Rules 5 to 9 are the architect's reading of that answer.

**Amends** [261124-194115](261124-194115-your-mac-is-the-home-of-your-private-space.md), which stays Accepted:

- Its open point, "what a cloud agent computer does for a person whose home is a Mac", is settled here.
- Its decision "one home for a private space" now has one named exception. The space's own data and the agents on the person's computer stay on that home. An agent that runs in the cloud, and what belongs to that agent, lives in the cloud.
- Its rule "When the home is off, the space is away" now reads: what lives on that home is away. An agent that lives in the cloud is still reachable.
- Its consequence "The cloud never has to hold it for someone who has a computer" no longer holds for a person who has an agent in the cloud. It holds for everyone else.
- Its rule "One home at a time" is kept, and is now also true of each agent.

Everything else in it stands. A person's own computer is still the home of their private space when they have one, and their DorkOS in the cloud still keeps no copy of anything that lives on that computer.

**Builds on:**

- [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md): the space side holds an agent's data and serves its tools, and the computer side runs its turns.
- `specs/everything-is-a-space/design-agent-computers.md`, sections 0 and 1, which already put a cloud agent's identity, rules, memory, schedules and chat list on the person's DorkOS in the cloud. ADR `261124-194115` put that in doubt for a person with a Mac. This record confirms it.

## Context

ADR `261124-194115` made a person's own computer the home of their private space. It left one case open. A person with a Mac can also have an agent that runs on a cloud agent computer. If that agent's rules, tools, chats and schedules sat on the Mac, then while the Mac slept the agent in the cloud could not call a DorkOS tool, could not be sent a message and could not wake on a schedule. The one thing a cloud agent is for, working while you are away, would not work.

There were two ways out: its work waits for the Mac, or the agent gets a home in the cloud.

## Decision

We will give each agent one home, and an agent that runs in the cloud has its home in the cloud.

An agent's **home** is the DorkOS that holds its space side: its record and rules, its memory, its schedules, its list of chats, and the tools DorkOS serves it.

1. **An agent that runs on your own computer lives on your own computer.** Nothing changes for it.
2. **An agent that runs on a cloud agent computer lives in your DorkOS in the cloud.** It keeps working when your Mac is off, asleep or offline: it can be sent a message, call its tools and wake on its schedule.
3. **You may choose the cloud as an agent's home for good.** Such an agent never has to touch your Mac, and it does not need you to own a computer at all.
4. **One home for each agent, and no back and forth.** An agent does not move when a computer goes off or comes back on. Moving an agent from one home to another is a deliberate move of that whole agent, never two copies that drift. Changing where an existing agent works, from your Mac to the cloud or back, is that move.
5. **Your private space is still one space.** The app shows one list of your agents wherever you open it, and each agent shows where it lives. An agent on a Mac that is off shows as away. An agent in the cloud shows as available. On a Mac with no internet, the agents in the cloud show as away.
6. **The cloud holds only what lives there.** It holds the agents whose home it is, and what belongs to them. It never holds a copy of an agent that lives on your computer.
7. **What belongs to the space, and not to one agent, stays on the space's home.** Your settings and the things your agents share are on your own computer when you have one, as ADR `261124-194115` says.
8. **A machine you add yourself attaches to the home you added it from.** Rule 2 is about the agent computers DorkOS Cloud runs. A server you link to your Mac is one of your Mac's computers, and an agent on it lives on your Mac.
9. **Living in the same private space gives an agent nothing on another home.** An agent in the cloud uses the connections kept in your DorkOS in the cloud. Nothing is copied to it from your Mac unless you add it there yourself. Today the only link from your DorkOS in the cloud to your Mac carries chats, and the Mac decides what it shares (ADR `261015-042933`, rules 4 and 5). Anything more is an open point below.

## Consequences

### Positive

- A cloud agent does what it is for: it works while you are away.
- There is still no sync between two copies. Each agent is in one place.
- The choice is plain and made once for each agent: on my computer, or in the cloud.
- A person with a Mac and no cloud agent sees no change from ADR `261124-194115`.

### Negative

- The chats, memory and rules of an agent that lives in the cloud are held by a hosted service. That is the person's choice, so the app has to say so at the moment they make it.
- One private space now has parts in two places. The one list of agents, search, and the inbox have to draw from both, and say honestly which part is away. ADR `261124-194115` already left open where a person's inbox and list of computers live; that question now has to be answered for both kinds of agent.
- A DorkOS in the cloud that holds an agent with a schedule cannot simply sleep when idle. It has to wake for that agent's next run.
- When an agent on the Mac and an agent in the cloud work together, their messages cross the wire even though both belong to one person. The contract has to say how such a message is carried and what it is trusted with.
- Moving an agent between homes is a new operation. It has to be safe to run once and never half done, like moving the home of the whole space.

### Still open, for the contract's design (roadmap item 8, DOR-5163 to DOR-5170)

- What an agent in the cloud may do on the person's Mac, and how the person allows it.
- Which connections an agent in the cloud can use, and how a person adds one there.
- How the app on a Mac reaches the agents in the cloud, and what it shows while it cannot.
- Where a room or a document lives when it is shared by an agent on the Mac and an agent in the cloud, and who serves it while the Mac is off.
- What travels with an agent when it moves between homes: its memory and schedules, and which of its connections.

## Alternatives considered

- **The cloud agent's work waits for the Mac.** Rejected by the operator. It makes a cloud agent only as available as a laptop, which defeats its purpose.
- **A home in the cloud only while the Mac is off, handed back when it returns.** Rejected by the operator, when it was put to him as its own question. A home that moves back and forth is two copies that have to be merged, which is the sync that the 2026-10-15 plan and ADR `261124-194115` both ruled out.
- **The cloud is the home of every agent.** Already rejected in ADR `261124-194115`: it makes a hosted service the keeper of every founder's private data.
