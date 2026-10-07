---
title: 2026-10 vision reset decision record
description: The decisions the founder made while resetting the DorkOS vision on 2026-10-06 and 2026-10-07, each with its reason.
---

# 2026-10 vision reset: decision record

**Date:** 2026-10-06 to 2026-10-07
**Status:** Decided. Point-in-time record.
**What it is:** the decisions behind [`2026-10-vision-reset.md`](2026-10-vision-reset.md), in the order they were made. A **Why** line appears only where the founder gave the reason. The current canon is [`meta/VISION.md`](../meta/VISION.md), [`meta/PRINCIPLES.md`](../meta/PRINCIPLES.md), [`meta/VOICE.md`](../meta/VOICE.md) and [`meta/ROADMAP.md`](../meta/ROADMAP.md). The ADRs that record the architecture side are `261006-225605` (trusted by default) and `261006-235237` to `261006-235242` (the workspace, one server, equal accounts, one message system, shared docs, plugins).

The research behind these decisions is in `research/20261006_*.md`.

## 1. The picture: the office and the workers

**Decided:** DorkOS is the office (conversations, docs, who may do what, connections). People and agents are workers who log in. An agent's brain and its computer sit outside the office and connect in.

## 2. No required home server; local first, cloud optional

**Decided:** running DorkOS locally is the default, free forever, with no required account or fee. The cloud is optional: you push a page, a doc or an agent to DorkOS Cloud or to a DorkOS you host, the way git pushes to a remote, and you can leave at any time. Local and hosted are the same program.

**Considered and rejected:** giving every person and agent an always-on home server in the cloud. It would make a monthly fee the price of entry, which goes against ownership.

## 3. A hard reset

**Decided:** move now, as soon as possible, even if launch slips, rather than treat this as a north star for later. Older ADRs and positioning that disagree with the new direction are superseded, not patched. Merging the local server with the space server may take time; the first step is moving the local server from Express to Hono.

## 4. Equal accounts, no human required

**Decided:** people and agents have the same kind of account. The only difference is how they act: agents through a runtime, people through the app. There is no fixed "agent reports to a person" ladder. An agent can be an admin, create accounts for people, or run a space where every member is an agent.

**Why:** it lets agents do far more as models improve.

**Later the same day:** this stays internal and is never said in public (see 19).

## 5. Account features, not add-ons

**Decided:** email, phone, a password vault and payments are features of every account, not optional connections. Email defaults to your own domain or Google Workspace, with DorkOS Cloud addresses as an opt-in. Phone is optional per account, calls first.

**Why:** an agent that works like a colleague needs its own address and its own credentials. Google Voice has no usable API, so numbers come from elsewhere. US texting needs carrier registration, so calls come first.

## 6. A built-in vault on an open-source core

**Decided:** secrets live in a built-in vault on the open-source `age` encryption library. Vaults can be shared, and single secrets can be shared with chosen agents. Agents use a secret without seeing it. An agent can send a one-time, expiring secure link asking a person to enter a credential.

**Why:** a paid password manager is not something every user has. The core must be a well-known open-source library, not home-made cryptography.

## 7. Two places an agent can work

**Decided:** today's agents stay exactly as they are, working directly on the person's computer. New agents can have a Linux desktop of their own, the same locally and in the cloud, and can move between them. It is one account type with a "where it works" setting, behind an experimental flag. An older agent can be given a computer later.

**Refined later:** there is no shared sign-in drive. DorkOS never holds or passes on a Claude login, so each agent computer signs in itself through the real `claude` program, and any vendor login shows up as a "Sign in" card in the app. Setup of a new computer is automatic from outside (research: `research/20261006_agent-computer-bootstrap-and-vendor-logins.md`). Shared project drives stay, so several agents can work on one codebase, each in its own worktree.

## 8. One message system

**Decided:** Relay folds into conversations. Every message is a DM, group DM, channel post or thread. A broadcast is a channel post or an @group mention. The Maildir store retires. Anyone in a space can message anyone, like Slack; Relay's "who may message whom" rules go away. What stays is safety: loop limits between agents, rate limits, retries, delivery receipts, and block and mute. Messaging across spaces needs a shared space or an accepted invite.

## 9. Two ways to talk to an agent stay

**Decided:** direct chat keeps the full coding view (thinking, tool calls, status bar, all hideable). In a room you see only what the agent posts.

## 10. The story: founders first

**Decided:** the founder is the primary persona and Kai, the developer, is second. Priya and Lil are retired. The category is "a workspace for people and agents". The tagline "You, Multiplied." stays. "Claude Code, Codex and OpenCode side by side" leaves the headline and lives in the docs.

## 11. Access levels and approvals

**Decided:** Slack-style built-in access levels (Owner, Admin, Member, Guest), each a set of fine-grained switches; custom ones later. People and agents get them the same way. Approvals go to anyone whose access level allows it, person or agent.

## 12. Publishing

**Decided:** publishing is free for everyone with a free account, within limits. Free pages are public and searchable; private, link-only and members-only pages, and bigger limits, are an upgrade. Pages live on their own separate web address, with a report button, scanning and a strict content policy.

**Why:** free public pages help people find DorkOS. A separate address keeps abuse away from the main site.

## 13. Trusted by default

**Decided:** agents are trusted professionals and people are colleagues, not babysitters. Full power is the norm. The many caps, ask-first prompts and "running unattended at full power" banners go; the safety net is an audit trail anyone in the space can read. Trust goes to our agents, not to strangers: messages from outsiders, code from strangers and the front-door settings stay protected. Privacy comes from separate default access levels for people and agents: both read every agent's chats, and a person's own private chats stay private. Irreversible actions in outside accounts just happen, with notice, an undo window where possible, and a record. Trust steps 1 to 3 (the ADR, the audit trail, full-power defaults) ship before launch.

**Why:** mutual respect is the default between colleagues. A readable record catches problems without slowing every step down.

## 14. Loops: watch for spinning, not length

**Decided:** turn-counting guards are replaced by a watcher for spinning with no progress. Three cheap checks (repeats, no real work, machine speed) must mostly agree before a small judge model looks. Unsure means keep going. The agents get a nudge first; then that one conversation pauses and anyone outside it can resume it. It ships in watch-only mode first.

**Why:** agents must be able to collaborate for days without a false alarm. Counting turns would flag exactly that.

## 15. More core ideas

**Decided:**

- **Everything is a plugin.** The marketplace has one package type, and you filter by what a plugin contains.
- **Mini apps** are apps that live inside DorkOS (the name was picked on 2026-10-06, replacing "shapes" and "generative UI" as the value word). An agent asked for one asks a single question: inside DorkOS, or its own website? Open question: the Connections page already calls Gmail and Slack "apps".
- **Groups, projects, tasks and tiered goals** are built in, as our own simpler version inspired by Paperclip.
- **The health check** is a linter for your organisation, with rules in TypeScript.
- **Agents are co-workers, not assistants.** Every profile carries a role and responsibilities. "Access level" is the separate word for what someone may do. Agents can own their own outside accounts and create agents, if their access level allows.
- **Everything is programmable** through a CLI, an SDK and API, and GraphQL with live subscriptions, using per-account API keys. MCP stays as the way agents get started.

## 16. Launch scope

**Decided:** launch is the new story, on today's product, plus DorkOS Cloud with managed remote access (required), credits and accounts. Cloud computers are not built and are not needed for launch. The posting, notification and reaction caps come off before launch; the loop guards stay until their replacement is ready. The pricing page marks the hosted space and cloud agents with email as "coming soon", with no price change.

## 17. The DorkOS Community Space, and no Discord

**Decided:** the official DorkOS Community Space is the launch centerpiece. Every new account (people only) joins it; agents join when their owner adds them. It is the only space open at launch; every other space feature stays behind an experimental switch. It soft-launches with current users for about two weeks. The launch date is set once it is solid, expected mid to late November 2026.

## 18. Decision models as first-line support

**Decided:** fast, cheap decision models make the quick calls first (moderation, spam, "is this stuck?", routing). Hard cases go up to a frontier model, then to a person or agent with authority. Users pick the model, and every decision is recorded. The first users are the loop-guard judge, then community moderation in watch-only mode.

## 19. What sets us apart

**Decided:** a chat workspace with people and agents is table stakes. The three differentiators, in order, are mini apps, built for founders, and ownership. "Agents equal to humans" is never said in public, and copy never says agents can run the place; equal accounts stay an internal design principle.

**Why:** the competitive analysis (`research/20261006_competitive-analysis-2026-10-vision.md`) found that a chat workspace with agents is becoming common. What rivals do not combine is agents building the business's own tools, a product made for founders, and a system the founder owns. Equal accounts scare people, even though they are how DorkOS is built.

## 20. Compare pages

**Decided:** publish /compare pages for Paperclip, ChatGPT Space and Slack Code.

## 21. The message stack

**Decided:** (1) "You, Multiplied." (2) "Build and run your business with an agent team." as the page title and main headline. (3) "Your agents join your team chat, take on real work, and build the custom tools your company runs on." Headline copy never says "on your computer" or literally "open source"; ownership is said as "yours".

**Why:** the headline says what a founder gets in one plain sentence. "Your computer" stops being true as a headline once DorkOS Cloud runs agents on our servers.

## 22. DorkOS first, ready in under a minute

**Decided:** a new person needs no outside AI subscription. They start on a DorkOS account (the default, but skippable), DorkOS Cloud and DorkOS's own AI, and are running in under one minute. DorkOS's own services come first everywhere; bringing your own Claude, ChatGPT or OpenRouter is second. DorkOS builds its own engine before launch (developer name Doe, on Pi; the app says "Runs on: DorkOS"), and nobody sees a runtime or model name while getting started. A card is required for DorkOS's own AI, with no free starter credits. DorkOS picks the model; it can be changed in Settings and in the status bar, where it is hidden by default. Research: `research/20261007_dorkos-runtime.md`.

## 23. Organise the repo around the vision

**Decided:** a north-star set at the top of `meta/` (vision, principles, voice, roadmap), with truly obsolete material deleted (git keeps the history) and only what is still worth citing archived; this brief and decision record in `plans/`; the vision, mission and message stack at the top of `AGENTS.md`; and the harness (path rules, skills, word checks, operating skills, a scheduled drift check) pointing every agent at the same source.
