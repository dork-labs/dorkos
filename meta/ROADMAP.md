# DorkOS Roadmap

> **Canon.** What is built, what ships before launch, what comes after, and what any public surface may claim. Part of the north-star set with [`VISION.md`](VISION.md), [`PRINCIPLES.md`](PRINCIPLES.md) and [`VOICE.md`](VOICE.md). Tickets are in Linear (team DOR), most of them under the parent DOR-2735. Each idea is told in full in [`dorkos-litepaper.md`](dorkos-litepaper.md).
>
> **Keep it true.** When something ships and passes its tests, the pull request that ships it moves it up here, in the order list and in the demo-claim gate.

## The launch

Launch is late November 2026, holding the cut line: our own engine lands around November 23 to 30, and the community space must be solid. The launch is the new story, on today's product, plus DorkOS Cloud, DorkOS's own AI and proactive agents with heartbeats.

| Before launch                                                                                                                                                                                                                                                                                                                                                                                            | Ticket                                     | State    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- |
| The DorkOS Community Space, the centerpiece. Every new account (people only) joins it; agents join when their owner adds them. It soft-launches with current users for about two weeks. There is no Discord. Existing how-to docs for today's early spaces may stay.                                                                                                                                     | DOR-2764 (work in DOR-2765 to DOR-2774)    | Building |
| One space at launch: every other space feature, including creating your own, stays behind an experimental switch                                                                                                                                                                                                                                                                                         | DOR-2740                                   | Done     |
| The last places that still show spaces with the switch off                                                                                                                                                                                                                                                                                                                                               | DOR-2760                                   | To do    |
| Trust step 1: "trusted by default" written as an ADR                                                                                                                                                                                                                                                                                                                                                     | DOR-2737                                   | Done     |
| Trust step 2: the audit trail, every action recorded and readable by space members and agents                                                                                                                                                                                                                                                                                                            | DOR-2738                                   | Building |
| Trust step 3: full power by default, with tests that pin the protections against strangers, and the posting, notification and reaction caps removed                                                                                                                                                                                                                                                      | DOR-2739                                   | Building |
| Managed remote access through DorkOS Cloud                                                                                                                                                                                                                                                                                                                                                               | DOR-2086, DOR-2763                         | Building |
| The docs, site and README rewrite to this story, including marking the hosted space and cloud agents with email as "coming soon" on the pricing page                                                                                                                                                                                                                                                     | DOR-2736                                   | Done     |
| Doe, our own agent engine. Built in order: the engine package (DOR-2786), then plugging it into DorkOS as a runtime (DOR-2787); together they unblock onboarding and model choice below. A Codex agent builds it. Reuse first from the Pi ecosystem before writing our own; tools load lazily; every DorkOS capability becomes a Doe tool. The app only ever says "Runs on: DorkOS".                     | DOR-2782 (work in DOR-2786, then DOR-2787) | To do    |
| DorkOS-first onboarding: a DorkOS account (skippable), DorkOS Cloud and DorkOS's own AI, up and running in under one minute, with no runtime or model names on the way                                                                                                                                                                                                                                   | DOR-2783 (after DOR-2787)                  | To do    |
| DorkOS picks the model; it can be changed in Settings and in the status bar, where the model item is hidden by default                                                                                                                                                                                                                                                                                   | DOR-2784 (after DOR-2787)                  | To do    |
| Using your own AI key or sign-in as a working first run. The card path is US-only at launch, so this is the way in for everyone else                                                                                                                                                                                                                                                                     | DOR-2783                                   | To do    |
| Heartbeats: every agent is proactive. A heartbeat skill plus a small beat runner: a free change-check, cheap decision-model triage, smart timing and event wakes, one-line records, batching per person and quiet hours. Triage runs on DorkOS credits for every agent, Claude Code and Codex included, and its cost shows in the agent's settings. Design: [`PROACTIVE-AGENTS.md`](PROACTIVE-AGENTS.md) | DOR-2788 (urgent)                          | To do    |
| Decision models as first-line support: the cheap triage tier heartbeats run on, then community moderation in watch-only mode. The port and its bridges are in `packages/decisions`                                                                                                                                                                                                                       | DOR-2778                                   | Building |

A card is required for DorkOS's own AI; there are no free starter credits. There are no built-in money caps: an agent's spending limit lives on the card it is given, plus its instructions. Prices do not change, and no file in this repo names them. Cloud computers are not built and are not needed for launch.

## After launch, in order

1. Move the server from Express to Hono, then merge it with the space server: one program, one app. (DOR-2742)
2. Equal accounts: access levels, role and responsibilities on profiles, per-account API keys, agents creating agents. (DOR-2743)
3. Everything programmable: a CLI, an SDK and API, GraphQL queries and live event subscriptions. (DOR-2754)
4. One message system: Relay folds into conversations, and anyone can message anyone in a space. (DOR-2744)
5. Groups, projects, tasks and tiered goals (DOR-2755), plus the health check (DOR-2756).
6. The built-in vault (DOR-2746), email and phone as account features (DOR-2747), and agents owning their own outside accounts (DOR-2757).
7. One package type, the plugin (DOR-2758), and mini apps as a core skill every agent knows (DOR-2759).
8. Agents with their own computer, behind a flag, and moving them to another DorkOS (DOR-2748); publishing pages (DOR-2749).
9. Live shared docs for people and agents. (DOR-2750)

**Alongside, not in the order:** the rest of proactive agents after heartbeats (DOR-2788): optional reports-to on every profile (when blank it is the agent's creator, and every chain ends at a person), agent templates by type (lead, business doer, coder, taste, starter; coders wake on events only), a commitments list and the measures in [`PROACTIVE-AGENTS.md`](PROACTIVE-AGENTS.md); agents creating agents that report to them, asking first only when the new agent would get spending power (with DOR-2743); the loop watcher that replaces turn counting (DOR-2745; today's loop guards stay until it is ready); and removing the remaining agent friction and old permission machinery (DOR-2751).

## The demo-claim gate

**Never state that something unbuilt works.** Every claim on a public surface falls into one of these classes. Internal documents (`meta/`, `plans/`, `AGENTS.md`, ADRs) may describe later items as decided direction, clearly labelled.

### Built today: may be claimed, in plain words

- **Mini apps, as far as they go today.** Ask an agent for a tool, and it builds a mini app (an extension, in the app's words). A person says yes on the Activity page or in Settings, and it opens inside DorkOS in fixed places: its own page, the side panel, the Activity page, the status bar, settings tabs, or a sidebar menu item. Live widgets in chat and MCP Apps are supporting proof. The LifeOS and Tangerines dashboards and the flow plugin are internal proof only; never cite them as something a reader can see.
- The app on your own computer: the CLI install, the macOS desktop app, and the phone as an installable web app over the built-in remote access.
- The Windows desktop app, **as an early alpha only**. Always say "alpha".
- Rooms: the #team home, channels, DMs and threads with you and your agents, with a shared canvas.
- Direct chat with an agent: the full coding view, with thinking, tool calls and the status bar.
- Tasks (schedules), Telegram and Slack connections, and services through Composio and Nango (Gmail and others). Connections to outside apps are labelled beta.
- The marketplace install path.
- Agents running on Claude Code, Codex or OpenCode. A docs fact, not a headline.
- The Activity page, a record of what agents did. Never call it a complete audit trail.
- DorkOS Cloud today: accounts, remote access and credits. Never name prices or plans.

### Still unverified: never claim it works

- The Windows desktop alpha working for real users. It is built and code-reviewed, but no real end-user install has confirmed it.
- The marketplace's Claude Code superset compatibility. "Any Claude Code plugin works here" is not verified.

### Before launch, not built yet

- **Trust by default** (DOR-2738, DOR-2739): full power by default, the readable audit trail, and the caps coming off. Until they ship, the caps are current behavior. Public copy may state the principle only (see [`VOICE.md`](VOICE.md#safety-claims)). Docs about permissions and approvals change with these tickets, not before.
- **The DorkOS Community Space** (DOR-2764). Say it is coming (see [`VOICE.md`](VOICE.md)).
- **Managed remote access** (DOR-2086). Describe remote access as it works today.
- **DorkOS first, in under a minute** (DOR-2782, DOR-2783, DOR-2784): our own engine, the one-minute start and automatic model choice. Until they ship, getting started still means signing in to Claude Code, Codex or OpenCode, or using DorkOS credits.
- **Heartbeats** (DOR-2788). Never say an agent checks in, wakes up or takes initiative on its own until they ship. Scheduled tasks are built and may be described as schedules.

### Roadmap: never claimed as working

Say "coming" or "planned", or leave it out:

- Equal accounts and access levels (how to talk about them is in [`VOICE.md`](VOICE.md)).
- Role and responsibilities on profiles; agents owning their outside accounts; agents creating agents.
- Agents that report to someone and keep a commitments list; agent templates by type. (Heartbeats are before launch, above.)
- More than one person on a server; spaces as the story describes them, and creating your own space. An early form ships today (the code calls them communities, the app says spaces); never feature it on story surfaces.
- Groups, projects, tasks in projects, and tiered goals. Today's Tasks page is schedules; never present it as this.
- The health check.
- Mini apps beyond today: every agent knowing how, the "inside DorkOS or its own website" choice, ready-made founder mini apps, and goals that guide them.
- One package type with filtering by contents.
- Everything programmable, and per-account API keys.
- The vault, email, phone and payments as account features.
- Agents with their own computer, and shared drives.
- Pushing to another DorkOS, and publishing pages.
- Live shared docs.
- One message system.
- The loop watcher that replaces turn counting.

## Open risks

Each of these shapes what the docs may promise.

- **Model vendors' terms** decide how a person's own subscription sign-in may be used through DorkOS, and whether DorkOS may pay for model use inside hosted computers. The design keeps sign-in the person's own, through each vendor's own flow, and DorkOS never carries a Claude login. Docs promise nothing beyond today's behavior.
- **Laptop memory.** Each running agent desktop takes about 1.5 GB, so a 16 GB Mac runs about two or three at once.
- **US texting** needs carrier registration, and banks often reject internet phone numbers for login codes. Calls come first.
- **Lost laptop, lost identity**, unless the person keeps a recovery file or an optional backup.
- **Free public publishing** draws spam and phishing. It needs its own web address and abuse controls before it ships.
- **Agents can still read filled-in passwords.** An agent that controls its own computer can read a password field after it is filled in. "Agents use secrets without seeing them" holds for the vault's own path only.
