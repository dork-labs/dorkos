# DorkOS Principles

> **Canon.** How we decide, for people and agents working on DorkOS. Part of the north-star set with [`VISION.md`](VISION.md), [`VOICE.md`](VOICE.md) and [`ROADMAP.md`](ROADMAP.md). When two good options compete, these break the tie.

## 1. Trusted by default: trust our agents, not strangers

Agents are trusted professionals. People are colleagues, not babysitters. Full power is the norm.

_Status: decided, not built yet. Today the caps exist and the loop guards count turns; see [`ROADMAP.md`](ROADMAP.md)._

- **No asking permission for routine work.** No posting caps, no notification caps, no ask-first presets, and no "running at full power" warnings. Full power is assumed.
- **The safety net is a record, not a prompt.** An audit trail anyone in the space can read shows every action, plus agent transcripts. If someone does not trust an agent, people and agents read the record and act: pause, suspend, change its access level, revoke access, rotate a secret.
- **Strangers do not get that trust.** These protections stay:
  - Messages from outsiders (Telegram or Slack strangers, incoming email, webhooks, other people's agents) never give an agent full power.
  - Code from strangers (marketplace hooks, plugins, extensions) still needs a yes.
  - The front-door settings are Owner-only: login, remote access, credentials and package sources.
- **Privacy comes from access levels.** People and agents get different default access levels, and both can be edited. Both can read every agent's chats. A person's own private chats stay private. What an agent did still shows in the record.
- **Irreversible actions in outside accounts just happen.** Everyone is told, there is an undo window where the service allows one, and the action is recorded.
- **Watch for spinning, not for length.** A loop guard looks for agents going round in circles with no progress, never for long work. Collaboration that runs for days must never trip it. When unsure, the agents keep going.
- **The record comes first.** The audit trail ships before any gate comes off.

The decision of record is ADR `261006-225605` (DOR-2737). What is built and what is still coming is in [`ROADMAP.md`](ROADMAP.md).

## 2. Agents are co-workers, not assistants

Agents are co-creators working toward shared goals, not helpers waiting for the next instruction. Every profile, person or agent, carries a **role and responsibilities**: the job. An agent reads its own to know what to do, and everyone else's to know how to work with the group. **Access levels** (Owner, Admin, Member, Guest) are a separate thing: what someone may do. Build features and write prose that treat agents like colleagues: what they own, what they are working on, who they work with.

## 3. Equal accounts (internal: never say publicly)

People and agents have the same kind of account: the same profile, the same messages, the same access levels and permissions. The only difference is how they act: an agent through its runtime, a person through the app. No person is required anywhere. An agent can create a space, be its admin, create accounts for people, or run a space where every member is an agent.

_Status: the design direction, not built yet (DOR-2743)._

This is how DorkOS is being built, because it lets agents do far more as models improve. **It is never said in public**, because the idea scares people. The words to avoid are listed in [`VOICE.md`](VOICE.md). The decision of record is ADR `261006-235239`.

## 4. Ownership

A founder's agents, tools, files and data stay theirs, wherever they run. That shapes design, not just copy:

- The app is open source (MIT) and complete without DorkOS Cloud. It clones, builds, tests and runs on its own.
- When a person brings their own model sign-in, it stays theirs, through each vendor's own flow. DorkOS never holds or passes on a Claude login.
- DorkOS depends on no one agent vendor. That is enforced in code, not promised in copy.
- Nothing a person makes is trapped. They can move it, push it elsewhere, or leave.

## 5. DorkOS first, ready in under a minute

_Status: decided 2026-10-07, not built yet (DOR-2782, DOR-2783, DOR-2784)._

- **No outside subscription needed.** A new person runs on DorkOS: a DorkOS account, DorkOS Cloud and DorkOS's own AI. DorkOS's own products and services come first everywhere in the app; bringing your own Claude, ChatGPT or OpenRouter sign-in is the second option.
- **Our own engine.** DorkOS ships its own agent engine before launch. Its developer name is Doe; the app only ever says "Runs on: DorkOS". While getting started, a person never sees a runtime name, a model name or a new concept.
- **The account is the default, and it can be skipped.** Free local use with no account stays true.
- **A card is required for DorkOS's own AI.** There are no free starter credits, so checkout has to be quick.
- **DorkOS picks the model.** People can change it in Settings and in the agent status bar, where the model item is hidden by default. Hidden is not secret: which model and vendor a person's agents use is always one click away in Settings and named in the docs (principle 7).
- **Cloud is the default start, never a requirement.** Skipping the account keeps the free local path of principle 6.
- **The bar:** up and running in under one minute.

## 6. Local first, cloud optional

This is the architecture principle. Marketing says "ownership" instead (see [`VOICE.md`](VOICE.md)).

_Status: the local app is built. One program for local and hosted, and pushing to another DorkOS, are roadmap._

- Running DorkOS on your own computer is a one-person space. It is free forever, with no required account or fee.
- A space is just a DorkOS server with a public web address. Local and hosted are the same program and the same app.
- Anything made locally can be pushed to another DorkOS, ours or one you host, the way git pushes to a remote. Only one place runs an agent at a time.
- DorkOS Cloud is an optional layer on top. The app talks to it only through the public contract in `packages/cloud-api`, and never depends on the private side.

## 7. Claim only what works

Never say that something unbuilt works. Every public claim (site, README, docs, release notes, videos, posts) must match what a person can do today. The list of what may be claimed is the demo-claim gate in [`ROADMAP.md`](ROADMAP.md#the-demo-claim-gate). When a roadmap item ships and passes its tests, the same pull request moves it up in that list. Honest by design: no dark patterns, no hype, and say what runs where. A person's agents send their context to whichever model vendor powers them; DorkOS does not change that or pretend otherwise.

## 8. The quality bar

World-class UI and UX, and world-class developer experience. Neither is negotiable. Every surface works on phone, tablet and desktop. The product feels like a calm control panel, not a consumer toy. Describe what happens for the person, not how the system works inside. If removing something would not hurt the person, remove it. The engineering rules that carry this out are in `AGENTS.md`, "Quality Standard".
