---
id: 261125-183122
title: A published page is a saved, versioned copy on an always-on home, and a published mini app is a live app that runs there in a sealed box of its own
status: accepted
created: 2026-11-25
spec: null
superseded-by: null
amends: [261015-042933, 261124-194115, 261125-113808]
---

# 261125-183122. A published page is a saved, versioned copy on an always-on home, and a published mini app is a live app that runs there in a sealed box of its own

## Status

Accepted (operator decision, 2026-11-25). Asked whether publishing and sharing what agents make should be written into the architecture now or left for later, he answered: "I would like us to write this into the architecture now, and sequence it relative to the other items instead of just marking it later."

What is his, from the same day:

- **The words** (rule 1): two things are made, mini apps and docs; publishing one gives a page; publish and share are the two things a person does ("simple, straightforward, easy to understand, and I'm on board with it").
- **A new page is private** (rule 4): "we should follow whatever the standard is", and comparable products start a new page private and make public sharing a step its owner takes.
- **One home, one copy** (rule 3), **an agent needs a yes to widen who sees a page** (rule 5) and **anything of the viewer's uses the viewer's own account** (rule 9): put to him as proposals, and he agreed to each.
- **A published mini app is a live app** (the first two sentences of rule 7). The architect had proposed that a published mini app show its page only. He changed that: "when you publish a mini app, that mini app should actually be able to be used on the web by anybody that is shared with. So for example, if my mini app is a game, then anybody should be able to play that game once it's published. So mini apps should be live apps that have the possibility of running on the web even for people that haven't or don't use DorkOS." He added that how it works is still to be figured out.

What is the architect's design for those answers, not yet confirmed by him rule by rule: rules 2, 6, 8, 10 and 11; where a published mini app's server half runs and the sealed box (the rest of rule 7); and the three stages under "How it is built".

**Amends**, each of which stays Accepted:

- [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md): its rule 3 says a person's DorkOS in the cloud runs no agents. That stands. It gains one job: it holds the pages that person published, and it runs a published mini app's server half in a sealed box of its own.
- [261124-194115](261124-194115-your-mac-is-the-home-of-your-private-space.md): its consequence that the cloud holds "the agents such a person chooses to run in the cloud, and nothing else" gains one more case. The cloud may also hold the pages that person published.
- [261125-113808](261125-113808-an-agent-that-runs-in-the-cloud-has-its-home-in-the-cloud.md): its sentence that a person's DorkOS in the cloud "still keeps no copy of anything that lives on that computer", and its rule 6, "the cloud holds only what lives there", both gain the same case. A published page is a copy its owner chose to place in the cloud. It is outside the private space, and the private space itself still has one home and no second copy.

**Builds on:** [261006-235238](261006-235238-one-dorkos-server-in-every-size.md) (one DorkOS server in every size, and pushing what you made to another one), [261122-173853](261122-173853-one-space-model.md) (a space holds its members' data), [261124-150519](261124-150519-what-may-go-in-the-core-mini-apps-and-one-wake.md) (mini apps and the core test), [261122-124821](261122-124821-one-dork-reference-ids-for-machines-addresses-for-people.md) (one reference for every thing), and the API records `261123-170830` to `261123-170833` (every action is defined once, as a capability).

## Context

Agents in DorkOS make two kinds of thing a person wants to show someone else: mini apps (a dashboard, a tracker, a game, a small tool) and docs. Today both stay inside the DorkOS that made them. The story has promised publishing since October 2026, and the research is done (`research/20261006_one-server-sync-publish-identity.md` section 3, `research/20261006_push-to-another-instance.md`), but the target architecture had no place for it and the roadmap listed it under "later" with no order.

Three things changed since that research. A person's own computer is the home of their private space, and an agent that runs in the cloud has its home in the cloud, with no sync between the two. Every action is now defined once as a capability, so the command line, the HTTP API and agent tools come from one definition. And other products have shown the shape people expect: a page made by an agent that is private until its owner shares it, has versions, and uses the viewer's own account for anything of the viewer's.

A mini app has two halves. Its page half runs in a browser. Its server half, when it has one, keeps data, runs on a timer and talks to other things; inside DorkOS it runs in the server's own process by default, or as a limited process of its own when its manifest asks for one (`runtime: "subprocess"`, `apps/server/src/services/extensions/isolation/`).

## Decision

We will let a person or an agent publish a mini app or a doc as a **published page**: a saved, versioned copy with a link, kept on an always-on home, private until it is shared. A published mini app is a live app that anyone it is shared with can use.

"An always-on home" means a DorkOS that a link can always reach. It may sleep when idle, as a person's DorkOS in the cloud does, as long as opening a page wakes it or the page is served apart from it.

1. **Two things are made, and two things are done with them.** A person or an agent makes a mini app or a doc. To publish one makes a published page: a saved copy with a link. To share a page is to choose who can open it. A page is what publishing gives, not a third thing to make, and there is no umbrella name for "things agents make".
2. **A page is a saved copy, not a live view of the original.** Publishing saves a version. Publishing again saves a new version under the same link. A viewer sees the newest version unless the owner pinned one. The original is never synced to the page while someone edits it; live shared docs are their own item.
3. **A page lives on one always-on home.** That is the person's DorkOS in the cloud, or any DorkOS server where they may publish, including one they run. A page has one home and no second copy that drifts. It stays there until its owner moves it on purpose or takes it down, and its owner can always download it. A person with only a Mac has no place to publish until they have such a home, and the app says so at the moment they try.
4. **A new page is private.** Its owner alone can open it. From there the audience widens one step at a time: named people, the members of a space, anyone with the link, and listed in public where a search engine can find it.
5. **An agent may publish. An agent needs a yes to widen who can open a page.** Publishing and updating a page are ordinary actions an agent takes at its level. Widening the audience gives new access, so when an agent does it, it needs a yes from the Owner or the agent's manager, as `meta/PRINCIPLES.md` already says. Narrowing the audience, or taking a page down, needs no yes.
6. **Publishing is defined once, as capabilities.** Publish, update, list and take down are capabilities in the one registry, so the command line, the HTTP API and agent tools all get them. The specification adds a reference kind for a page by amending ADR `261122-124821`, so a link to a page is written the same way everywhere.
7. **A published mini app is a live app.** Anyone it is shared with can use it on the web, with no DorkOS of their own. Its page half runs in the viewer's browser, in a sandbox, served from a web address apart from the app. Its server half, when it has one, runs on the page's home in a sealed box of its own, with its own data and its own limits. A published doc has no code.
8. **A published mini app holds none of its publisher's power.** From its box it cannot reach the publisher's private space, agents, connections, sign-ins or secrets. The publisher may grant it one named thing at a time when publishing, shown in plain words, for example "this form may send my agent a message". Such a message takes the one path for sending to an agent (ADR `261124-150518`), and whatever arrives through a grant is marked as words from outside.
9. **Anything of the viewer's uses the viewer's own account.** A page that shows a viewer's own live data, or acts for them, does it through the viewer's own DorkOS and connections, with the viewer's yes, and asks again when a new version asks for more. A viewer with no DorkOS still gets everything the app does by itself.
10. **A viewer can take a copy.** "Open in your DorkOS" copies a page into the viewer's own space as their own mini app or doc. Code from someone else still needs a yes before it runs, as the trust model says.
11. **Limits and abuse controls come first.** A published app runs inside limits on what it may use. Reporting, scanning and takedown exist before any page can be listed in public.

### How it is built

In three stages, each useful by itself:

1. **Docs, and mini apps that run fully in the browser.** A game, a calculator, a dashboard built from saved data. These need no server half, so anyone with the link can use them at once.
2. **Mini apps with a server half, in the sealed box.** A leaderboard, a sign-up sheet, a shared tracker.
3. **Mini apps that reach their publisher, by a grant.** A customer form that sends the founder's agent a message.

## Where this departs from the choices of 2026-10-06

- **Private first.** The earlier plan made free pages public and findable by search, and private pages a paid feature. The operator's rule on 2026-11-25 is to follow the standard, and comparable products start a new page private. So every new page is private, whatever the account, and who can see a page is no longer tied to what is paid. What is free and what is paid is not decided here, and no file in this repo names prices; the pricing page announces them.
- **No "keep it live" at first.** The October research offered a switch that kept a published doc syncing as it was edited. This record ships versions and "show the newest" first, and leaves live syncing to the live shared docs item.
- **The cloud holds published pages.** The October research ended with "no publish host by default". Since then a person's DorkOS in the cloud became the home of their cloud agents, and this record makes it the home of their pages too.
- **A mini app with a server half can be published.** The October research said an app with a server half is not something to publish and should be moved like an agent. The operator's rule on 2026-11-25 is that a published mini app is a live app, so its server half runs on the page's home, in a sealed box (rules 7 and 8).

## Consequences

### Positive

- A founder's agents can build tools the founder's customers use, not only tools the founder uses: a published mini app works for someone who has never heard of DorkOS.
- An agent can do the whole job: build the tool, publish it, and report the link. Someone with the say decides who sees it.
- One rule covers where things live: an agent in the cloud and a published page each have one always-on home and no sync.
- A copy a viewer takes is a way for a mini app to spread from one DorkOS to another.

### Negative

- A person with only a Mac cannot publish until they have an always-on home.
- Running other people's use of a mini app is real work: a sealed box for each published app that has a server half, limits on what it may use, and a way to stop one that misbehaves. On the hosted service that is DorkOS Cloud's half, through `packages/cloud-api`, contract first.
- A person's DorkOS in the cloud runs no agents. That still holds, since a mini app is not an agent, but it now runs published mini apps' server halves. This record amends ADR `261015-042933` to say so, and roadmap item 13 says so. `meta/PRINCIPLES.md` and the story's line about your own DorkOS in the cloud follow when it is built.
- A separate web address, a sandbox, reporting, scanning and takedown must land before public listing.
- A page is a copy, so a person can forget that an old version is still out. The app has to show what is published, to whom, and which version.
- A link on a DorkOS address stops working if its owner takes the page down or leaves that home.

### Still open, for the specification

- The sealed box: what it is built from (the limited process a mini app's server half can run in today is the starting point), what it may reach on the network, where its data is kept, and its limits.
- Whether a DorkOS server shared by several people may run a member's published mini app, and who on that server decides.
- Which named grants a publisher can give, how each is shown at the moment of publishing, and how what arrives through one is marked.
- How viewers are told apart when an app needs it: signed in or not, and what the app learns about them.
- How a page is served from a home that sleeps when idle: the home wakes, or pages are served apart from it.
- Who owns a page an agent published, and who owns a page made from a doc in a team space, given that a space holds its members' data.
- Whether an agent may publish a new version of a page that is already shared widely without a new yes.
- How "the members of a space" is checked when the page's home is not the space's server, and which roadmap item that step waits for.
- What a page's copy contains for each kind of thing, and how it is checked to hold no secret.
- The limits on size, storage, use and how long a page stays up, and what happens to a link after a takedown.
- What the public contract with the hosted service needs. A DorkOS server a person runs must be able to publish with no hosted service.

## Alternatives considered

- **The laptop serves the page through a tunnel.** Rejected: the link dies when the laptop sleeps, and it puts the laptop's own server on the internet. Remote access stays what it is, the owner's own way in.
- **The page is a live view of the original.** Rejected for now: it is the sync that live shared docs will bring, and a saved copy is simpler to reason about and to keep safe.
- **Public by default.** Rejected: a founder's dashboard that becomes public by accident is the worst case, and a public default draws spam before the abuse controls exist.
- **A published mini app shows its page half only, and its server half runs only where someone installs it.** The architect's first proposal. Rejected by the operator: a published mini app should work for anyone it is shared with, including people who do not use DorkOS.
- **A published mini app's server half runs with its publisher's power.** Rejected: a viewer's use of an app must never act as the publisher. The box is sealed, and anything it may reach is a named grant.
- **One umbrella name for everything agents make.** Rejected: "mini app" and "doc" are already the words, and another product's word for its own feature would add a name without adding meaning.
