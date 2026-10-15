---
id: 261015-042933
title: Everything is a space; one program plays three roles (hub, space server, agent computer), and your account is the door
status: accepted
created: 2026-10-15
spec: everything-is-a-space
superseded-by: null
amends: [261006-235238, 260727-184933, 0319]
---

# 261015-042933. Everything is a space; one program plays three roles (hub, space server, agent computer), and your account is the door

## Status

Accepted (operator decision, #dorkos, 2026-10-15: "lets move forward with your picks"). The design was agreed after six review rounds by four reviewers (architecture, product, security and open source, DorkOS Cloud). Spec: [`everything-is-a-space`](../specs/everything-is-a-space/02-specification.md). Launch moves to **late January 2027**; a soft launch of the DorkOS Community Space keeps **December 8, 2026**.

**Amended 2026-10-15** by [261015-125850](261015-125850-this-computer-and-other-devices.md) (this computer and other devices; operator decision in a direct chat, "Let's go with A for the slip"): the login groundwork lands before launch, so launch moves again, from late January to **early February 2027** (about February 2 to 9; a slip of about 2 weeks, range 1 to 3). The December 8 soft launch is unchanged. Nothing else in this ADR changes; the dates below are the ones decided at the time.

"Hub" is an internal word. It never appears in anything a person reads; the app says **Private** for the private space and **space** for everything else.

**Amends** (each stays Accepted):

- [261006-235238](261006-235238-one-dorkos-server-in-every-size.md): keeps "one program in every size" and "only one place runs an agent at a time". Retires the idea that a person's own DorkOS is only ever the Mac: an account may also have a **cloud hub**, made lazily, which runs no agents. Retires "the app connects to any DorkOS server directly" as the way to reach your Mac from the web, replaced by the session relay below. Its after-launch merge order stands, except step 10 ("one window"), which this ADR replaces.
- [260727-184933](260727-184933-the-community-server-never-runs-a-members-agent.md): retires "hosted agent execution is a separate future product, not scheduled". Cloud agent computers ship at launch. "A space server never runs a member's agent" **stands**, and is joined by "a hub never runs an agent": agents run only on agent computers and on people's own computers.
- [0319](0319-account-first-cloud-identity-device-link.md): the DorkOS account becomes the door to a person's whole DorkOS, not only to Cloud features. The device link stands, and is how a Mac is linked to its owner's hub.

## Context

Dorian asked for two experiences (#dorkos, 2026-10-15). Away from home, at dorkos.ai, he sees and uses every agent he has: the ones on his Mac and the ones in the cloud, with the Mac's going offline when it is shut down. And a person who never installs anything signs up on the web, creates agents and runs them. He also gave the mental model: everything is a space, an account gets a private space, collaborating means a separate space, every server is a space server, and any instance can be a home.

The earlier plans failed one of those tests. Making the space server serve the full app and reach into people's computers would give a shared server, possibly a stranger's, the key to every member's Mac. Sending people to each computer's own address works, but is clumsy and does not give one list of all your agents.

## Decision

We will run **one program in three roles**:

| Role                    | Holds                                                                                                                                         | Where                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Hub** (internal word) | One person's DorkOS: their **private space** (the `LOCAL_COMMUNITY` port, built), their agents' brains, the account directory view, one inbox | Your Mac; your **cloud hub**, made the first time you open the full app on the web; a self-hoster's server  |
| **Space server**        | Shared spaces: people and agents as members, rooms, docs, files                                                                               | spaces.dorkos.ai for team spaces; a separate host for the Community Space; self-hosted                      |
| **Agent computer**      | A sealed runtime and workspace, with no account secrets                                                                                       | Cloud agent computers; the sealed computer on a Mac (an experiment behind a flag); the Mac itself, as today |

The rules that follow from it:

1. **Everything is a space.** The private space is a space on your hub, team spaces are spaces on a space server, and every server holds at least one space. Servers connect only by **pairing**, never by taking another server's word for who someone is. Each computer keeps its own pairings with spaces; a hub only shows them.
2. **The private space is locked by structure.** It has no invite or join routes, no shareable address and only its owner as a member, and only the owner's own computers may pair with it; tests pin each refusal. You open it from anywhere you sign in. Working with others means starting a team space, which can take rooms, docs and agents with it.
3. **Your account is the door.** At dorkos.ai you land in your cloud hub, at your own address (`<opaque id>.dorkos.app`, behind one front door with a wildcard certificate). Cloud hubs are made lazily, sleep when idle, run no agents, and hold no hosting-supplier credentials: they ask Cloud's API to start or stop their own agent computers.
4. **Your Mac's agents reach the web through a session relay, not a tunnel to the whole app.** The Mac dials its own pinned hub when a viewer is open. The relay carries chats only: the session stream, sending messages, approvals and interrupt. Terminal, files, settings, connections and previews open as a page move to the Mac's own managed remote address, behind the Mac's own login. The relay protocol is part of the open program, so self-hosters can run it.
5. **The Mac stays in charge, even against a compromised Cloud.** Turning the relay on, changing its level, removing runtime credentials and unlinking happen only at the Mac, by its signed-in owner. Chat is the default level; full control is a separate level. A relayed caller is its own caller kind, never "at this computer" and never a person. Approvals are passkey-signed and bound to the exact action. The consent text says plainly what this cannot stop: a compromised Cloud serves the page.
6. **Other people's agents are reached through the space conversation**, never through their owner's chat view. A teammate gets the stranger tier plus **"ask the owner"**, which shows the owner the exact operation and its arguments, never allows "always", expires, and is rate-limited.
7. **Agent computers in the cloud ship at launch, on OpenCode.** Claude Code and Codex on cloud computers come after launch. Whether Doe runs there is the weekend spike's question; if it does not, Dorian decides (PRINCIPLES 5).
8. **Self-hosters get all of it** on their own servers with their own logins. Nothing talks to DorkOS Cloud unless "Continue with DorkOS" is on.

Dorian's choices that shape the build (2026-10-15): three app chats from the weekend usage reset; chatting with your Mac's agents from the web is free, while full control from the web comes with a paid plan or a cloud computer; team billing at launch is seats only; access levels and guests come after launch (DOR-2743); people outside the US can join a team space while paying stays US-only; DorkBot for web-only people lives on a cloud computer, which needs a card, and onboarding says so.

## Consequences

### Positive

- Both of Dorian's experiences work, from one address, with one sign-in.
- No space server, ours or a stranger's, ever holds a key to anyone's computer. Only the person's own hub does, and only at the level their Mac allows.
- A teammate with no computer gets the full app, because every team-space member has a DorkOS account and so may have a hub.
- Mini apps keep working on the web at launch: each hub has its own address, so one person's mini app can never reach another's.
- The open program stays complete: the relay protocol, the hub role and the space server are all in the public repo.

### Negative

- Launch moves from December 8 to late January 2027. About 18 to 20 chat-weeks of new app work (about 23 with the server-merge steps and hardening), plus four Cloud chats.
- DorkOS Cloud becomes a higher-value target. The passkey binding stops forged or replayed approvals but not a compromised Cloud that serves the page; only a native app whose code Cloud does not serve could do better.
- Mac chats viewed from the web pass through the person's hub. "DorkOS is not in the data path" no longer holds for that view, and the consent and docs say so.
- Two hubs (Mac and cloud) are peers that do not sync. The Mac's older rooms stay on the Mac and are reached from the web by a page move.
- Cloud agents run only on OpenCode at launch.
- `dorkos.app` and the user-content and sandbox domains need Public Suffix List entries, which take weeks to reach browsers; until then every change, WebSocket upgrade and stream checks its exact origin.

### Neutral

- A Mac as a team space's home (PGlite) stays after launch. Neither experience needs it.
- Shared mini apps in spaces, and mini apps from other computers, come after launch on a sandbox domain.
