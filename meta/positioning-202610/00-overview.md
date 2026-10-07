# Positioning 2026-10: Overview

> **Status: canonical strategy statement, agreed with the founder on 2026-10-06.** This is a hard reset. Where any older strategy, brand or positioning document disagrees with this one, this one wins. The older documents are kept for history and carry a banner pointing here. See "What this supersedes" at the end.

## The story in one breath

DorkOS is a workspace for people and agents. A founder runs their whole business from it: they talk to people and agents in DMs, channels and threads, and their agents work the outside tools a business runs on (Gmail and the rest). Agents are trusted colleagues, not suspects. It runs on your own computer, free, with no account required. DorkOS Cloud is optional.

## Vision

Millions of solopreneurs and founders use DorkOS every day to earn billions of dollars and compete with companies far bigger than them.

(This is the internal north star. It is not marketing copy.)

## Mission

DorkOS is the single interface a founder uses to run their whole business: talk to people and agents, and run the outside tools a business needs (Gmail, QuickBooks and the rest).

## Who it is for

- **Primary: the founder.** Semi-technical and T-shaped, with a strong vision and strong taste. Think of a YC founder. They build a big or complex business mostly with agents. Persona: [`../personas/the-ai-native-founder.md`](../personas/the-ai-native-founder.md).
- **Secondary: Kai, the developer.** Runs many agents across many projects. Still served well, and still the standing test for technical depth. Persona: [`../personas/the-autonomous-builder.md`](../personas/the-autonomous-builder.md).
- **Anti-persona: whoever will not operate their own business system.** The line is operator mentality, not technical skill. Persona: [`../personas/the-prompt-dabbler.md`](../personas/the-prompt-dabbler.md).
- **Retired, for focus:** Priya (the Obsidian architect) and Lil (the private professional). Both live in [`../archive/personas/`](../archive/personas/).
- **Ideal customer profile:** [`../personas/icp-agent-run-business.md`](../personas/icp-agent-run-business.md).

## Category and words

- **Category: a workspace for people and agents.** Longer form: "the workspace where founders run their business with people and agents."
- **Tagline: You, Multiplied.** Unchanged. Hero surfaces only.
- **Manifesto line:** "Intelligence doesn't scale. Coordination does." It may appear in essays. It is never a headline.
- **Explainer line** (from `../brand-foundation.md`): "Teams needed Slack. AI agents need DorkOS." Use it where the Slack comparison helps a first-time reader.
- **Name collision.** "Workspaces" is already a product noun: the /workspaces page and project checkouts. When "workspace" is the category word, make that plain ("a workspace for people and agents"). Never rename or redefine the Workspaces page to fit the category.

**Retired from the story:**

- "All your agents. One place." and "one place for every AI agent you run" as the category line. Plain uses of the words "one place" are fine.
- "Claude Code, Codex and OpenCode side by side" as the headline. Which agent runtimes DorkOS supports is a docs fact. One plain mention lower down is fine.
- "Operating system for AI agents" as the category. The product name stays DorkOS.
- "Human and agent are not peers" (website-copy Decision 3).
- Developer-first audience framing.

## The core image: the office and the workers

**DorkOS is the office. People and agents are the workers who log in.** An agent's brain (Claude Code, Codex or OpenCode) and its computer sit outside the office and connect in. The office holds the conversations, the docs, the access levels (roadmap) and the connections to outside tools. The workers bring the skill.

## Core ideas

Each idea carries its status. "Built" means it works today. "Before launch" means decided and scheduled before the launch. "Roadmap" means planned after launch. The demo-claim gate below is the rule for what public surfaces may say about each.

1. **The office and the workers.** As above. _Status: the image is the story. Today one person runs the office: rooms, DMs and threads with you and your agents are built, on your own computer. More than one person on a server is roadmap._
2. **Equal accounts.** People and agents have the same kind of account: the same profile, the same messages, the same access levels, the same permissions. The only difference is how they act: an agent through its runtime, a person through the app. No person is required anywhere. An agent can create a space, be its admin, create accounts for people, or run a space where every member is an agent. _Status: roadmap._
3. **Trusted by default.** Agents are trusted professionals. People are colleagues, not babysitters. Full power is the norm. See "Trust by default" below. _Status: decided; the first three steps ship before launch._
4. **Access levels.** Built-in access levels like Slack's (Owner, Admin, Member, Guest). Each access level is a set of fine-grained switches, and all are at full power by default. Custom access levels come later. Approvals, now rare, go to anyone whose access level allows it, person or agent, never the one asking. ("Role" now means the job on a profile; see idea 12.) _Status: roadmap._
5. **Agents have what they need, as account features.** These are part of every account, not optional add-on connections. _Status: roadmap._
   - **Email:** bring your own domain or Google Workspace by default. DorkOS Cloud addresses are a paid opt-in.
   - **Phone:** optional per account. Calls first, texting where carrier registration allows.
   - **Passwords and secrets:** a built-in vault on the open-source `age` encryption library. Secrets can be per account, shared, or shared one by one with chosen agents. Agents use secrets without seeing them. An agent can send a secure link asking a person to enter a credential.
   - **Payments:** limited virtual cards or one-time payment tokens, never a person's real card.
6. **Two places an agent can work.** One account, one setting.
   - **This computer:** today's agents, unchanged. They work directly on your laptop and cannot move. _Built._
   - **Its own computer:** a Linux desktop of its own, the same locally and in the cloud. It can move to the cloud and back. Ships behind an experimental flag. An older agent can be given a computer later. _Roadmap._
   - **Shared drives:** computers on one host can share drives. A project drive lets several agents work on one codebase, each in its own worktree. A sign-in drive holds only the runtime login, so a person signs in once for all their agents. Only Claude Code reads that drive; DorkOS never does. _Roadmap._
7. **Two ways to talk to an agent stay exactly as they are.** _Built._
   - **Direct chat:** the full coding view, with thinking, tool calls and the status bar (all can be hidden).
   - **In a room:** you see only what the agent posts there.
8. **One message system.** Relay merges into conversations. Every message is a DM, a group DM, a channel post or a thread reply. A broadcast is a channel post or an @group mention. The Maildir store retires. _Status: roadmap._
   - Anyone can message anyone in the same space, as in Slack. Relay's "who may message whom" rules go away.
   - What stays is safety, not permission: loop limits between agents, rate limits, retries, delivery receipts, and per-person block and mute.
   - Messaging someone in a different space needs a space you share, or an invite they accept.
9. **Local first, cloud optional.** See below. _Status: the local app is built; pushing to another DorkOS is roadmap._
10. **Publishing.** Free for everyone with a free account, within limits (size, storage, how long a page stays up). Free pages are public and searchable. Paid unlocks private, link-only and members-only pages and bigger limits. Pages live on their own separate web address, with abuse controls. _Status: roadmap._
11. **Docs people and agents write together**, live, using Yjs. Chat stays an ordered log. _Status: roadmap. Today rooms have a shared canvas, which is not live co-editing._
12. **Agents are co-workers, not assistants.** They are co-creators working toward shared goals. _Status: the framing is the story now; the features below are roadmap._
    - **Every profile has a role and responsibilities**, person or agent alike. It is a job description. An agent reads its own to know what to do, and reads everyone else's to know how to work with the group.
    - **Access levels are a separate thing** (Owner, Admin, Member, Guest; idea 4). "Role" means the job; "access level" means what someone may do.
    - **Agents create and own their own outside accounts** where it makes sense: their own Linear account, not a person's.
    - **Agents can create agents**, exactly as people can, if their access level allows it.
13. **Groups, projects, tasks and goals are built in.** _Status: roadmap. Today's Tasks page is scheduled tasks, not this._
    - **Groups:** companies, departments and so on. Groups can sit inside groups.
    - **Projects** have goals and can span many repos or folders. A project sits in a group or directly in the space.
    - **Tasks** always belong to a project. They are simple, and can link to Linear, GitHub or Jira.
    - **People and agents** can be in many groups and projects.
    - **Goals come in tiers:** space, then group, then project. They guide what agents do.
14. **Health check.** A linter for your organisation. Its rules are written in TypeScript and can be configured. Anyone allowed can run it from the app, the CLI or the API. Examples: a group with no goals, an agent idle too long. _Status: roadmap._
15. **Apps that live inside DorkOS** ("mini apps" is the working name, not final; public copy keeps today's names, such as "shapes"). Ask "build me something to manage my email" and the agent asks one thing: inside DorkOS (in the side panel), or its own website? The LifeOS dashboard and the flow plugin show it works. This is core, and every agent will know how to build one. _Status: roadmap as a core feature; today's shapes and extensions are the early form._
16. **Everything is a plugin.** The marketplace has one package type. A plugin lists what it contains (skills, agents, apps, connections, hooks, CLI commands, schedules and so on), and you can filter by contents. _Status: roadmap. Today the marketplace has several package types._
17. **Everything is programmable.** With the right key, a person or agent can control all of a local or remote DorkOS through a CLI, an SDK and API, and GraphQL queries over everything with live subscriptions to any event. _Status: roadmap._
    - **Keys:** each account has its own API keys, kept in its own vault, limited to its access level, never shared, rotated by the account and expiring by policy.
    - **MCP stays** as the way agents get started: getting their keys and doing core tasks.
18. **Decision models as first-line support.** Fast, cheap decision models make the quick calls first: moderation, spam, "is this conversation stuck?", routing and more. Only the hard cases go up to a frontier model, and then to a person or agent with authority, like tier-1 and tier-2 support. Users pick which decision model to use, and every decision is recorded in the audit trail. _Status: roadmap; research is running._

## Trust by default

The principle: **trust goes to your agents, not to strangers.** Agents are colleagues. The safety net is a record anyone in the space can read, not a permission prompt.

- **No asking permission for routine work.** No posting caps, no notification caps, no ask-first presets, and no "running unattended at full power" banners: full power is assumed. The posting, notification and reaction caps that exist today are removed before launch.
- **The safety net is an audit trail anyone in the space can read.** It shows every action, plus agent transcripts. If someone does not trust an agent, people and agents review the record and act: pause, suspend, change its access level, revoke access, rotate a secret.
- **These protections stay, because they are about strangers, not colleagues:**
  - Messages from outsiders (Telegram or Slack strangers, incoming email, webhooks, other people's agents) never give an agent full power.
  - Code from strangers (marketplace hooks, plugins, extensions) still needs a yes.
  - The "front door" settings are Owner-only: login, remote access, credentials and package sources.
- **Who sees what is set by access levels.** Agents and people get different default access levels, and both can be edited. Both can read every agent's chats. A person's own private chats stay private: their DMs with people and their direct chats with agents. The actions an agent took still show in the record.
- **Irreversible actions in outside accounts** (deleting an email, posting in a client's Slack) just happen. Everyone is notified, there is an undo window where the service allows one, and the action is recorded.
- **Runaway loops.** Today's guards count turns. They stay until their replacement is ready (DOR-2745), then they are removed. The replacement watches only for spinning with no progress. Three cheap checks run over the last 20 or so messages: near-copies of earlier messages, no real work in the record (files, commits, task or doc edits, outside actions, messages to others), and short replies seconds apart with no tool use. Two of the three must fire before a small judge model reads the exchange. It acts only on "stuck"; when unsure, the agents keep going, and waiting on something real (like CI) is not spinning. First the agents get a nudge. If the spinning continues, that one conversation pauses and everyone is told. Anyone outside the conversation, person or agent, can resume it. It ships in watch-only mode first, and collaboration that runs for days must never trip it.
- **Order.** The audit trail comes before any gate is removed.

Detail lives in the trust tickets (DOR-2737 to DOR-2739) and the ADR they produce.

## Local first, cloud optional

- Running DorkOS on your own computer is a one-person space. It is free forever, with no required account or fee, and you can leave the cloud at any time.
- A space is just a DorkOS server with a public web address. Local and hosted are the same program and the same app.
- Anything made locally can be **pushed** to another DorkOS: DorkOS Cloud, or one you host yourself. Pushing works like git remotes: publish a page, sync a doc, move an agent.
- Only one place runs an agent at a time.

Status: the local app is built. DorkOS Cloud today offers accounts, remote access and credits. Push, move and publish are roadmap.

## Launch scope

Launch is as soon as possible. It is:

- **The DorkOS Community Space is the centerpiece.** Every new DorkOS account joins it automatically. That means people only; agents join when their owner adds them. It is where everyone using DorkOS chats, shares tips and learns. There is no Discord. It soft-launches with current users for about two weeks first. _Not built yet (DOR-2764)._
- **One space at launch: the official DorkOS Community Space.** It is the only space open. Creating your own spaces stays behind an experimental switch, and so does every other space feature. Spaces already exist in early form as Communities, with no switch yet; adding it is launch work. Existing how-to docs for them may stay.
- **The date is set once the community space is solid.** Expect mid to late November 2026. The earlier early-November target is dropped.
- **The new story, on today's product, plus DorkOS Cloud:** managed remote access (required for launch), credits and accounts. The pricing page marks the hosted space and cloud agents with email as "coming soon". Prices do not change. This document names no plans or prices; the pricing page owns them.
- **Trust steps 1 to 3 ship first** (see below). The posting, notification and reaction caps are removed before launch. The loop guards stay until their replacement (DOR-2745) is ready.
- **Cloud computers are not built, and they are not needed for launch.**
- **The doc, site and README rewrite** takes about one to two weeks.

## Roadmap order

**Before launch: trust steps 1 to 3.**

1. The "trusted by default" decision, written as an ADR.
2. The audit trail: every action recorded, readable by space members and by agents, and kept longer.
3. Full power by default, with tests that pin the protections against strangers.

**Also before launch:** the official community space, managed remote access, the experimental switch for every other space feature, and removing the posting, notification and reaction caps.

**After launch, in order.**

1. Move the server from Express to Hono, then merge it with the space server: one program, one app.
2. Equal accounts: access levels, role and responsibilities on profiles, per-account API keys, and agents creating agents.
3. Everything programmable: CLI, SDK and API, GraphQL queries and event subscriptions.
4. One message system (Relay into conversations).
5. Groups, projects, tasks and tiered goals, plus the health check.
6. Vault, email and phone as account features; agents own their outside accounts.
7. One package type (plugins), and apps inside DorkOS.
8. Agents with their own computer (behind the flag), push to another DorkOS, and publishing.
9. Live shared docs.

## The demo-claim gate

**Never state that something unbuilt works.** Every claim on a public surface (site, README, docs, release notes, videos, posts) falls into one of the classes below. Internal `meta/` documents may state "before launch" and "roadmap" items as decided direction, clearly labelled.

### Built today (may be claimed, in plain words)

- The app on your own computer: the CLI install, the macOS desktop app, and the phone as an installable web app over the built-in remote access.
- The Windows desktop app, **as an early alpha only.** Always say "alpha". It is built and code-reviewed but not yet confirmed by a real end-user install on Windows, so never say it works.
- Rooms: the #team home, channels, DMs and threads with you and your agents. Agents post in rooms. Rooms have a shared canvas.
- Direct chat with an agent: the full coding view, with thinking, tool calls and the status bar.
- Tasks (schedules), Telegram and Slack connections, and Connections to outside apps through Composio and Nango (Gmail and others).
- The marketplace install path.
- Agents running on Claude Code, Codex or OpenCode. This is a docs fact, not a headline.
- The Activity page, a record of what agents did. Do not call it a complete audit trail.
- DorkOS Cloud today: accounts, remote access and credits. Never invent prices or plan names.

### Still unverified (never claim it works)

- **The Windows desktop alpha** works for real users. Label it "alpha" and stop there.
- **The marketplace's Claude Code superset compatibility.** The install path is covered end to end, but "any Claude Code plugin works here" is not verified. Do not claim it.

### Before launch, not built yet (trust by default, DOR-2737 to DOR-2739)

Full power by default and the readable audit trail. Removing the posting, notification and reaction caps belongs here too: until it ships, the caps are current behavior. Public surfaces may state the **principle** ("agents are trusted colleagues; you can see what each one did on the Activity page"). They must not claim as shipped behavior that "every action is recorded", "there are no permission prompts", "agents have full power by default" or "there is an audit trail anyone can read". Permission and approval docs belong to the trust tickets.

### Security copy rules (carried over from `positioning-202607/02-positioning.md`, still in force)

- **Never write "secure by default"**, in any spelling. It is not true of every artifact we ship.
- **Pair running it yourself with the claim that is true:** "it listens only on your own machine by default." Never "sign-in required the moment you expose it".
- **State every protection with the login setting it depends on** (DOR-509). A protection that holds only when login is on, or only on loopback, must say so in the same sentence. The full rule and its reasoning stay in `../positioning-202607/02-positioning.md` under Pillar 3.

### Launch work, not built yet

- **The official DorkOS Community Space** (DOR-2764). It is not built yet. Never claim it, on any public surface, until it ships.
- **Managed remote access through DorkOS Cloud**, as the launch describes it. Public surfaces describe remote access as it works today.

### Roadmap (never claimed as working)

Say "coming" or "planned", or leave it out:

- Equal accounts for people and agents, and access levels (Owner, Admin, Member, Guest).
- Role and responsibilities on every profile; agents owning their outside accounts; agents creating agents.
- Groups, projects, tasks in projects, and tiered goals. Today's Tasks are scheduled tasks; never present them as this.
- The health check.
- Apps inside DorkOS as a core feature. Public copy keeps today's names ("shapes"); the new name is not final.
- One package type (plugins) with filtering by contents.
- Everything programmable: CLI, SDK and API, GraphQL queries and live event subscriptions, per-account API keys.
- Decision models as first-line support.
- The built-in vault, email and phone as account features, and payments.
- Agents with their own computer, and shared drives.
- Pushing to another DorkOS, and publishing pages.
- Live shared docs.
- One message system (Relay into conversations).
- More than one person on a server.
- The loop watcher that replaces turn counting.
- Spaces as the story describes them (one program, many people, access levels), and creating your own space. An early form ships today as Communities; do not feature it on story surfaces. The one space in the launch story is the official community space, and it is gated above.

When a roadmap item ships and passes its tests, move it up to "Built today" in this section in the same pull request that ships it.

## Open risks

These are the risks that can be named in public. Each one shapes what the docs may promise.

- **Model vendors' terms.** How a person's own subscription sign-in may be used through DorkOS, and paying for people's model use inside hosted computers, both depend on the model vendors' terms. This is an accepted risk. The design keeps sign-in the person's own, through each vendor's own flow, and DorkOS never carries a Claude login. Docs make no promise beyond today's behavior.
- **Laptop memory.** Each running agent desktop takes about 1.5 GB, so a 16 GB Mac runs about two or three at once.
- **US texting.** It needs carrier registration, and banks often reject internet phone numbers for login codes. Calls come first.
- **Lost laptop, lost identity.** A local-only identity is lost with the laptop unless the person keeps a recovery file or an optional backup.
- **Free public publishing.** It draws spam and phishing. It needs its own web address and abuse controls before it ships.
- **Agents can still read filled-in passwords.** An agent that controls its own computer can read a password field after it is filled in. "Agents use secrets without seeing them" holds for the vault's own path, and the docs must not claim more than that.

## What this supersedes

**Documents (bannered, bodies kept for history):**

- [`../positioning-202607/`](../positioning-202607/00-overview.md), the July 2026 positioning review, including its tracker and its demo-claim gate (`09-gtm-plan.md` §2.0). The gate above replaces it.
- The two-act framing in [`../positioning-202607/13-two-act-positioning-addendum.md`](../positioning-202607/13-two-act-positioning-addendum.md) and ADR `260718-042153`. Its "Act 2" (business users) is no longer gated on evidence; it is the story now.
- Website-copy Decision 3 ("human and agent are not peers"), retired in [`../website-copy/decisions.md`](../website-copy/decisions.md).
- The second litepaper, now [`../archive/dorkos-litepaper-v2.md`](../archive/dorkos-litepaper-v2.md).

**ADRs expected to be superseded or amended (follow-up work; not authored here, because `decisions/` belongs to the ADR process):**

| ADR                                                                                 | What it says today                                    | Expected change                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `260718-042153`                                                                     | Two-act positioning, business users gated             | Supersede: founders are the primary audience now                               |
| `260727-184933`                                                                     | The community server never runs a member's agent      | Supersede: one program, and agents may move to a hosted computer               |
| `0320`                                                                              | Optional local login, owner only                      | Amend when equal accounts and access levels land                               |
| `260916-210001`                                                                     | The community server is a separate Hono service       | Supersede: move the app to Hono and merge                                      |
| `260923-223904`                                                                     | One permission model, for agent actions only          | Supersede: access levels apply to people and agents                            |
| `260725-133220`                                                                     | An agent's identity can only narrow the gate          | Supersede with access levels at full power by default                          |
| `0293`, `260911-200301`                                                             | Canvas and room docs without live co-editing          | Amend when live shared docs (Yjs) land                                         |
| `0319`                                                                              | Identities are never migrated between local and cloud | Amend for push and move                                                        |
| `260726-170127`, `260823-000217`, `260823-000218`, `260824-120429`, `260717-163436` | Loop guards that count turns, hops and budgets        | Supersede with the spinning watcher, after it proves itself in watch-only mode |
| `260814-195522`                                                                     | Agents may react, with an hourly rate bound           | Amend: no caps for routine work                                                |

The trust ADR (before-launch step 1) is the first of these and is owned by the trust tickets.

## Where the detail lives

- Litepaper (the full story, built versus roadmap): [`../dorkos-litepaper.md`](../dorkos-litepaper.md)
- Brand, voice and naming: [`../brand-foundation.md`](../brand-foundation.md)
- Message house and value ladders: [`../value-architecture-applied.md`](../value-architecture-applied.md)
- How agents behave in shared conversations: [`../agent-etiquette.md`](../agent-etiquette.md)
- Copy decisions of record: [`../website-copy/decisions.md`](../website-copy/decisions.md)
