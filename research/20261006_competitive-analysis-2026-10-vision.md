---
title: 'Competitive analysis: the 2026-10 vision (a workspace for people and agents)'
date: 2026-10-06
type: competitive
status: active
tags:
  [competitive, positioning, vision-202610, slack, openai, anthropic, buzz, paperclip, ando, launch]
---

# Competitive analysis: the 2026-10 vision

Asked for by Dorian on 2026-10-06: an honest look at the new direction, not cheerleading.

**The direction being tested** (from the agreed vision brief): DorkOS becomes a Slack-like workspace where a founder runs a whole business with people and agents. People and agents get equal accounts. Agents are trusted by default, and the safety net is an audit trail anyone in the space can read. Agents get email, phone, a password vault and, optionally, their own computer. Groups, projects, tasks and tiered goals are built in. Mini apps live inside the workspace. Everything is a plugin and everything is programmable. It runs locally first, with an optional paid cloud. The code stays open source (MIT). The launch centerpiece is the DorkOS Community Space: every new account joins it, it replaces a Discord, and it is the only space open at launch. The launch date is set once that space is solid, expected mid to late November 2026 (the brief moved it off Nov 4 and 5 on 2026-10-06).

**How this was made.** Five research passes on the live web on 2026-10-06, one per competitor group, about 130 searches in total. They built on our own earlier work: `meta/archive/positioning-202607/01-market-landscape.md`, `research/20260823_comparison-pages-competitor-verification.md`, `research/20260809_workspaces-purpose-competitors-and-10x.md`, the Buzz source dives from 2026-09-18, and `research/anthropic-tos-compliance.md`. The biggest claims (Slack Code, Ando, ChatGPT Space, Sign in with ChatGPT, Paperclip) were checked a second time by hand. GitHub star counts were pulled from the GitHub API on 2026-10-06. Funding and revenue numbers mostly come from press reports. Treat them as rough.

## The verdict in one paragraph

The idea is right, and that is the problem: everyone else had it too, and most of them shipped in the last ten weeks. Slack put coding agents into shared channels on every Slack plan (Aug 20). Block shipped Buzz, an open-source workspace where people and agents each hold their own identity (late July, now 35,620 stars). Ando raised $20M to build "Slack for humans and agents" (Sep 24). OpenAI launched ChatGPT Space with always-on agent co-workers called Dots, each with its own cloud computer (Sep 29). Paperclip, an MIT-licensed "org chart for AI agents" with tiered goals, budgets and an audit log, has 98,058 stars. DorkOS has 10. Almost every single claim in the new story is already made by someone with more money or more users. What nobody has yet is the specific mix: agents that work in your real folders on your own computer, in group chat with you and your people, across Claude Code, Codex and OpenCode, open source, with a record of everything they did. That mix is real but narrow. The vision as written is far too wide for a launch about six weeks out, and parts of it carry real risk (Anthropic's terms, and "trusted by default" in a year full of agent security disasters). Launch the narrow, true thing, and say clearly what comes later.

---

## 1. Who we compete with

Six groups. For each, the products that matter, then what they mean for us.

### (a) Work hubs adding agents

These already own where people work. They are adding agents to it.

**Slack (Salesforce).** Slack now calls itself the "agentic OS". Three moves matter:

- **Slack Code** (launched Aug 20, 2026, included in every Slack plan; you still need access to, and pay for, the coding agent itself). You @mention a coding agent in a channel. It opens a code channel where the whole team sees its plan, the code changes and a live preview, and anyone can pause or redirect it. Launch partners: Claude Code, Devin, GitHub Copilot, ChatGPT and Vercel's agent; Factory joined later. This is the "people and agents in one channel, many agent brands" story, with Slack's install base behind it. ([SiliconANGLE](https://siliconangle.com/2026/08/20/salesforce-introduces-slack-code-to-bring-agentic-team-coding-into-the-open/), [Salesforce](https://www.salesforce.com/ap/news/press-releases/2026/08/25/salesforce-launches-slack-code-to-make-ai-software-development-multiplayer-2/), [VentureBeat](https://venturebeat.com/orchestration/slack-wants-to-drag-ai-coding-out-of-the-terminal-and-into-the-group-chat))
- **The Slack MCP server and search API** (GA Feb 17, 2026), so outside agents can read and act in Slack. 50+ partners, including Anthropic, Google and OpenAI. ([Slack changelog](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/))
- **Agentforce in Slack**, priced at about $2 per conversation, or $0.10 per action, or $125 per user per month. ([getmacha](https://www.getmacha.com/blog/agentforce-pricing-explained), secondary)

How Slack treats agents: as bot or app accounts, separate from people, with access set by OAuth scopes. Not equal accounts. Cloud only, closed.

**Microsoft (Teams, Copilot, Agent 365, Entra Agent ID).** Microsoft talks about the "Frontier Firm", where people lead teams of agents. **Agent 365** went GA on May 1, 2026 as a control center for every agent in a company, including agents built on AWS, Google and OpenAI. **Entra Agent ID** gives each agent its own identity, with the same sign-in rules, access reviews and sign-in logs as a person. ([Microsoft Entra Agent ID](https://www.microsoft.com/en-us/security/business/identity-access/microsoft-entra-agent-id), [sign-in logs for agents](https://learn.microsoft.com/en-us/entra/agent-id/sign-in-audit-logs-agents), [Agent 365](https://techcommunity.microsoft.com/blog/partnernews/microsoft-agent-365-governing-the-enterprise-ai-workforce/4541391)). Agent 365 is reported at $15 per user per month; Copilot itself is $30 per user per month for enterprises. This is the most serious "agents get real identity and an audit trail" product anywhere. It is built for IT departments, not founders.

**Google Workspace and Gemini Enterprise.** Agentspace was folded into Gemini Enterprise. Workspace Studio lets people describe automations in plain English across Gmail, Docs and Chat. Seats run $21 to $50 per user per month. Agents are automations you @mention, not members. No agent identity story found. ([TechCrunch](https://techcrunch.com/2025/10/09/google-ramps-up-its-ai-in-the-workplace-ambitions-with-gemini-enterprise/), [Workspace blog](https://workspace.google.com/blog/product-announcements/less-switching-more-flow-5-new-agentic-capabilities-across-google-workspace-apps))

**Notion.** Custom Agents (Feb 24, 2026) run on schedules and triggers, each with "its own permissions, just like a teammate". Since Jul 1, 2026 every agent run shows in Notion's audit log (Enterprise plans). Billed in credits ($10 per 1,000) on top of the $20 Business seat. ([Notion help](https://www.notion.com/help/custom-agents), [release notes](https://www.notion.com/releases/2026-07-01))

**Linear.** The closest in spirit. Linear calls outside agents (Claude Code, Devin, Cursor, Copilot) "full members of your workspace" with their own profiles. You can assign them issues and @mention them. A person stays the main owner of delegated work. ([Linear for Agents](https://linear.app/agents))

**Asana.** Its AI Teammates page says: "Every AI Teammate has an identity, scoped permissions, spend controls, and an audit trail, with every action being checkpointable and reversible." That is almost our trust pitch, word for word. ([Asana](https://asana.com/product/ai/ai-teammates))

**ClickUp, monday.com, Discord.** ClickUp's Super Agents "appear as users" (thinly documented). monday.com sells agent bundles by count: 10 agents for $49 a month, 75 for $299. Discord has made no agent moves of its own. Low threat.

**What this group means for us.** "Agents as teammates with identity and an audit trail" is now normal language for big work software. None of them are local or open source. None give an agent its own email address as part of its identity. But they do not need to win on those points. They win because people are already logged in.

### (b) The AI labs

**OpenAI** is now the biggest single threat to the new story.

- **ChatGPT Space and Dots** (announced at DevDay, Sep 29, 2026; rolling out to Pro, Business and Enterprise from Oct 1). Space is a shared workspace where "employees, ChatGPT, Codex and Dots" work in the same pages, files and team chats. Dots are always-on agent co-workers, each with "its own cloud computer and browser", memory, and their own credentials to company systems. Admins get custom rules and an activity view. The first Dot is included in Pro and Business Premium. Dots also reach Slack and Teams. OpenAI-only, cloud only, closed. ([VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams), [Forkast](https://forkast.news/openais-chatgpt-space-is-now-a-workplace-for-autonomous-agents/))
- **Sign in with ChatGPT for other apps** (DevDay, Sep 29). Plus and Pro users can let approved apps spend their plan's Codex and ChatGPT Work allowance, with a weekly cap per app, and no API key. It is a limited preview with 16 partners. Officially named: Devin, Notion, Vercel, T3, OpenClaw and Dactyl. Press also reports OpenCode, Hermes Agent, Conductor, Amp, Warp and Kilo Code. ([The Star](https://www.thestar.com.my/tech/tech-news/2026/10/04/openai-expands-chatgpt-with-apps-and-third-party-sign-in), [explainx](https://www.explainx.ai/blog/openai-sign-in-with-chatgpt-devday-2026), [daily.dev](https://daily.dev/posts/openai-makes-sign-in-with-chatgpt-a-way-to-use-your-subscription-in-third-party-developer-tools-7ewaoo6ze))
- Also: Codex (CLI, cloud and app), shared Business projects, Workspace Agents in ChatGPT (no-code agents for a team), AgentKit (its no-code Agent Builder retires Nov 30, 2026). The merged ChatGPT, Codex and browser desktop "superapp" announced in March had not shipped as of this writing.

**Anthropic** has the pieces but not the shared workspace.

- **Claude Projects** (Sep 17, 2026, beta): one person, one coordinator, many parallel cloud threads. Explicitly single-user.
- **Claude Tag in Slack** (beta since Jun 23, 2026): one shared @Claude in a channel that many people can steer. A bot, not an account.
- **Cowork** (GA Apr 9, 2026): runs scheduled work in the cloud with your device off. Memory now spans chat and Cowork (Aug 25).
- **Managed Agents** (public beta since Apr 9, 2026): Anthropic hosts the agent, its sandbox and a **credential vault**, at API rates plus $0.08 per active hour. ([Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents))
- **Claude in Chrome** (GA Aug 26, 2026 on every paid plan).

**The subscription question.** DorkOS's default brain is Claude Code, usually signed in with the person's own Claude plan. Anthropic's written terms say it does not permit third-party developers "to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." The same page says this does not stop a person from signing in to the unmodified Claude Code program with their own plan, even where a platform hosts Claude Code. What it forbids is an app paying for, reselling or acting as the middleman for that usage. ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). The Agent SDK docs add that apps may not offer claude.ai login or plan rate limits "unless previously approved". In 2026 Anthropic blocked third-party tools in January and cut off about 135,000 OpenClaw setups in April, saying "Using Claude subscriptions with third-party tools isn't permitted under our Terms of Service." In May it announced a metered model to start Jun 15, then paused it on that day. As of September it had set no new date. ([The New Stack](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/)). Our own compliance research (`research/anthropic-tos-compliance.md`) says the safest path is to let the person's own `claude` program sign itself in, and never to pull out the token and pass it around. The vision brief itself says DorkOS's current use of the Agent SDK on a person's plan sits in this gray area, and accepts the risk.

**Google.** Antigravity 2.0 (I/O, May 2026) replaced Gemini CLI. Its "Manager view" lets one person run several agent teams at once. Gemini only. Jules is a cloud coding agent bundled into Google AI plans.

**What this group means for us.** OpenAI shipped the closest thing to our vision from any big company, a week ago, with agents that have their own computers. Anthropic has not built a shared workspace, but it keeps the power to change the rules for every app that runs Claude Code. OpenAI just went the other way and invited apps in.

### (c) Personal and business agent products

The theme: "an agent with its own email, phone and computer" became a funded, mainstream category in September.

- **Meta Muse** (Sep 8, 2026). A personal agent for email, bills, forms and purchases. On Sep 23 Meta announced **an email address for each Muse** (no release date given). It runs in a dedicated "Muse Secure VM". It expanded to small businesses on Sep 29. ([Axios](https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent), [TechCrunch](https://techcrunch.com/2026/09/29/meta-is-expanding-its-ai-agent-muse-to-small-businesses/))
- **Instinct.** A personal assistant you text or call. It "uses devices the same way humans do" through its own virtual phone and computer. Raised **$1B at a $10B valuation** (Sep 28). Added group chats on Oct 5. ([Bloomberg](https://www.bloomberg.com/news/articles/2026-09-28/ai-agent-startup-instinct-raises-1-billion-at-10-billion-value), [TechCrunch](https://techcrunch.com/2026/10/05/instinct-brings-its-ai-agent-to-group-chats-even-for-friends-without-an-account/))
- **Dust.** "Multiplayer AI for human-agent collaboration." $40M Series B (2026). Credit pricing, about €24 to €150 per seat. ([dust.tt](https://dust.tt/))
- **Viktor.** An "AI coworker" that lives inside Slack and Teams. $15M run rate within ten weeks of its Feb 2026 launch; $75M Series A from Accel with Slack's co-founders as angels. ([EU-Startups](https://www.eu-startups.com/2026/05/ai-coworker-startup-viktor-raises-e64-7-million-series-a-after-hitting-e12-9-million-revenue-run-rate-within-10-weeks-of-launch/))
- **Tasklet.** A "cloud agent OS for work" from the Firebase founder. $10M ARR by May 2026. ([Tasklet](https://tasklet.ai/blog/2026-04-07-20m-funding))
- **Polsia.** Runs whole companies with no human staff from one founder's idea. Reports about $10M run rate and $30M raised (press figures, unverified). Same founder market as ours, different shape.
- **Lindy, Relevance AI, Sintra, Motion, Zapier Agents, n8n, Gumloop.** No-code automation with agent branding, $19 to $200 a month. Agents are workflows, not accounts.
- **Sierra** ($15.8B, about $200M ARR) and **Ema** ($77M Series B): enterprise only.
- **Manus**: Meta's purchase was blocked by China in April; now independent. **Poke** was bought by Cognition (Devin) in July.

The building blocks are for sale on their own:

- **Email:** AgentMail (YC S25, $6M seed).
- **Phone:** Vapi ($500M valuation), Retell, Bland.
- **Payments:** Stripe Link for Agents (single-use cards, live Sep 2026), Visa Intelligent Commerce, Crossmint.
- **Vaults:** 1Password (Unified Access, and "1Password for Claude", where Claude logs in without seeing the password), Bitwarden Agent Access.
- **Computers:** E2B, Daytona, Cua (about $0.18 an hour for a Linux desktop), Orgo (always-on agent desktops from $29 a month).

Cautionary tales: 11x was reported to list customers it did not have, and ZoomInfo threatened legal action ([TechCrunch, 2025-03-24](https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have/)); Artisan apologized for "Stop Hiring Humans"; Relay.app shut down in September and deleted every account.

**What this group means for us.** Agent email, phone, payments, vault and computer are each a funded company now. Building all five ourselves means competing with each of them. Plugging them in is cheaper and more honest.

### (d) Open-source agent platforms

This is where Show HN readers will compare us first.

- **OpenClaw**: 391,519 stars. A personal agent that lives in your chat apps. Its creator joined OpenAI in February; a foundation now runs it. It is also 2026's lesson in what "trusted" agents can do wrong: a CVSS 8.8 remote code bug, a website-to-agent hijack ("ClawJacked"), 341 malicious skills in its marketplace hitting 9,000+ installs, and a breach of Moltbook (its agent social network) that exposed 1.5M API tokens. ([TechCrunch](https://techcrunch.com/2026/02/15/openclaw-creator-peter-steinberger-joins-openai/), [The Hacker News](https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html), [Cisco](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare))
- **Hermes Agent** (Nous Research): 251,691 stars, MIT. Same personal-agent shape. As of our 2026-07-27 research, its docs said plainly that "bot-to-bot conversation is not supported".
- **Paperclip**: **98,058 stars, MIT**, launched March 2026. Tagline: "The app people use to manage AI agents for work." It has org charts, **tiered goals (mission, project goal, agent goal, task)**, projects, tickets, per-agent budgets that pause the agent at 100%, scheduled wake-ups, approval steps for hiring agents, and an append-only audit log of every tool call. It runs Claude, Codex, Gemini, Cursor, Hermes, OpenClaw and OpenCode. It runs locally with no account needed. In August, Oasis Security disclosed a critical flaw (CVE-2026-41679, CVSS 10.0, fixed in v2026.416.0): with the default open sign-up, a brand-new account could approve its own credential request, reach full admin and run code, because "the architecture assumed that whoever controls agent configuration would be authenticated and authorized." ([paperclip.ing](https://paperclip.ing/), [The Hacker News](https://thehackernews.com/2026/08/paperclip-ai-flaws-let-attackers-run.html), [Oasis Security](https://www.oasis.security/blog/paperclip-agent-vulnerabilities))
- **Buzz** (Block): **35,620 stars, Apache-2.0**, launched in late July 2026 (Jul 21 or 22 depending on the source), ships a release about every week (latest Oct 6). Self-hosted, or hosted by Block. A Slack-style workspace with channels, threads, DMs, voice, repos and workflows, where "agents join as first-class members with their own keypairs, not as API bots." Every message and action is a signed event in one log. It runs Claude Code, Codex and goose agents. Free. Our source dive of 2026-09-18 found real gaps (Buzz ships weekly, so re-check): agents default to full permissions with no per-tool gate, all agents share one working folder, and there is no per-task copy of the code. ([The Next Web](https://thenextweb.com/news/block-buzz-humans-ai-agents-workspace), [Glitchwire](https://glitchwire.com/news/block-releases-buzz-an-open-source-workspace-where-humans-and-ai-agents-collabor/), `research/20260918_buzz-projects-what-is-built.md`)
- **NanoClaw**: 30,882 stars, MIT. A security-first OpenClaw alternative with one container per conversation.
- **Developer frameworks** (LangGraph, CrewAI, Microsoft Agent Framework, Mastra, Letta, OpenHands, Agent Zero): libraries, not workspaces.
- **Self-hosted chat** (Mattermost, Rocket.Chat, Zulip): AI added as an assistant feature, not as accounts.
- **"OpenMuse"** is not one project. At least three unrelated repos use the name; none has clear traction.

**What this group means for us.** Buzz is the most direct competitor to the new story: open source, self-hosted, Slack-like, agents as members with their own identity, multi-brain, backed by Block. Paperclip is the most direct competitor to the "run your business" half: goals, projects, tasks, budgets and audit, open source and local, with 98k stars. Both are ahead of us on stars by three to four orders of magnitude.

### (e) Coding-agent orchestrators

Running Claude Code, Codex and OpenCode side by side is now a common feature, often free.

- **Free or open source, multi-brain:** T3 Code (25,887 stars, MIT; desktop, web, iOS and Android; runs Claude Code, Codex, Cursor, OpenCode, Grok and Antigravity on your own subscriptions), Emdash (YC W26, 5,923 stars, Apache-2.0, 22 agents), Claude Squad (8,573, AGPL), Happy (24,037, MIT, phone control), Vibe Kanban (28,270, now shows a "sunsetting" banner), Zed's Agent Client Protocol (an open standard so any editor can drive any agent).
- **Closed, multi-brain:** Conductor (Mac), GitHub Agent HQ (agents from Anthropic, OpenAI, Google, xAI and Cognition inside GitHub), Warp Oz, HumanLayer ($100 per user per month), Superset.
- **Big single-brain businesses:** Devin (about $900M ARR, reported $47B valuation), Cursor (bought by SpaceX for about $60B), Factory ($5B valuation, Sep 2026). Devin publishes "Slack etiquette" for how its agent behaves in channels.
- **Dead or fading:** Terragon (shut down Feb 2026), Crystal (replaced by Nimbalyst), Opcode (dormant), Roo Code (shut down May 2026).

**What this group means for us.** The brief was right to drop "side by side" from the headline. It is a commodity. It still matters as a quiet advantage over ChatGPT Space (OpenAI only) and Slack Code (cloud only).

### (f) Direct "people and agents workspace" startups

Searched YC batches, Product Hunt, HN and press. The real ones:

| Product                    | Shape                                                                                                                                                                           | Money / traction                                                               | Open?            | Local?                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- | --------------------------- |
| **Ando**                   | Full Slack replacement for teams of people and agents. Agents have "their own identities and inboxes", join channels on their own, message people without waiting for approval. | $20M from Accel, Index, Emergence (Sep 24, 2026). Small teams in 15 countries. | Not stated       | Appears cloud               |
| **Buzz** (Block)           | Open-source Slack-style workspace; agents hold their own keys                                                                                                                   | 35,620 stars                                                                   | Yes (Apache-2.0) | Self-hosted or Block-hosted |
| **ChatGPT Space** (OpenAI) | Shared pages, files, team chats with Dots agents                                                                                                                                | OpenAI's paid base                                                             | No               | No                          |
| **Paperclip**              | Org chart, goals, tasks and budgets for agents                                                                                                                                  | 98,058 stars                                                                   | Yes (MIT)        | Yes                         |
| **Polsia**                 | Autonomous company builder, little human involvement                                                                                                                            | ~$30M raised (unverified)                                                      | No               | No                          |

Sources: [TechCrunch on Ando](https://techcrunch.com/2026/09/24/ando-eyes-slack-as-it-builds-team-messaging-platform-for-humans-and-agents-to-work-together/), [The AI Insider on Ando](https://theaiinsider.tech/2026/09/28/ando-emerges-from-stealth-with-20m-to-build-a-messaging-platform-for-humans-and-agents-to-work-together/).

Names from the brief that could not be confirmed as real products of this shape: Sola, Ottogrid, Cofounder.co, a business "Multi", a business "Superset", "Coral" (only a blockchain protocol by that name). The YC Summer 2026 batch had several agent-coordination startups (OpenTag, OneCLI, Dock, Almanac, Agent FM); none was checked in depth. Worth a second pass before launch.

---

## 2. How each important player treats agents

| Product              | Agents are...               | Own identity?                           | Permissions and record                        | Where it runs               | Code         | Price signal                                                                    |
| -------------------- | --------------------------- | --------------------------------------- | --------------------------------------------- | --------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Slack + Slack Code   | bots and apps in channels   | Bot account                             | OAuth scopes; 90-day logs                     | Cloud                       | Closed       | Slack Code in every plan (agent billed separately); Agentforce ~$2/conversation |
| Microsoft Agent 365  | "digital workers"           | Yes, Entra Agent ID                     | Same rules as people; agent sign-in logs      | Cloud                       | Closed       | Agent 365 ~$15/user/mo (Copilot extra)                                          |
| ChatGPT Space + Dots | always-on co-workers        | Yes, own credentials and cloud computer | Custom rules, activity view                   | Cloud                       | Closed       | First Dot included in Pro/Business Premium                                      |
| Linear               | "full members"              | Profile                                 | OAuth scopes                                  | Cloud                       | Closed       | Rides Linear seats                                                              |
| Notion               | teammates with permissions  | Agent object, not a member              | Agent runs in audit log                       | Cloud                       | Closed       | Credits on top of $20 seat                                                      |
| Asana                | AI Teammates                | Claimed                                 | "audit trail, checkpointable and reversible"  | Cloud                       | Closed       | Included, then usage                                                            |
| Ando                 | equal teammates             | Identity and inbox                      | Act without approval                          | Cloud (likely)              | Unknown      | Not public                                                                      |
| Buzz                 | first-class members         | Own keypair                             | Signed event log; full permissions by default | Self-hosted or Block-hosted | Apache-2.0   | Free                                                                            |
| Paperclip            | hired staff in an org chart | Role in org chart                       | Budgets, approvals, append-only log           | Local or cloud              | MIT          | Free                                                                            |
| OpenClaw / Hermes    | personal assistant          | Bot persona                             | Opt-in approvals                              | Local                       | MIT / OSS    | Free                                                                            |
| Meta Muse            | personal agent              | Own VM; own email announced             | Not detailed                                  | Cloud                       | Closed       | Consumer                                                                        |
| Instinct             | personal agent              | Own phone and computer                  | Not detailed                                  | Cloud                       | Closed       | Consumer                                                                        |
| T3 Code, Emdash      | coding sessions             | No                                      | Per-session                                   | Local                       | MIT / Apache | Free                                                                            |

---

## 3. The claims in our story, checked against the field

"Yes" means shipped. "Part" means a real but partial version. "DorkOS today" means what ships in the current release (checked against the code). "Planned" means the vision brief puts it after launch.

| Claim                                      | DorkOS today                              | DorkOS vision           | Slack (+Code)     | ChatGPT Space          | MS Agent 365                  | Ando                   | Buzz                     | Paperclip                      | OpenClaw              |
| ------------------------------------------ | ----------------------------------------- | ----------------------- | ----------------- | ---------------------- | ----------------------------- | ---------------------- | ------------------------ | ------------------------------ | --------------------- |
| Equal accounts for people and agents       | Part (agents have profiles, sit in rooms) | Planned                 | No (bots)         | Part                   | Part (separate identity type) | Yes (claimed)          | Yes                      | Part (staff, not chat members) | No                    |
| Trusted by default                         | Part (full power exists; caps still on)   | Planned                 | No                | Part (rules)           | No                            | Yes                    | Yes                      | Part (budgets, approvals)      | Yes, and it hurt them |
| Audit trail everyone can read              | Part (activity feed)                      | Pre-launch step         | Admin logs        | Activity view          | Sign-in logs                  | Unknown                | Yes (signed log)         | Yes (append-only)              | No                    |
| Agent email                                | No                                        | Planned                 | No                | Not found              | Unclear                       | "Inboxes" (claimed)    | No                       | No                             | Via skills            |
| Agent phone                                | No                                        | Planned                 | No                | Later (audio)          | No                            | Calls with transcripts | Voice rooms              | No                             | Via channels          |
| Agent vault                                | No                                        | Planned                 | No                | Not found              | Via Entra                     | Unknown                | No                       | No                             | No                    |
| Agent's own computer                       | Its owner's computer                      | Planned (behind a flag) | No                | Yes (cloud)            | No                            | Unknown                | No                       | No                             | The owner's computer  |
| Many brains (Claude Code, Codex, OpenCode) | Yes                                       | Yes                     | Yes (in cloud)    | No (OpenAI only)       | Governs many                  | Unknown                | Yes                      | Yes                            | No                    |
| Local first                                | Yes                                       | Yes                     | No                | No                     | No                            | No (likely)            | Yes                      | Yes                            | Yes                   |
| Open source                                | Yes (MIT)                                 | Yes                     | No                | No                     | No                            | Unknown                | Yes                      | Yes                            | Yes                   |
| Mini apps inside the workspace             | Part (widgets, canvas, extensions)        | Planned                 | Part ("Surfaces") | Part (Pages, Apps SDK) | No                            | No                     | No                       | No                             | No                    |
| Groups, projects, tiered goals             | No                                        | Planned                 | No                | Part (projects)        | No                            | No                     | Part (projects = repos)  | Yes                            | No                    |
| Programmable (CLI, API, events)            | Part (REST API, MCP, CLI)                 | Planned (GraphQL, SDK)  | Yes (APIs, MCP)   | Part (Apps SDK)        | Yes                           | Unknown                | Yes (Nostr, CLI)         | Yes (API)                      | Yes                   |
| Agents work in your real folders           | Yes                                       | Yes                     | No                | No                     | No                            | No                     | Part (one shared folder) | Yes (via runtimes)             | Yes                   |

Read across, two things stand out:

1. **No row is ours alone.** Every single claim is matched by at least one rival, usually a better-funded or better-known one.
2. **One column shape is ours alone today:** local, open source, many brains, agents working in your real folders, and group chat with people, all at once. Buzz is the nearest match and lacks safe per-task code copies and any business layer. Paperclip has the business layer but is not a chat workspace.

---

## 4. Honest assessment

### Where DorkOS genuinely wins

- **Your real computer, your real files.** ChatGPT Space, Slack Code, Dots, Cowork and Projects all work on cloud copies. A DorkOS agent works in the folder you actually use, with your tools, your git setup and your logins. For a founder whose business lives in a laptop full of repos and docs, this is real and hard for cloud players to copy without asking for a sync.
- **Many brains in one room.** OpenAI will never put Claude in Space. Anthropic will never put Codex in Projects. Slack does both, but only in the cloud and only for coding. Being the neutral place that runs whichever model is best this month is a lasting position, even if it no longer leads the story.
- **Working copies done right.** Our own research found per-task code copies, port handling and safe clean-up are where rival tools lose people's work. Buzz skipped this layer entirely. It is invisible in a pitch but decisive in daily use for anyone shipping code.
- **Depth that already exists.** Scheduling, rooms with several agents and people, phone reach through the built-in tunnel, a plugin marketplace, a desktop app and an API all ship today. Most open-source rivals do one of these.
- **Honest trust design.** The brief already keeps strangers, outside messages and third-party code locked out while trusting our own agents. OpenClaw's exposed setups and malicious skills, and Paperclip's open-sign-up flaw, show what happens when outsiders slip past that line. If we prove ours holds, it is a story.
- **Built by its own agents.** DorkOS is built by fleets of agents coordinated inside DorkOS. Real receipts from our own repo are a demo no rival can fake.

### Where DorkOS loses

- **Distribution, by a lot.** 10 GitHub stars against Buzz's 35,620, Paperclip's 98,058 and OpenClaw's 391,519. Slack, Microsoft, Google and OpenAI already have the users logged in. Ando has $20M and Accel. Show HN is one shot at changing this.
- **Always-on.** Founders want the business to keep running when the laptop sleeps. Dots, Cowork, Muse and Instinct all run in the cloud by default. DorkOS needs the computer awake, or managed remote access and later cloud computers (which the brief says are not built). This is the biggest gap between the founder story and the product.
- **The shiny pieces are someone else's whole company.** Agent email (AgentMail, Muse), phone (Vapi, Instinct), payments (Stripe, Visa), vaults (1Password, Bitwarden), computers (E2B, Orgo, Dots) and live shared docs (Notion, OpenAI Pages) each have a focused, funded leader.
- **Ease of use for a semi-technical founder.** Our install is a download (Mac) or a CLI, plus signing in to your own AI tools. Ando, Space and Muse are a sign-up page. The founder persona is "semi-technical", so a CLI is fine for many, but it is a filter.
- **Business layer.** Paperclip already ships goals, projects, budgets and an org chart, open source, with a large following. Ours is planned after launch.

### Already commoditised, or about to be

| Claim                                                   | Status                        | Who made it common                                            |
| ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| "Agents are co-workers, not assistants"                 | Commoditised                  | Microsoft, Asana, Linear, Viktor, Ando, OpenAI Dots           |
| Agents in channels with people                          | Commoditised                  | Slack Code (free), Buzz, Ando, ChatGPT Space                  |
| Many coding brains side by side                         | Commoditised                  | T3 Code, Emdash, Zed ACP, GitHub Agent HQ, Slack Code         |
| Audit trail of agent actions                            | Commoditised                  | Notion, Asana, Paperclip, Buzz, Microsoft                     |
| Agent identity                                          | Becoming standard             | Entra Agent ID, Buzz keypairs, Ando                           |
| Agent email                                             | Becoming standard             | AgentMail, Ando inboxes, Meta Muse (announced)                |
| Agent's own computer                                    | Becoming standard             | Dots, Muse, Instinct, Orgo, Cua                               |
| Tiered goals and org charts                             | Taken by an open-source rival | Paperclip                                                     |
| Mini apps inside the workspace                          | Contested                     | Slack Surfaces, OpenAI Apps SDK and Pages                     |
| Local first and open source **together with** the above | **Not commoditised**          | Only Buzz and Paperclip come close, each with a different gap |

### The biggest threats

1. **OpenAI ChatGPT Space and Dots.** A shared workspace, agent co-workers with their own computers, inside a product hundreds of millions already pay for. If a founder's question is "where do my agents and my team work together?", OpenAI now has a one-click answer. Our counters are many brains, local files, open source and no lock-in. Those matter more to Kai than to a founder.
2. **Slack.** Slack Code comes with every Slack plan, has most major coding agents as launch partners, and sits where teams already talk. "A Slack-like workspace" invites the question "why not Slack?" before the reader reaches the second sentence.
3. **Buzz.** The same open-source pitch, from Block and Jack Dorsey, ten weeks earlier, shipping weekly. HN will ask "how is this different from Buzz?" in the first hour. We need a crisp answer.
4. **Paperclip.** Owns "open-source OS for running a company with agents" in developers' minds. Its CVSS 10.0 flaw (now fixed) also shows how fast a security slip in this category becomes a headline.
5. **Anthropic's terms.** Claude Code is our default brain. Anthropic has changed the rules for third-party apps several times this year and reserves the right to do it again without notice. The brief already says DorkOS's current use of the Agent SDK on a person's plan is in the gray area. A local sign-in lowers that risk but does not remove it. Two parts of the vision brief make it worse:
   - The **sign-in drive** idea (one long-lived `claude setup-token` shared by many agents) is close to the hard line in our own compliance research: pulling a subscription token out and passing it to the SDK. Anthropic's terms also say plan limits assume "ordinary, individual usage". One login powering a fleet does not look ordinary.
   - **Hosted agents** on DorkOS Cloud are only safe if each person signs in to unmodified Claude Code with their own plan, and DorkOS never pays for, stores or passes on that sign-in. If DorkOS pays for people's Claude usage in hosted computers, it needs an agreement with Anthropic (the brief agrees).

   Meanwhile OpenAI now openly invites approved apps to use a person's ChatGPT plan. That asymmetry is an opportunity: make Codex and OpenCode first-class, and keep Claude Code on the person's own sign-in only.

6. **A security incident at launch.** "Trusted by default" plus "no posting caps" plus Show HN is the exact setup that made OpenClaw and Paperclip into security headlines. One bad demo or one CVE in the launch week would define us.
7. **Overclaiming.** The vision is mostly post-launch. If the launch page reads like the vision, the HN crowd will install it, find rooms and agents but no email, phone, vault, goals or mini-app builder, and say so in public. The demo-claim gate in AGENTS.md exists for exactly this.

### Is "founder" plus "local first" a coherent pair?

Partly. It is coherent if local first means **ownership**: your data, your files, your existing AI subscriptions, no per-seat fees, leave whenever you want. Founders care about cost and lock-in, and "use the Claude and ChatGPT plans you already pay for" is a strong money story.

It is incoherent if local first means **runs only while your laptop is open**. A founder running a business through agents needs it running at 3am, needs a co-founder or contractor to reach it, and needs it from a phone. Every founder-facing rival is cloud first for this reason. The brief's answer (managed remote access at launch, cloud computers later) is the right shape, but at launch the honest pitch is "it runs on your Mac and you reach it from anywhere", not "it runs your business while you sleep".

There is also an audience mismatch. Show HN readers are mostly Kai: developers. The founder persona mostly is not on HN. Launching a founder story on HN works only if the founder is technical, which describes Dorian and many YC founders. So the launch story should be a technical founder's story.

### Is the scope too wide?

Yes, clearly. The brief lists 17 core ideas and nine post-launch phases, including a server rewrite, a new message system, GraphQL, an email system, phone, a vault, payments, Linux computers, publishing with abuse controls, and live shared documents. Each of those is a whole company for someone else. Paperclip got to 98k stars on one idea (an org chart for agents). Buzz got to 35k on one idea (Slack where agents have their own keys). DorkOS is one person and a fleet of agents.

The risk is not only time. A wide story is a blurry story. "The single interface a founder uses to run their whole business" is a promise that invites comparison with Slack, Notion, Gmail, QuickBooks and ChatGPT all at once.

### The Community Space as the launch centerpiece

The brief makes the DorkOS Community Space the heart of launch: every new account joins it, it replaces a Discord, and it is the only space open at launch. Here is how that compares.

| Option                     | Who uses it                                       | Strength                                                   | Weakness                                      |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| **Discord**                | OpenClaw, Hermes and most open-source AI projects | Everyone already has an account; zero setup                | Poor search; nothing there is our product     |
| **Slack communities**      | Many developer tools                              | Familiar to founders                                       | Free plan hides old messages; not our product |
| **Buzz, hosted by Block**  | Buzz users                                        | People and agents meet on the product itself               | A head start and a bigger audience            |
| **GitHub Discussions**     | Most open-source repos                            | Searchable, indexed by Google                              | Slow, not chat                                |
| **DorkOS Community Space** | Every new DorkOS account                          | Every visitor uses the product on day one; agents can join | Starts empty; we carry moderation and uptime  |

**What is strong about it.** It is the best demo we could give. A person installs DorkOS and is instantly in a live room with people and agents, which is the whole story in one click. No other product in this report is known to drop every new user straight into one shared space with other people's agents. It also turns launch traffic into retained users instead of Discord members.

**What is risky about it.**

- **An empty room at launch looks worse than no room.** The two-week soft launch with current users is the right fix. Seed it with real conversation and a few useful house agents before the public date.
- **It is full of strangers.** Under the brief's own rules, messages from people outside your space never get your agents full power. The Community Space is exactly where that rule gets tested in public, by HN readers who will try prompt injection for fun. The stranger protections (trust step 3) must be proven before the doors open, not after.
- **Moderation and spam.** Every public chat draws spam. The brief's decision-model idea (cheap models doing first-line moderation) fits here, but it is not built yet. Plan for human moderators at launch.
- **It ties launch to uptime.** If the Community Space is down on launch day, the product looks down. Discord never goes down because of us.

**Verdict.** Keep it as the centerpiece. It is the one launch idea no rival copies, and it makes the "people and agents together" story visible instead of described. Make public read-only pages (or a weekly digest) so the community is searchable, which is Discord's biggest weakness. And do not open it until the stranger protections are tested.

### The sharpest wedge for launch

**"Your AI team works on your own computer, in one group chat with you."**

In plain terms: you, your co-founder and your Claude Code, Codex and OpenCode agents share channels and DMs. The agents work in your real folders, schedule their own work, and every action they take is in a record anyone in the room can read. It is free, open source, and you reach it from your phone.

Why this wedge:

- **Every word is true at launch.** Rooms, many brains, real folders, schedules, phone reach and (after trust step 2) the audit trail all ship before launch.
- **It answers the three first-hour questions.** Why not Slack Code? It runs on your machine, with your files, and is not only for code. Why not ChatGPT Space? Any brain, your files, open source. Why not Buzz? Each agent gets its own safe copy of the code, there are schedules, and there is a direct-chat view with the agent's full working.
- **It carries the founder story without overclaiming.** Show one founder running a real business this way for a week, with receipts: the DorkOS repo itself.

---

## 5. Recommendations

### Positioning

- **Category line:** "A workspace for people and agents, on your own computer." Keep "You, Multiplied." as the tagline.
- **Say "on your own computer" early.** It is the one word-pair no cloud rival can say, and it is true.
- **Lead with ownership, not "local first".** "Your files, your AI plans, your data. Free forever on your computer." Founders hear cost and control. Developers hear local.
- **Drop "Slack-like" from headlines.** It invites "why not Slack?". Describe the experience instead (channels, DMs, threads) and let readers draw the comparison.
- **Do not lead with "no human required".** After Artisan's "Stop Hiring Humans" backlash and the OpenClaw incidents, it reads as a threat. Keep it in the docs as a capability.
- **Turn trust into proof.** "Our agents are trusted; strangers never are." Publish the threat model on day one, and explain how the stranger protections are tested.
- **Prepare a one-line answer to each of: Slack Code, ChatGPT Space, Buzz, Paperclip, OpenClaw.** Put them in the launch FAQ and the `/compare` pages (Buzz and OpenClaw pages exist; add Paperclip, Ando and ChatGPT Space).

### The one launch story

Install DorkOS and you land in the Community Space, a live room where people and their agents already work together. Then the proof: a technical founder (Dorian) runs DorkOS itself with a team of agents for a month. Show the receipts: the agents' PRs, scheduled jobs, room threads where agents and the founder decide things, the audit record, and the phone view at 11pm. Title idea: "Show HN: DorkOS, an open-source workspace where you and your AI agents work on your own computer." One demo video, one blog post, one repo.

### Cut or defer

Defer past launch, and keep out of launch copy:

- **Phone and payments.** Heavy regulation (US texting registration), fraud risk, and focused leaders (Vapi, Stripe). Plug these in later rather than build.
- **Agents' own Linux computers and moving agents to the cloud.** Dots, Muse, Instinct, Orgo and Cua own this. It is not built and not needed for launch (the brief agrees).
- **Free public publishing.** Spam and phishing magnet, needs its own abuse team. Not core.
- **Live shared docs with Yjs.** Notion and OpenAI Pages own this. Chat plus files in your folder are enough at first.
- **GraphQL over everything.** A REST API, MCP and CLI already cover agents and power users. GraphQL is a nice-to-have.
- **The sign-in drive.** Drop it from the plan. It is the riskiest item against Anthropic's terms and saves people one sign-in.
- **Build-your-own email.** Bring-your-own Google Workspace or domain is fine. For hosted addresses, partner with an agent-email provider before building one.

Consider not building at all:

- **Tiered goals and the org chart, if Paperclip already does them well.** A two-way link (agents in DorkOS rooms, goals and budgets in Paperclip) may be faster and earns goodwill from a 98k-star community. Nous Research already publishes one for Hermes ([hermes-paperclip-adapter](https://github.com/NousResearch/hermes-paperclip-adapter), 1,947 stars). If we do build our own, keep it small and chat-native.

### Double down on

1. **The audit trail.** It is trust step 2, it unlocks the trust story, and it is the most demo-able safety feature. Make it beautiful and readable by a non-developer.
2. **Rooms with people and many agents.** The core experience. Make the "people and agents in one thread" moment feel better than Slack Code's.
3. **Working in your real folders, safely.** Per-task code copies, ports and clean-up that never loses work. This is the Buzz answer and the Kai answer.
4. **Mini apps.** The one claim that is both visual and not yet owned by an open-source rival. "Ask an agent for a dashboard, get a working app in the side panel" is a strong 20-second demo, and LifeOS proves it.
5. **The vault, early.** "Agents use your passwords without seeing them" is a security story that supports trust by default. 1Password and Bitwarden show the shape; ours can be local.
6. **OpenAI's door.** Make Codex and OpenCode feel as good as Claude Code. Joining Sign in with ChatGPT would mean contacting OpenAI, which Dorian decided against on 2026-10-06. We suggest revisiting that for OpenAI only: it is a sanctioned way in, and it lowers the Anthropic risk the brief accepts.

### Pricing observations

- **The market pays for usage, not seats, for agents.** Notion, Asana, Dust, monday.com and Slack all moved agent pricing to credits or per-action fees in 2026. Seat-based agent pricing anywhere will look expensive next to "Slack Code comes with every plan" and "your first Dot is included".
- **Free is the norm for open source rivals.** Buzz, Paperclip, OpenClaw, Hermes, T3 Code and Emdash are free. "Free forever on your computer" is table stakes, not a perk.
- **Charge for what only a server can do.** Always-on running, managed remote access, hosted email addresses, extra storage, model credits. These are what founders already pay others for. The brief's split (free local, paid cloud) fits this.
- **"Use the AI plans you already pay for" is a selling point,** but only where the vendor allows it. Today that is OpenAI by policy, and Claude only through the person's own local sign-in.

---

## Gaps and things to re-check before launch

- Ando: pricing, which models it runs, and whether it is open source were not public. Re-check before launch.
- When the Sign in with ChatGPT preview opens beyond its 16 partners.
- Anthropic's paused billing change: check for a new date in the week before launch.
- The YC Summer 2026 agent-coordination startups (OpenTag, OneCLI, Dock, Almanac, Agent FM) were only seen by name.
- Several prices (Agent 365, Agentforce in Slack, monday.com agents) come from secondary sites. Confirm on vendor pages before quoting publicly.
- Star counts move daily. Re-pull from the GitHub API before using any number in public copy.
