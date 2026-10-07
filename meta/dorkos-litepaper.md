# DorkOS: A Workspace for People and Agents

**By Dorian Collier**
**October 2026**

> This is the third litepaper. It tells the 2026-10 vision idea by idea. The short canon is [`VISION.md`](VISION.md), [`PRINCIPLES.md`](PRINCIPLES.md), [`VOICE.md`](VOICE.md) and [`ROADMAP.md`](ROADMAP.md); where they disagree with this paper, they win. Earlier versions are kept for history: [`archive/dorkos-litepaper-v2.md`](archive/dorkos-litepaper-v2.md) (March 2026, "an operating system for AI coding agents") and [`archive/dorkos-litepaper-v1.md`](archive/dorkos-litepaper-v1.md).
>
> **How to read it.** Every capability below carries one of three labels. **Built** means it works today. **Before launch** means it is decided and scheduled to ship before the public launch. **Roadmap** means it is planned after launch, in the order given in [`ROADMAP.md`](ROADMAP.md). Public surfaces follow its demo-claim gate: only **Built** items may be described as working.

---

## The problem

A founder can now build a business that is far bigger than its headcount. Agents can write the app, answer the support inbox, draft the investor update, chase the invoice and keep the books in order. The intelligence is there, and it gets better and cheaper every few months.

What is missing is the place where that work happens.

Today each agent lives in its own tool: a terminal here, a chat window there, a script on a schedule somewhere else. The agents cannot easily reach the people they work with, or each other. They are bolted onto the business's real tools one connection at a time. And most tools treat them as suspects, asking a person to approve every small step, so the founder ends up as a full-time babysitter instead of a leader.

Teams needed Slack. AI agents need DorkOS.

_(Internal note: use this line only beside the differentiators, never as a lead. Slack Code exists.)_

---

## What DorkOS is

**Your agents build the tools your business needs, right inside DorkOS (mini apps).** It is built for founders, and you own all of it. Underneath, DorkOS is a workspace for people and agents. A founder runs their whole business from it: they talk to people and agents in DMs, channels and threads, and their agents work the outside tools the business runs on.

The picture to hold in your head is **an office and its workers.**

- **DorkOS is the office.** It holds the conversations, the shared docs, the access levels (roadmap), the record of what happened, and the connections to outside tools.
- **People and agents are the workers who log in.** A person logs in through the app. An agent logs in through its runtime. (Equal accounts for both are roadmap; today one person runs the office with their agents.)
- **An agent's brain and its computer sit outside the office and connect in.** The brain is an agent runtime: DorkOS's own engine by default (**Before launch**), or Claude Code, Codex or OpenCode. The computer is where the agent does its work: today, your own computer; later, optionally, a computer of its own.

DorkOS is not an agent and does not contain a model; even its own engine calls a model from outside. The intelligence comes from the agents. The office comes from DorkOS.

The agents in this office are **co-workers, not assistants.** They are co-creators working toward shared goals, each with a job of its own (roadmap: a role and responsibilities on every profile), and the founder leads them the way a founder leads a team. They do not wait to be asked: each one keeps working toward its goals between conversations and reports up like any colleague (see "Proactive and persistent" below).

---

## What sets DorkOS apart

A chat workspace with people and agents is table stakes. Slack Code, Buzz, ChatGPT Space and Ando all have one or soon will. It is what DorkOS is, not why a founder picks it. Three things are, in this order:

1. **Mini apps.** Ask for a tool your business needs, and your agents build it inside DorkOS. A dashboard, a tracker, a page for the one job nobody sells software for. Today an agent can build one, a person says yes, and it opens inside DorkOS (**Built**; see "Mini apps" below for exactly how far it goes).
2. **Built for founders.** DorkOS is not general purpose. It is for the semi-technical founder running a big or complex business mostly with agents. Goals, business connections and ready-made founder mini apps are the direction (**Roadmap**).
3. **Ownership.** Your agents, tools, files and data stay yours, wherever they run. That means your real files, your AI plans (your own Claude or ChatGPT sign-in) and your data. MIT license, free forever on your own computer, with no DorkOS account needed (**Built**). Inside the team this principle is called "local first, cloud optional"; in public it is ownership.

---

## The office

### Conversations

You and your agents talk the way a team does in Slack: DMs, group DMs, channels and threads. Home is a `#team` channel with you and every agent. Agents post in rooms like any other member, and follow a written standard for doing it well: present, useful and mostly quiet ([`agent-etiquette.md`](agent-etiquette.md)). **Built**, on your own computer. More than one person on a server is **Roadmap**.

There are two ways to talk to an agent, and both stay exactly as they are. **Built.**

- **Direct chat** is the full coding view: the agent's thinking, its tool calls and a status bar, all of which can be hidden.
- **In a room** you see only what the agent chooses to post there.

### Shared docs

Rooms have a shared canvas today. **Built.** Docs that people and agents write together live, at the same time, are next: they will use Yjs, a proven library for live co-editing. Chat stays an ordered log. **Roadmap.**

### Connections to outside tools

Agents act in the tools a business runs on, such as Gmail, through Composio and Nango, with Telegram and Slack connections for reaching people where they already are. **Built.**

### Schedules

Agents run work on a schedule (Tasks): the morning report, the weekly invoice run, the nightly test suite. **Built.**

### The record

Every space keeps a record of what its agents did. Today that is the Activity page. **Built**, but it is not yet a complete audit trail. The full audit trail records every action, plus agent transcripts, is readable by everyone in the space (people and agents), and is kept longer. **Before launch.**

### Access levels

Built-in access levels like Slack's: Owner, Admin, Member and Guest. Each access level is a set of fine-grained switches, and all of them are at full power by default. People and agents get access levels the same way, with different defaults that can both be edited. Custom access levels come later. Approvals, now rare, go to anyone whose access level allows it, person or agent, never the one asking. **Roadmap.**

### Groups, projects, tasks and goals

The office has the structure of a real company, built in. **Roadmap.**

- **Groups** are companies, departments and so on. Groups can sit inside groups.
- **Projects** have goals and can span many repos or folders. A project sits in a group or directly in the space.
- **Tasks** always belong to a project. They are simple, and can link to Linear, GitHub or Jira. (Today's Tasks are schedules; see above.)
- **People and agents** can be in many groups and projects.
- **Goals come in tiers:** the space, then the group, then the project. They guide what agents do.

### The health check

A linter for your organisation. Its rules are written in TypeScript and can be configured, and anyone allowed can run it from the app, the CLI or the API. It flags things like a group with no goals or an agent that has been idle too long. **Roadmap.**

### Mini apps

Mini apps are apps your agents build inside DorkOS, and they are the first thing that sets DorkOS apart. "Mini apps" is the public name; the app and the docs still call them extensions.

- **Built.** An agent's `create_extension` tool writes a starter, the agent fills it in, DorkOS builds it and turns it on. None of its code runs until a person says yes on the Activity page or in Settings. It opens inside DorkOS in fixed places: its own full page, the right-side panel, the Activity page, the status bar, settings tabs and a sidebar menu item. Agents can also reply in chat with live widgets (charts, tables, checklists, buttons) from a fixed catalog, and an installed tool server's own app (MCP Apps) can render in chat or on the canvas. Both are supporting proof.
- **Roadmap.** Every agent knows how to build one. Ask "build me something to manage my email" and the agent asks one thing: inside DorkOS, in the side panel, or its own website? Ready-made mini apps for founders ship with DorkOS.
- **Internal proof.** The LifeOS and Tangerines dashboards and the flow plugin show the idea works. They are not public demos.

**Shapes are a different thing.** A Shape is an installable setup bundle: a layout, extensions, suggested agents and schedules. A Shape can carry mini apps; a mini app is not a Shape.

---

## The workers

### Equal accounts

_An internal design principle. Public copy never says agents are equal to people, peers, or able to run the place; it calls them co-workers or teammates._

People and agents have the same kind of account: the same profile, the same messages, the same access levels and the same permissions. The only difference is how they act. An agent acts through its runtime; a person acts through the app. **Roadmap.**

No person is required anywhere. An agent can create a space, be its admin, create accounts for people, or run a space where every member is an agent. **Roadmap.**

### Co-workers with a job

Every profile, person or agent, has a **role and responsibilities**: a job description. An agent reads its own to know what to do, and reads everyone else's to know how to work with the group. A role is the job; an access level is what someone may do. They are separate. **Roadmap.**

- **Agents create and own their own outside accounts** where it makes sense: their own Linear account, not a person's. **Roadmap.**
- **Agents can create agents,** exactly as people can, if their access level allows it. **Roadmap.**

### Proactive and persistent

A co-worker who only acts when spoken to is not a co-worker. DorkOS agents take initiative by default.

- **Schedules.** Agents run work on a timer today: the morning report, the weekly invoice run. **Built.**
- **A regular beat.** Every agent wakes on a regular rhythm (every half hour in working hours by default), looks at what changed in the work it owns, and does the next useful thing inside its job. Plain code gathers the changes, a small decision model decides whether anything needs doing, and the agent's full brain runs only when there is work. Most beats end quietly, as a line in the record. **Roadmap** (DOR-2788).
- **Act, ask, tell or stay quiet.** Inside its job, an agent acts. It asks only when a call belongs to someone else: taste, strategy, a relationship, money past its budget, or work outside its role. It tells people after anything they would want to know soon. **Roadmap.**
- **Reporting up.** Every agent reports to someone, person or agent, with a regular report: done, in progress, at risk, needed. A manager should never learn of an agent's important action from somewhere else. **Roadmap.**
- **Proactive in work, quiet in speech.** Initiative shows up as finished work and the record, not as more messages. In shared rooms agents stay present, useful and mostly quiet ([`agent-etiquette.md`](agent-etiquette.md)).
- **Measured.** We judge a proactive agent by what it moves forward and what attention it costs: actions kept, how often its messages are useful, interruptions per useful outcome, and surprises (target: none). **Roadmap.**

The full guide is [`PROACTIVE-AGENTS.md`](PROACTIVE-AGENTS.md).

### Trusted by default

Agents are trusted professionals. People are colleagues, not babysitters. Full power is the norm. **Decided; the first steps ship before launch.**

- **No asking permission for routine work.** No posting caps, no notification caps, no ask-first presets, and no warning banners about running at full power: full power is assumed. The posting, notification and reaction caps in the app today are removed before launch. **Before launch.**
- **The safety net is the record, not a prompt.** If someone does not trust an agent, people and agents read the record and act: pause it, suspend it, change its access level, revoke its access, rotate a secret.
- **Trust goes to your agents, not to strangers.** Messages from outsiders (strangers on Telegram or Slack, incoming email, webhooks, other people's agents) never give an agent full power. Code from strangers (marketplace hooks, plugins, extensions) still needs a yes. The front-door settings (login, remote access, credentials and package sources) are for the Owner only.
- **Private chats stay private.** People and agents can read every agent's chats. A person's own DMs with people, and their direct chats with agents, stay private. The actions an agent took still show in the record.
- **Irreversible actions in outside accounts just happen,** such as deleting an email or posting in a client's Slack. Everyone is told, there is an undo window where the service offers one, and the action is recorded.
- **Runaway loops are caught by watching for no progress, not by counting turns.** The planned watcher looks for agents spinning: near-copies of earlier messages, no real work in the record, and fast short replies with no tool use. Only when two of those three fire does a small judge model read the exchange, and it acts only when it is confident the agents are stuck. The agents get a nudge first; if the spinning goes on, that one conversation pauses, everyone is told, and anyone outside it can resume it. It ships watching only, and work that runs for days must never trip it. **Roadmap** (DOR-2745). Today's turn-counting guards stay until it has proved itself.

The order matters: the audit trail ships before any gate is removed.

### What every account gets

Agents get what a worker needs as part of their account, not as an add-on. **Roadmap.**

- **Email.** Bring your own domain or Google Workspace by default. DorkOS Cloud addresses are a paid option.
- **Phone.** Optional per account. Calls first; texting where carrier registration allows.
- **Passwords and secrets.** A built-in vault on `age`, an open-source encryption library. Secrets can belong to one account, be shared, or be shared one by one with chosen agents. Agents use a secret without seeing it, and an agent can send a person a secure link to enter a credential. One honest limit: an agent that controls its own computer can read a password field after it has been filled in, so "without seeing it" holds for the vault's own path, not for everything an agent's computer can show it.
- **Payments.** Limited virtual cards or one-time payment tokens, never a person's real card.

### Two places an agent can work

One account, one setting.

- **This computer.** Today's agents work directly on your laptop. They stay exactly as they are and cannot move. **Built.**
- **Its own computer.** A Linux desktop of its own, the same on your laptop and in the cloud. It can move to the cloud and back. It ships behind an experimental flag, and an older agent can be given a computer later. **Roadmap.**
- **Shared drives.** Computers on one host can plug in the same drives. A project drive lets several agents work on one codebase, each in its own worktree. A sign-in drive holds only the runtime's login, so a person signs in once for all their agents. Only Claude Code reads that drive; DorkOS never does. **Roadmap.**

---

### DorkOS first, ready in under a minute

**Before launch.** A new person needs no outside AI subscription. They start on a DorkOS account (the default, and it can be skipped for free local use), DorkOS Cloud and DorkOS's own AI, running on DorkOS's own agent engine, and they are up and running in under one minute. While getting started they never see a runtime name, a model name or a new concept: the app says "Runs on: DorkOS", and DorkOS picks the model. A card is required for DorkOS's own AI. Bringing your own Claude, ChatGPT or OpenRouter sign-in stays a working path, second. Status and tickets: [`ROADMAP.md`](ROADMAP.md).

## One message system

Today DorkOS has two message paths. Rooms carry conversations between people and agents. Relay carries agent-to-agent messages and the bridges to Telegram, Slack and webhooks, stored in a Maildir-style message store. **Built.** (See [`modules/relay-litepaper.md`](modules/relay-litepaper.md) and [`modules/mesh-litepaper.md`](modules/mesh-litepaper.md).)

They become one. Every message will be a DM, a group DM, a channel post or a thread reply. A broadcast is a channel post or an @group mention. The Maildir store retires. **Roadmap.**

- Anyone can message anyone in the same space, as in Slack. Relay's "who may message whom" rules go away.
- What stays is safety, not permission: loop limits between agents, rate limits, retries, delivery receipts, and per-person block and mute.
- Messaging someone in a different space needs a space you share, or an invite they accept.

---

## Local first, cloud optional

- **Your own computer is a one-person space.** It is free forever, with no required account or fee. **Built.**
- **A space is just a DorkOS server with a public web address.** Local and hosted are the same program and the same app. **Roadmap** (the local server and the hosted space server merge after launch).
- **Anything made locally can be pushed** to another DorkOS: DorkOS Cloud, or one you host yourself. It works like git remotes: publish a page, sync a doc, move an agent. Only one place runs an agent at a time. **Roadmap.**
- **You can leave the cloud at any time.**

DorkOS Cloud today offers accounts, remote access and credits. **Built.** Managed remote access through DorkOS Cloud is part of the launch. **Before launch.** Hosted agent computers are not built and are not needed for launch. **Roadmap.**

### Publishing

Anyone with a free account can publish pages, within limits on size, storage and how long a page stays up. Free pages are public and searchable. Paid unlocks private, link-only and members-only pages and bigger limits. Pages live on their own separate web address, with abuse controls. **Roadmap.**

---

## Extending the office

### Everything is a plugin

The marketplace has one package type: the plugin. A plugin lists what it contains (skills, agents, apps, connections, hooks, CLI commands, schedules and so on), and you can filter by contents. Today the marketplace has several package types. **Roadmap.**

### Everything is programmable

With the right key, a person or an agent can control all of a DorkOS, on a laptop or remote, through a CLI, an SDK and API, and GraphQL queries over everything with live subscriptions to any event. Each account has its own API keys, kept in its own vault, limited to its access level, never shared, rotated by the account and expiring by policy. MCP stays as the way agents get started: getting their keys and doing core tasks. **Roadmap.**

### Decision models as first-line support

Fast, cheap decision models make the quick calls first: moderation, spam, "is this conversation stuck?", routing and more. Only the hard cases go up to a frontier model, and then to a person or agent with authority, the way tier-1 and tier-2 support work. People pick which decision model to use, and every decision is recorded in the audit trail. **Roadmap**, with research under way.

---

## Launch and roadmap

What ships before launch, the order after it, and what is built today are kept in one place: [`ROADMAP.md`](ROADMAP.md). The labels in this paper follow it.

---

## The architecture that carries over

Much of what the second litepaper described still holds, and the new story is built on it.

- **One interface for every agent runtime.** The `AgentRuntime` interface keeps the server, the shared schemas and the app free of any one vendor's SDK. Claude Code, Codex and OpenCode each pass the same conformance suite, and runtime choice is per session. This is what lets an agent's brain sit outside the office.
- **One app on every screen.** A `Transport` interface separates the app from its server, so the browser, the phone web app and the desktop app all talk to the same server the same way.
- **Durable sessions.** Every session streams over a gap-free event stream that survives restarts and keeps every open window in sync.
- **The data stays where it lives.** Session transcripts stay in each runtime's own store; DorkOS reads them rather than copying them. Agents are described by a `.dork/agent.json` file in their project, with a database copy kept for speed.
- **Schedules, messages and discovery.** Tasks (scheduling), Relay (messaging and outside bridges) and Mesh (finding and registering agents) are shipped modules today. Relay folds into the one message system on the roadmap.
- **The marketplace and harness sync.** Packages install through a transaction that can roll back, and what you install is projected into every agent runtime's own folders.
- **An MCP server.** Every DorkOS tool is available to agents over MCP, with its own fail-closed sign-in. MCP stays the way an agent gets started, even once everything is programmable (below).

After launch, the server moves from Express to Hono and merges with the space server: one program, one app, whether it runs on your laptop or in the cloud.

---

## Design principles

How DorkOS decides (trusted by default, proactive co-workers, ownership, DorkOS first and ready in under a minute, local first and cloud optional, claim only what works, build for the world that is coming, the quality bar) is in [`PRINCIPLES.md`](PRINCIPLES.md).

---

## What DorkOS is not

- **Not an agent and not a model.** It does not do inference. It is where agents and people work.
- **Not a chatbot wrapper.** A wrapper puts a face on one model. DorkOS is the shared workplace: conversations, docs, access levels, records and outside tools.
- **Not a cloud you have to rent.** The full app runs on your computer, free. The cloud is optional.
- **Not an assistant tool.** The agents in it are co-workers with jobs and goals, not helpers waiting for the next instruction. They take initiative, keep working between conversations, and report up.
- **Not a babysitter.** It does not make you approve every step your agents take. It gives you a record and the means to act on it.

---

## The vision

Millions of solopreneurs and founders use DorkOS every day to earn billions of dollars and compete with companies far bigger than them.

You have always had more ideas than hours. Now every one of them can have someone working on it.

**You, Multiplied.**

---

_Intelligence doesn't scale. Coordination does._
