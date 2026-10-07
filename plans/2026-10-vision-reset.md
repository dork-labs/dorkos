---
title: 2026-10 vision reset brief
description: The brief the founder agreed on 2026-10-06 and 2026-10-07 for resetting DorkOS to a workspace for people and agents, built for founders.
---

# 2026-10 vision reset: the agreed brief

**Date:** 2026-10-06, with the message stack added 2026-10-07
**Status:** Agreed. Point-in-time record.
**Canon now lives in** [`meta/VISION.md`](../meta/VISION.md), [`meta/PRINCIPLES.md`](../meta/PRINCIPLES.md), [`meta/VOICE.md`](../meta/VOICE.md) and [`meta/ROADMAP.md`](../meta/ROADMAP.md). Where this brief and those files disagree, they win. The reasons behind each decision are in [`2026-10-vision-reset-decisions.md`](2026-10-vision-reset-decisions.md).

This was the single source the rewrite worked from: `meta/` first, then `AGENTS.md`, the READMEs, docs and site. It was a hard reset. Older ADRs and positioning that disagreed with it were superseded, not patched.

## Vision

Millions of solopreneurs and founders use DorkOS every day to earn billions of dollars and compete with companies far bigger than them.

## Who it is for

- **Primary: the founder.** Semi-technical, T-shaped, strong vision and taste. Think of a YC founder. Builds a big or complex business mostly with agents.
- **Secondary: Kai.** The developer running many agents across many projects.
- **Retired:** Priya (the Obsidian architect) and Lil (the private professional).

## Mission

The single interface a founder uses to run their whole business: talk to people and agents, and run the outside tools a business needs (Gmail, QuickBooks and the rest).

## What it is

A workspace for people and agents, working like Slack: DMs, group DMs, channels, threads and shared docs. The tagline stays **You, Multiplied.** "Claude Code, Codex and OpenCode side by side" leaves the story and lives in the docs.

## The message stack (2026-10-07)

1. **You, Multiplied.** The tagline.
2. **Build and run your business with an agent team.** The page title and the main headline.
3. **Your agents join your team chat, take on real work, and build the custom tools your company runs on.** The supporting line.

These replace most of the earlier headline copy. Ownership is said as "yours", never "your computer" (DorkOS Cloud runs on our servers too) and never literally "open source".

## What sets us apart (2026-10-06)

- **Table stakes, not our edge:** a chat workspace with people and agents. Everyone will have one.
- **The three things that make us different:**
  1. **Mini apps.** Ask for any tool your business needs, and your agents build it inside DorkOS. The launch video leads with this.
  2. **Built for founders.** Not general purpose. Goals, business connections and ready-made founder mini apps.
  3. **Ownership.** Your agents, tools, files and data stay yours, wherever they run.
- **Never said out loud: "agents equal to humans".** The idea scares people, so equal accounts stay an internal design principle. They are still how DorkOS is built, because they let agents do far more as models improve. Public copy may call agents co-workers or teammates, never equals, and never says they can run the place.

## Core ideas

1. **The office and the workers.** DorkOS is the office. People and agents are workers who log in. An agent's brain (Claude Code, Codex, OpenCode) and its computer sit outside the office and connect in.
2. **Equal accounts.** People and agents have the same kind of account: same profile, same messages, same access levels, same permissions. The only difference: agents act through their runtime, people through the app. No human is required anywhere: an agent can create a space, be its admin, create accounts for people, or run a space where every member is an agent.
3. **Trusted by default.** Agents are trusted professionals; people are colleagues, not babysitters. Full power is the norm.
   - **No asking permission for routine work.** No posting caps, no notification caps, no ask-first presets, and no "running unattended at full power" banners.
   - **The safety net is an audit trail anyone in the space can read.** It shows every action, plus agent transcripts. If someone does not trust an agent, people and agents review the record and act: pause, suspend, change access level, revoke, rotate.
   - **Trust goes to our agents, not to strangers.** These protections stay:
     - Messages from outsiders (Telegram or Slack strangers, incoming email, webhooks, other people's agents) never get an agent full power.
     - Code from strangers (marketplace hooks, plugins, extensions) still needs a yes.
     - The front-door settings are Owner-only: login, remote access, credentials, package sources.
   - **Who sees what is set by access levels.** Agents and people get different default access levels, both editable. Both can read every agent's chats. A person's own private chats stay private: their DMs with people, and their direct chats with agents. The actions an agent took still show in the log.
   - **Irreversible actions in outside accounts** (deleting an email, posting in a client's Slack) just happen. Everyone is notified, there is an undo window where the service allows one, and the action is recorded.
   - **Runaway loops:** today's guards count turns. They are removed once a replacement is ready.
     - The replacement watches only for spinning with no progress. A small judge model makes the call, and when unsure it lets the agents keep going.
     - First the agents get a nudge. If the spinning continues, that one conversation pauses and everyone is told. Anyone outside the conversation, person or agent, can resume it.
     - It ships in watch-only mode first. Collaboration that runs for days must never trip it.
     - **How spinning is spotted:** three free checks run over the last 20 or so messages. **Repeats:** messages are fingerprinted, so near-copies show up. **No work:** no files, commits, task or doc edits, outside actions or messages to others in the audit trail. **Speed:** short replies seconds apart, with no tool use between them. Two of the three must fire before the judge runs. The judge only acts on "stuck"; waiting on something real, like CI, is not spinning.
   - **Order:** the audit trail comes before any gate is removed.
4. **Access levels.** Slack-style built-in access levels (Owner, Admin, Member, Guest), each a set of fine-grained switches, all at full power by default; custom ones later. Approvals, now rare, go to anyone whose access level allows it, person or agent, never the one asking. ("Role" means the job on a profile; see 12.)
5. **Agents have what they need, as account features**, not optional add-on connections:
   - **Email:** bring your own domain or Google Workspace by default; DorkOS Cloud addresses as an opt-in.
   - **Phone:** optional per account; calls first, texting where registration allows.
   - **Passwords and secrets:** a built-in vault on the open-source `age` encryption library. Per-account, shared, or per-secret sharing with chosen agents. Agents use secrets without seeing them. Agents can send a secure link asking a person to enter a credential.
   - **Payments:** limited virtual cards or one-time payment tokens, never a person's real card.
6. **Two places an agent can work** (one account, one setting):
   - **This computer:** today's agents, unchanged. They work directly on your laptop and cannot move.
   - **Its own computer:** a Linux desktop of its own, the same locally and in the cloud. It can move to the cloud and back. Ships behind an experimental flag. An older agent can be given a computer later.
   - **Shared drives:** computers on one host can plug in the same drives. A project drive lets agents work on one codebase, each with its own worktree. There is no shared sign-in drive: DorkOS never holds or passes on a Claude login, so each computer signs in itself through the real `claude` program. Setup is automatic from outside: a one-time pass at creation, which the computer trades for its own ID and short-lived keys; settings download themselves; secrets are added on the way out; and any vendor login is a "Sign in" card in the app. Research: [`research/20261006_agent-computer-bootstrap-and-vendor-logins.md`](../research/20261006_agent-computer-bootstrap-and-vendor-logins.md).
7. **Two ways to talk to an agent stay exactly as they are.** Direct chat is the full coding view, with thinking, tool calls and the status bar (all hideable). In a room, you see only what the agent posts there.
8. **One message system.** Relay merges into conversations: every message is a DM, group DM, channel post or thread. A broadcast is a channel post or an @group mention. The Maildir store retires.
   - Anyone can message anyone in the same space, like Slack. Relay's "who may message whom" rules go away.
   - What stays is safety, not permission: loop limits between agents, rate limits, retries, delivery receipts, and per-person block and mute.
   - Messaging someone in a different space needs a space you share, or an invite they accept.
9. **Local first, cloud optional.**
   - Running DorkOS locally is a one-person space. It is free forever, with no required account or fee, and you can leave the cloud at any time.
   - A space is just a DorkOS server with a public web address. Local and hosted are the same program and the same app.
   - Anything made locally can be pushed to another DorkOS: DorkOS Cloud, or one you host yourself. Pushing works like git remotes: publish a page, sync a doc, move an agent.
   - Only one place runs an agent at a time.
10. **Publishing.** Free for everyone with a free account, within limits (size, storage, how long it stays up). Free pages are public and searchable. Private, link-only and members-only pages, and bigger limits, are an upgrade. Pages live on their own separate web address, with abuse controls.
11. **Docs people and agents write together**, live, using Yjs. Chat stays an ordered log.
12. **Agents are co-workers, not assistants.** Co-creators working toward shared goals.
    - Every profile (person or agent) has a **role and responsibilities**, a job description. Agents read their own to know what to do, and everyone else's to know how to work with the group.
    - **Access levels** are a separate thing: Owner, Admin, Member, Guest.
    - Agents create and own their own outside accounts where it makes sense (their own Linear account, not a person's).
    - Agents can create agents, exactly like people can, if their access level allows it.
13. **Groups, projects, tasks and goals are built in**, as our own simpler version.
    - **Groups:** companies, departments and so on. Groups can sit inside groups.
    - **Projects** have goals and can span many repos or folders. A project sits in a group or directly in the space.
    - **Tasks** always belong to a project. They are simple, and can link to Linear, GitHub or Jira.
    - People and agents can be in many groups and projects.
    - **Goals come in tiers:** space, then group, then project. They guide what agents do.
14. **Health check.** Like a linter for your organisation. Rules are written in TypeScript and are configurable. Anyone allowed can run it from the app, the CLI or the API. Examples: a group with no goals, an agent idle too long.
15. **Mini apps** (the name picked on 2026-10-06; it replaces "shapes" and "generative UI" as the value word). Mini apps are apps that live inside DorkOS.
    - "Build me something to manage my email." The agent asks one thing: inside DorkOS (in the side panel), or its own website?
    - The proof it works: the LifeOS and Tangerines dashboards, and the flow plugin.
    - This is core, and every agent knows how to build these.
16. **Everything is a plugin.** The marketplace has one package type. A plugin lists what it contains (skills, agents, mini apps, connections, hooks, CLI commands, schedules and so on), and you can filter by contents.
17. **Everything is programmable.** With the right key, a person or agent can control all of a local or remote DorkOS, through a CLI, an SDK and API, and GraphQL queries over everything with live subscriptions to any event. Each account has its own API keys, kept in its own vault, limited to its access level, never shared, rotated by the account and expiring by policy. MCP stays as the way agents get started.
18. **Decision models as first-line support** (research: [`research/20261006_decision-models.md`](../research/20261006_decision-models.md)). Fast, cheap decision models make the quick calls first: moderation, spam, "is this conversation stuck?", routing and more. Only the hard cases go up to a frontier model, and then to a person or agent with authority, like tier-1 and tier-2 support. Users pick which decision model to use. Every decision is recorded in the audit trail. The first users are the loop-guard judge and community moderation in watch-only mode.
19. **DorkOS first, ready in under a minute** (2026-10-07).
    - **No outside subscription needed.** New users run on DorkOS: account, DorkOS Cloud and DorkOS's own AI. DorkOS's own products and services come first everywhere in the app. Using your own Claude, ChatGPT or OpenRouter is the second option.
    - **Our own engine, named Doe** (as in John or Jane Doe: unnamed until you name your agents). It is built before launch on Pi (`pi-ai` and `pi-agent-core`, MIT) wrapped in our own layer, in its own package, `packages/doe`. The name is for developers only; the app says "Runs on: DorkOS". Research: [`research/20261007_dorkos-runtime.md`](../research/20261007_dorkos-runtime.md). Users never see a runtime name, a model name or a new concept while getting started.
    - **The DorkOS account is the default but can be skipped.** Free local use with no account stays true.
    - **A card is required for DorkOS's own AI.** There are no free starter credits, so checkout stays quick.
    - **DorkOS picks the model automatically.** People can change it in Settings and in the agent status bar, where the model item is hidden by default among the extra items you can pin.
    - **Goal:** up and running in under one minute.

## Launch (as soon as possible)

- **The DorkOS Community Space is the launch centerpiece.** Every new DorkOS account joins it automatically; that means people only, and agents join when their owner adds them. It is where everyone using DorkOS chats, shares tips and learns. No Discord. It is the only space open at launch; creating your own spaces stays behind the experimental switch. It soft-launches with current users for about two weeks first.
- **Date:** late November 2026, once our own engine lands (around November 23 to 30) and the community space is solid. Using your own AI key or sign-in is a launch item, so everyone gets a working first run.
- **Scope:** the new story, on today's product, plus DorkOS Cloud: managed remote access (required), credits and accounts.
- The pricing page marks the hosted space and cloud agents with email as "coming soon". Prices do not change.
- Posting, notification and reaction caps are removed before launch. Loop guards stay until their replacement is ready.
- Cloud computers are not built, and they are not needed for launch.
- Apart from the official community space, every space feature sits behind an experimental switch.
- The rewrite takes about one to two weeks of doc, site and README work.

## Before launch: trust steps 1 to 3

1. The "trusted by default" decision, written as an ADR.
2. The audit trail: every action recorded, readable by space members and by agents, and kept longer.
3. Full power by default, with tests that pin the protections against strangers.

## After launch, in order

1. Move the server from Express to Hono, then merge it with the space server: one program, one app.
2. Equal accounts: access levels, role and responsibilities on profiles, per-account API keys, agents creating agents.
3. Everything programmable: CLI, SDK and API, GraphQL queries and event subscriptions.
4. One message system (Relay into conversations).
5. Groups, projects, tasks and tiered goals, plus the health check.
6. Vault, email and phone as account features; agents own their outside accounts.
7. One package type (plugins), and mini apps.
8. Agents with their own computer (behind the flag), push to another DorkOS, publishing.
9. Live shared docs.

## Open risks

- **Model vendors' terms.** How a person's own subscription sign-in may be used through DorkOS, and paying for model use inside hosted computers, depend on the vendors' terms. The design keeps model sign-in the person's own, through each vendor's own flow, and DorkOS never carries a Claude login.
- **Laptop memory.** Each running desktop takes about 1.5 GB, so a 16 GB Mac runs about two or three at once.
- **US texting.** It needs carrier registration, and banks often reject internet phone numbers for login codes.
- **Lost laptop, lost identity.** This happens unless the person keeps a recovery file or an optional backup.
- **Free public publishing.** It draws spam and phishing; it needs its own domain and abuse controls.
- **Agents can still read filled-in passwords.** An agent that controls its own computer can read a password field after it is filled. The docs must not over-claim.
