# DorkOS Voice

> **Canon.** The single source for the words we use and the claims we make, in every place a person reads: the site, READMEs, npm and store copy, docs, release notes, blog posts, app copy, error messages, emails, and what our agents say about DorkOS. Part of the north-star set with [`VISION.md`](VISION.md), [`PRINCIPLES.md`](PRINCIPLES.md) and [`ROADMAP.md`](ROADMAP.md).
>
> **How to write** (reading level, sentence length, no em dashes) lives in the `writing-for-humans` skill, and app copy adds the `writing-app-copy` skill. This file is **what to say**. Skills, rules and guides point here rather than repeat these lists.

## The message stack, in use

The three lines are in [`VISION.md`](VISION.md#the-message-stack). When you use them:

- **Line 1, the tagline,** goes on hero surfaces only. Each surface keeps its established casing; the site's closing section says "You, multiplied."
- **Line 2, the headline,** is also the page title. The homepage title is exactly "DorkOS: Build and run your business with an agent team".
- **Line 3** is the supporting line under the headline.
- **Below the hero, the three differentiators are the structure**, in order: mini apps, built for founders, ownership. The chat workspace is still table stakes; the supporting line names it first, and that is fine.
- **What backs the supporting line.** "Build the custom tools your company runs on" is mini apps as they ship today. "Take on real work" is files, code, schedules and messages, plus Connections to outside apps, which are in beta. Lower copy never promises more, and Connections stay labelled beta.

## Headline rules

Headline copy means: the hero, page titles, meta descriptions, link previews (OG and Twitter cards), section headlines, the README opening, the npm description and the llms.txt summary line. In headline copy:

- Never say "on your computer", "on your own computer" or "runs on your computer". DorkOS Cloud runs on our servers too.
- Never say "open source" literally.
- Say ownership as "yours": "yours to keep", or "Your agents, tools, files and data stay yours, wherever they run."

Lower on the page (body text, FAQ, install steps, the license section), plain facts like "MIT license" or "runs on your computer or a server" are fine.

## Words we use

| Say                                             | Meaning and when                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a workspace for people and agents**           | The category. Long form: "the workspace where founders run their business with people and agents." Write it in full so it never reads as the app's Workspaces page. It says what DorkOS is; it never leads a pitch.             |
| **mini apps**                                   | Apps your agents build inside DorkOS. The app still calls them extensions, so docs say "mini apps (the app calls them extensions)". Safe verbs: "ask for", "builds", "you say yes", "opens inside DorkOS".                      |
| **co-workers**, **teammates**                   | What our agents are. Describe an agent by its job ("Scout reviews your pull requests"), never as "your AI assistant".                                                                                                           |
| **takes initiative**, **owns**, **reports to**, **checks in** | How we describe proactive agents: "Scout owns your pull request reviews and checks in each morning." Until heartbeats ship (DOR-2788), only schedules are built, so public copy says agents "run on a schedule" or "work on a timer", never that they check in on their own. "Heartbeat" is fine in docs and internal writing; public copy prefers "checks in". |
| **role and responsibilities**                   | The job written on a profile, for a person or an agent.                                                                                                                                                                         |
| **access levels**                               | Owner, Admin, Member, Guest: what someone may do. Never call these roles.                                                                                                                                                       |
| **Health check**                                | The linter for your organisation (roadmap).                                                                                                                                                                                     |
| **DorkOS Community Space**                      | The official space every new account joins. Not built yet: say it is coming, never that it works, never link to it.                                                                                                             |
| **space**                                       | What the code calls a community, as the person sees it.                                                                                                                                                                         |
| **Connections**                                 | The one page and the umbrella word for outside apps. A Telegram or Slack hookup is a **connection**; an app an agent acts on (Gmail, Linear) is a **service**.                                                                  |
| **Shape**                                       | A setup bundle (layout, mini apps, suggested agents, schedules). It can carry mini apps; it is not one.                                                                                                                         |
| **ownership**, **yours**                        | How marketing says local first. See below.                                                                                                                                                                                      |
| **DorkOS**, for the engine                      | The app says "Runs on: DorkOS". Doe is the engine's developer name, for developer guides and code only, never user docs. While a person is getting started, no runtime name, model name or new concept appears.                 |
| **Workspaces**                                  | A product noun already: the /workspaces page and project checkouts. When "workspace" is the category word, write "a workspace for people and agents" in full. Never rename or redefine the Workspaces page to fit the category. |
| **the DorkOS app**, **the app**, **one window** | What to call the product's interface.                                                                                                                                                                                           |

Lines with a fixed home: "Intelligence doesn't scale. Coordination does." is the manifesto line: for essays, the litepaper, comparison and anti-positioning surfaces and the Show HN thread, never a headline. "Teams needed Slack. AI agents need DorkOS." may explain the category to a first-time reader, only beside the differentiators and never as the lead.

## Words and claims we never use

| Never                                                                                                                                                                              | Why, and what to say instead                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "mission control", "cockpit"                                                                                                                                                       | Retired for good. Say "the DorkOS app", "the app" or "one window". Two carve-outs: GitHub's product named Mission Control, and the compiled changelog's historical wording.                        |
| "operating system for AI agents", in any form                                                                                                                                      | The retired category. The product name DorkOS stays. Say "a workspace for people and agents".                                                                                                      |
| "one place for every AI agent you run", "All your agents. One place."                                                                                                              | The retired 2026-08 category line. Plain uses of "one place" are fine.                                                                                                                             |
| "agents equal to humans", "equal accounts", "peers", "same account as you", "agents can run the place" (or the company, or the space), "no human required", "agents can be admins" | Equal accounts are an internal principle ([`PRINCIPLES.md`](PRINCIPLES.md) §3), never said in public, not even as "coming". Say co-workers or teammates. Access levels may be described as coming. |
| Discord, as our community                                                                                                                                                          | There is no DorkOS Discord. Never link one. The word is fine for the real third-party app.                                                                                                         |
| "on your computer", "open source" in headline copy                                                                                                                                 | See the headline rules above.                                                                                                                                                                      |
| "local first", "local-first" in marketing                                                                                                                                          | It is the internal name of an architecture principle. Say "ownership" or "yours".                                                                                                                  |
| "integration", "connector", "adapter", "provider" as nouns a person reads                                                                                                          | Retired by ADR `260804-021140`. Say connection, service or Connections. Code keeps its own names (`RelayAdapter`, `ConnectorProvider`).                                                            |
| "community" as a noun a person reads                                                                                                                                               | Say "space". Code, routes and CLI verbs keep the word until they are renamed.                                                                                                                      |
| "AI assistant" for our agents                                                                                                                                                      | They are co-workers.                                                                                                                                                                               |
| "generative UI" as a value word                                                                                                                                                    | The chat widgets are supporting proof of mini apps, not the pitch.                                                                                                                                 |
| "Claude Code, Codex and OpenCode side by side" as a headline                                                                                                                       | Which runtimes DorkOS supports is a docs fact. One plain mention lower down is fine.                                                                                                               |
| "any tool", "no code ever", "instantly", "builds anything" about mini apps                                                                                                         | Overclaims. Claim mini apps exactly as built (see [`ROADMAP.md`](ROADMAP.md#the-demo-claim-gate)).                                                                                                 |
| Developer-first framing of who DorkOS is for                                                                                                                                       | The founder is the first reader; Kai, the developer, comes second.                                                                                                                                 |
| "Ask for a tool. Your agents build it." as the homepage hero                                                                                                                       | Replaced by the message stack on 2026-10-07. It may still head a mini apps section.                                                                                                                |
| "always watching", "never sleeps", "works while you sleep", "autopilot", "on its own 24/7" | Creepy or an overclaim. Proactive agents work toward goals and report up; they do not watch people. Until heartbeats ship, describe schedules exactly as built. |
| "secure by default", in any spelling                                                                                                                                               | Not true of everything we ship. See safety claims below.                                                                                                                                           |

## Plain-word swaps

Story copy describes outcomes, not mechanisms. Technical docs may use the exact terms.

| Instead of                                                                     | Say                                                     | Why                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| "server-side"                                                                  | "keeps running when you close the terminal"             | It sounds enterprise; the point is independence from the IDE. |
| "infrastructure"                                                               | "system", or cut it                                     | Too cold. DorkOS is for builders running a business.          |
| "audit trail" in story copy                                                    | "a record of what every agent did"                      | Plain words win in story copy; "audit trail" is fine in docs. |
| "session locking", "durable delivery", "dead-letter queue", "budget envelopes" | cut it, or keep it for docs                             | Mechanism, not benefit.                                       |
| "message bus"                                                                  | "your agents can message you and each other"            | Describe the outcome.                                         |
| "agents that talk to each other"                                               | "message each other"                                    | "Talk" reads as voice agents.                                 |
| "renting" (for SaaS)                                                           | "it runs where you choose, and you can read every line" | Be concrete about ownership.                                  |
| "isolated processes"                                                           | "solo agents"                                           | Human-scale words.                                            |

Retired taglines nobody should re-propose: "All Your Agents. One Place.", "Every Agent You Run. One Window.", "Your Agents, Any Vendor.", "Your Plugins Already Work Here." and "Some Code Never Leaves. Now the Agent Doesn't Either."

## How to say ownership

- Lead with: "Your agents, tools, files and data stay yours, wherever they run."
- Short form: "yours", "yours to keep".
- In body copy you may add the plain facts underneath: your real files, your own Claude or ChatGPT sign-in, MIT license, free forever on your own computer, no DorkOS account needed.

## Safety claims

- Pair running it yourself with the claim that is true: "it listens only on your own machine by default." Never "sign-in required the moment you expose it".
- State every protection together with the login setting it depends on. A protection that holds only when login is on, or only on your own machine, says so in the same sentence. The full rule and its reasoning (DOR-509) are under Pillar 3 of [`archive/positioning-202607/02-positioning.md`](archive/positioning-202607/02-positioning.md).
- Trust by default is a principle until it ships. Public copy may say "agents are trusted colleagues; you can see what each one did on the Activity page". It must not claim that every action is recorded, that there is an audit trail anyone can read, that there are no permission prompts, or that agents have full power by default, until [`ROADMAP.md`](ROADMAP.md#the-demo-claim-gate) lists them as built.

## How this is enforced

- `scripts/check-banned-words.sh` scans READMEs, `AGENTS.md`, docs, blog posts and the operating skills for retired words and phrases.
- `scripts/check-vocab-gate.ts` scans the strings the app and site actually render, plus docs prose, with a reasoned allowlist in `scripts/vocab-gate/allowlist.json`.
- `pnpm check:copy-length` caps app copy at 15 words per block.
- A weekly drift check (coming) will report retired phrasing and stale positioning that no machine rule can catch.

A legitimate use of a retired word (a quote, GitHub's Mission Control) gets a `vocab-allow` marker on the same line, with a reason.
