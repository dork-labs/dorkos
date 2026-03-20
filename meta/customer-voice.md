# Customer Voice: Real Developer Frustrations DorkOS Solves

> Verbatim quotes and attributed paraphrases from developers across Hacker News, GitHub Issues, Reddit, and developer blogs. Organized by pain theme. Collected February 2026.

---

## How to Read This Document

Each quote is tagged with:

- **Source** — platform, username (if public), date
- **Type** — `[frustration]`, `[wish]`, or `[workaround]`
- **Theme** — the DorkOS pain theme it maps to

Quotes marked with (paraphrase) are close summaries of longer discussions with the original URL. All others are verbatim or near-verbatim.

---

## Theme 1: Terminal Isolation

_Developers frustrated that AI coding agents are stuck in the terminal — can't check on them remotely, can't manage multiple sessions, trapped at the desk._

---

**Quote 1.1**

> "I was running Claude Code across 10+ terminal tabs and constantly switching between them to check which session needed permission, which was done, which was idle."

- **Source:** Hacker News, user `minchenlee`, thread: [Show HN: C9watch – macOS menu bar app to monitor all Claude Code sessions](https://news.ycombinator.com/item?id=47180850) (Feb 2026)
- **Type:** `[frustration]` — motivated them to build a monitoring tool
- **Theme:** Terminal Isolation

---

**Quote 1.2**

> "Remote Control requires a terminal session already running on the host. If I'm away from my desk, I can't start a new session from my phone — I have to SSH in first and launch it manually."

- **Source:** GitHub, user `Reid-Garner`, [claude-code issue #28420](https://github.com/anthropics/claude-code/issues/28420) (Feb 25, 2026)
- **Type:** `[frustration]`
- **Theme:** Terminal Isolation

---

**Quote 1.3**

> "The easiest example scenario is anytime I am away from my computer — that's when my best ideas strike. Go out for a walk to clear your head on an issue. Issue resolution comes to you, but you are 30 mins away from your computer. Send the fix in detail via your phone to Claude Code. Come back to magic."

- **Source:** GitHub, user `Reid-Garner`, [claude-code issue #28420](https://github.com/anthropics/claude-code/issues/28420) (Feb 25, 2026)
- **Type:** `[wish]`
- **Theme:** Terminal Isolation

---

**Quote 1.4**

> "I run multiple autonomous agents across projects and frequently have ideas while away from my desk. I want to say 'Hey Siri, start Claude on project A — add rate limiting to the WebSocket handler' and have it just work. Review the results when I'm back."

- **Source:** GitHub, user `Reid-Garner`, [claude-code issue #28420](https://github.com/anthropics/claude-code/issues/28420) (Feb 25, 2026)
- **Type:** `[wish]`
- **Theme:** Terminal Isolation

---

**Quote 1.5**

> "Current workaround: Tailscale + SSH + a bash script that spawns `claude remote-control` in tmux, triggered by Apple Shortcuts. Works but fragile and no back-and-forth voice support."

- **Source:** GitHub, user `Reid-Garner`, [claude-code issue #28420](https://github.com/anthropics/claude-code/issues/28420) (Feb 25, 2026)
- **Type:** `[workaround]`
- **Theme:** Terminal Isolation

---

**Quote 1.6**

> "Claude Code still doesn't have a documented mechanism for running things on a schedule." _(noting this as a critical gap vs. competing products)_

- **Source:** Simon Willison, [simonwillison.net — Claude Code Remote Control](https://simonwillison.net/2026/Feb/25/claude-code-remote-control/) (Feb 25, 2026)
- **Type:** `[frustration]`
- **Theme:** Terminal Isolation / Background Execution

---

**Quote 1.7**

> "you go check Slack, come back five minutes later, and it's just sitting there asking 'Can I edit this file?'"

- **Source:** builder.io blog, [How I use Claude Code](https://www.builder.io/blog/claude-code) (2025)
- **Type:** `[frustration]` — written by a developer describing the approval-interrupt loop
- **Theme:** Terminal Isolation

---

**Quote 1.8**
_(paraphrase)_ Power users building remote access solutions describe a patchwork of third-party tools — Tailscale for secure tunneling, Termius or Termux for mobile SSH, tmux for session persistence — before Anthropic shipped Remote Control in February 2026. The very existence of this workaround stack proves the demand was real.

- **Source:** [VentureBeat coverage of Claude Code Remote Control](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote) (Feb 2026)
- **Type:** `[workaround]`
- **Theme:** Terminal Isolation

---

## Theme 2: No Background / Scheduled Execution

_Developers wanting agents to run overnight, on a schedule, without keeping a terminal open. The "Mac sleep" problem._

---

**Quote 2.1**

> "one of the main annoyances I've been dealing with is that when Claude works for a long time, my Mac may go to sleep... it's very annoying to return to the computer only to find that it hasn't been doing anything in the meantime."

- **Source:** Developer blog, tngranados.com, [Keep your Mac awake when using Claude Code](https://tngranados.com/blog/preventing-mac-sleep-claude-code/) (2025)
- **Type:** `[frustration]`
- **Theme:** Background / Scheduled Execution

---

**Quote 2.2**

> "I use Claude Code overnight almost exclusively, it's simply not worth my time during the day. It's just easier to prepare precise instructions, let it run and check the results in the morning."

- **Source:** Hacker News, user `benterix`, [thread on overnight Claude Code usage](https://news.ycombinator.com/item?id=44718795)
- **Type:** `[workaround]` — describes the desired pattern, implying the tooling to do it cleanly doesn't exist
- **Theme:** Background / Scheduled Execution

---

**Quote 2.3**

> "you burn through your session at 3pm, and then you're locked out until 8pm. That's a 5-hour cooldown with zero usage. Half your workday, gone."

- **Source:** DEV Community, user `sleeyax`, [Stop wasting hours on Claude Code Pro's session cooldown](https://dev.to/sleeyax/stop-wasting-hours-on-claude-code-pros-session-cooldown-4mak) (2025)
- **Type:** `[frustration]`
- **Theme:** Background / Scheduled Execution

---

**Quote 2.4**

> "Scheduled tasks only run while your computer is awake and the Claude Desktop app is open. If your computer is asleep or the app is closed when a task is scheduled to run, Cowork will skip the task."

- **Source:** Anthropic's own Cowork documentation, [support.claude.com — Get started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-cowork)
- **Type:** `[frustration]` — Anthropic's own product acknowledges the Mac sleep problem
- **Theme:** Background / Scheduled Execution

---

**Quote 2.5**

> "Imagine coming into work to find overnight AI PRs for all the refactoring tasks you queued up — ready for your review."

- **Source:** Addy Osmani, quoted in RedMonk, [10 Things Developers Want from their Agentic IDEs in 2025](https://redmonk.com/kholterhoff/2025/12/22/10-things-developers-want-from-their-agentic-ides-in-2025/) (Dec 2025)
- **Type:** `[wish]`
- **Theme:** Background / Scheduled Execution

---

**Quote 2.6**

> "The `Task` tool currently executes agents synchronously, blocking the orchestrator until all spawned agents complete their work... This forces users to either wait synchronously for all agents to complete before continuing work, use workarounds like `claude -p` in separate terminals (losing integration with orchestrator), or sacrifice parallelism by running agents sequentially to maintain responsiveness."

- **Source:** GitHub, user `mishaal79`, [claude-code issue #9905](https://github.com/anthropics/claude-code/issues/9905) (Oct 19, 2025)
- **Type:** `[frustration]`
- **Theme:** Background / Scheduled Execution

---

**Quote 2.7**

> "I set a schedule (e.g. let it run overnight) with a token budget, and you can add your own tasks manually."

- **Source:** Hacker News, description of Sustn tool, [Show HN: Sustn](https://news.ycombinator.com/item?id=47150407) (2026) — the fact a third-party tool exists for this confirms native gaps
- **Type:** `[workaround]`
- **Theme:** Background / Scheduled Execution

---

**Quote 2.8**

> "I've definitely set Claude Code on a task and then wandered off to do something else, and come back an hour or so later."

- **Source:** Hacker News, user `kelnos`, [thread on overnight Claude Code usage](https://news.ycombinator.com/item?id=44718795)
- **Type:** `[workaround]` — describes ad-hoc unattended execution with no infrastructure support
- **Theme:** Background / Scheduled Execution

---

## Theme 3: Agent Communication

_Developers wanting agents to notify them (Telegram, Slack, etc.) when done, wanting agents to talk to each other or coordinate, multi-agent frustrations._

---

**Quote 3.1**

> "the agent would finish or get stuck asking a question, and I wouldn't notice until much later."

- **Source:** Hacker News, user `brainsofbots`, [Show HN: Let your Claude Code message you on Telegram when it needs decisions](https://news.ycombinator.com/item?id=46563672) — motivation for building Agent Reachout
- **Type:** `[frustration]`
- **Theme:** Agent Communication

---

**Quote 3.2**

> "Would it be possible to add a config option to display a notification when a prompt has finished? For example on Ubuntu, I would like to be able to start a ClaudeCode prompt, do something else, and once the prompt has finished, get an OS popup notification. Ideally, I would like to be able to click on the notification to get transported to directly the right ClaudeCode terminal."

- **Source:** GitHub, user `jc4396-claude`, [claude-code issue #6454](https://github.com/anthropics/claude-code/issues/6454) (Aug 24, 2025)
- **Type:** `[wish]`
- **Theme:** Agent Communication

---

**Quote 3.3** _(Note: issue #6454 generated 5 duplicate issues: #7239, #9878, #11665, #12317 — indicating widespread demand)_

> "The issue received significant engagement with 4 upvotes on the original request and multiple duplicate issues."

- **Source:** GitHub, [claude-code issue #6454](https://github.com/anthropics/claude-code/issues/6454) and duplicates
- **Type:** `[frustration]`
- **Theme:** Agent Communication

---

**Quote 3.4**

> "You can't observe what 20 agents are doing."

- **Source:** Hacker News, user `gck1`, [Show HN: 20+ Claude Code agents coordinating on real work](https://news.ycombinator.com/item?id=46990733)
- **Type:** `[frustration]`
- **Theme:** Agent Communication / Terminal Isolation

---

**Quote 3.5**

> "The context required to solve the problem exceeds what one agent can hold... [The most frustrating failure mode is] generating solutions that obviously didn't compile."

- **Source:** Hacker News, user `austinbaggio`, [Show HN: 20+ Claude Code agents coordinating on real work](https://news.ycombinator.com/item?id=46990733)
- **Type:** `[frustration]`
- **Theme:** Agent Communication

---

**Quote 3.6**

> "Failed strategies + successful tactics all get written to shared memory so subsequent agents avoid repeated failures." _(describing their multi-agent workaround)_

- **Source:** Hacker News, user `austinbaggio`, [Show HN: 20+ Claude Code agents coordinating on real work](https://news.ycombinator.com/item?id=46990733)
- **Type:** `[workaround]`
- **Theme:** Agent Communication

---

**Quote 3.7**

> "Claude code doesn't support subscriptions out of the box, so we use the subscription feature to just alert."

- **Source:** Hacker News, user `miligauss`, [Show HN: 20+ Claude Code agents coordinating on real work](https://news.ycombinator.com/item?id=46990733)
- **Type:** `[workaround]`
- **Theme:** Agent Communication

---

**Quote 3.8**

> "Elite developers increasingly expect dashboards showing which agents are working on what, the ability to pause, redirect, or terminate agents mid-task, and intelligent conflict resolution when agents work on overlapping code."

- **Source:** RedMonk, [10 Things Developers Want from their Agentic IDEs in 2025](https://redmonk.com/kholterhoff/2025/12/22/10-things-developers-want-from-their-agentic-ides-in-2025/) (Dec 2025)
- **Type:** `[wish]`
- **Theme:** Agent Communication

---

## Theme 4: Session Memory / Context Loss

_Developers frustrated that every agent session starts from scratch. No memory between sessions. Having to re-explain context every time._

---

**Quote 4.1**

> "Claude Code starts every session with zero context. There is no memory of previous sessions, previous work, or accumulated understanding of the user's projects and preferences... Claude Code has none of this. It's a goldfish."

- **Source:** GitHub, user `sudoxreboot`, [claude-code issue #14227](https://github.com/anthropics/claude-code/issues/14227) (Dec 16, 2025)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.2**

> "The value of an AI assistant compounds over time. Every session that starts from zero wastes that compounding. Users paying for Claude expect continuity across the product, not amnesia in the CLI."

- **Source:** GitHub, user `sudoxreboot`, [claude-code issue #14227](https://github.com/anthropics/claude-code/issues/14227) (Dec 16, 2025)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.3**

> "I got tired of Claude Code forgetting all my context every time I open a new session."

- **Source:** Hacker News, user `austinbaggio`, [Show HN: Stop Claude Code from forgetting everything](https://news.ycombinator.com/item?id=46426624)
- **Type:** `[frustration]` — motivated them to build a solution
- **Theme:** Session Memory / Context Loss

---

**Quote 4.4**

> "Session-level action context — 'where did I leave off last time,' 'which files did I edit' — disappears every time. This hurts."

- **Source:** DEV Community, `shimo4228`, [Embedding Memory into Claude Code](https://dev.to/shimo4228/embedding-memory-into-claude-code-from-session-loss-to-persistent-context-54d8)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.5**

> "I lost a full afternoon's work last week. Four hours of debugging a gnarly database migration... Each session is a blank slate. The context you built up — the decisions, the dead ends, the 'wait, we tried that and it failed because...' — evaporates."

- **Source:** DEV Community, `gonewx`, [I tried 3 different ways to fix Claude Code's memory problem](https://dev.to/gonewx/i-tried-3-different-ways-to-fix-claude-codes-memory-problem-heres-what-actually-worked-30fk)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.6**

> "None of these solutions are great. They're workarounds for a tool design limitation. The real fix would be native session persistence — where Claude Code can optionally pull in relevant history from past sessions automatically, without you having to manually manage CLAUDE.md files or MCP memory servers."

- **Source:** DEV Community, `gonewx`, [I tried 3 different ways to fix Claude Code's memory problem](https://dev.to/gonewx/i-tried-3-different-ways-to-fix-claude-codes-memory-problem-heres-what-actually-worked-30fk)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.7**

> "Instructions given 30 minutes earlier are completely forgotten... Explicitly instructed Claude Code to use my name and email for Git commits. 30 minutes later, Claude Code attempted to push with username 'claude' and email 'noreply@anthropic.ai'. When questioned, acted as if no previous Git configuration instructions existed."

- **Source:** GitHub, user `SDS-Mike`, [claude-code issue #2545 — Severe Session Memory Loss](https://github.com/anthropics/claude-code/issues/2545) (Jun 2025)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.8**

> "AI can't retain learning between sessions (unless you spend the time manually giving it the 'memories'). So typically, every conversation starts fresh... Without this context, you're explaining the same constraints repeatedly. With it, you start at attempt two instead of attempt one."

- **Source:** Vincent Quigley / Sanity.io blog, [First attempt will be 95% garbage](https://www.sanity.io/blog/first-attempt-will-be-95-garbage)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.9**

> "duplicated explanations, divergent state between agents, and lost context when switching tools or models"

- **Source:** Hacker News, user `christinetyip`, [Show HN: Stop Claude Code from forgetting everything](https://news.ycombinator.com/item?id=46426624)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

**Quote 4.10**

> "no one really knows for sure how to get past the spot we all hit where the agentic project that was progressing perfectly hits a sharp downtrend in progress."

- **Source:** Hacker News, user `gbnwl`, [Show HN: Stop Claude Code from forgetting everything](https://news.ycombinator.com/item?id=46426624)
- **Type:** `[frustration]`
- **Theme:** Session Memory / Context Loss

---

## Theme 5: Trust and Transparency

_Developers worried about autonomous agents running unsupervised. Wanting guardrails, audit trails, visibility into what agents did. The DROP DATABASE fear._

---

**Quote 5.1**

> "Has anyone run with `dangerously skip permissions` and had something catastrophic happen? Are there internal guardrails within Claude Code to prevent such incidents? rm -rf, drop database, etc?"

- **Source:** Hacker News, user `aantix`, [thread on dangerously-skip-permissions](https://news.ycombinator.com/item?id=44865926)
- **Type:** `[frustration]` — asking because the risk is real
- **Theme:** Trust and Transparency

---

**Quote 5.2**

> "A couple of weeks ago I asked it to 'clean up' instead of the word I usually use and it ended up deleting both my production and dev databases."

- **Source:** Hacker News, user `browningstreet`, [thread on dangerously-skip-permissions](https://news.ycombinator.com/item?id=44865926)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.3**

> "Claude is very happy to wipe remote dbs, particularly if you're using something like supabase's mcp server."

- **Source:** Hacker News, user `prodigycorp`, [Running Claude Code dangerously (safely)](https://news.ycombinator.com/item?id=46690907)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.4**

> "MattGaiser: Claude has twice now thought that deleting the database is the right thing to do."

- **Source:** Hacker News, user `MattGaiser`, [Running Claude Code dangerously (safely)](https://news.ycombinator.com/item?id=46690907)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.5**

> "It's impossible to not get decision-fatigue and just mash enter anyway after a couple of months with Claude not messing anything important up."

- **Source:** Hacker News, user `runekaagaard`, [Running Claude Code dangerously (safely)](https://news.ycombinator.com/item?id=46690907)
- **Type:** `[frustration]` — describes the approval-fatigue failure mode where humans rubber-stamp everything
- **Theme:** Trust and Transparency

---

**Quote 5.6**

> "I caught Claude using docker (running as root) to access files on my machine it couldn't read using its user."

- **Source:** Hacker News, user `foreigner`, [Running Claude Code dangerously (safely)](https://news.ycombinator.com/item?id=46690907)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.7**

> "Don't blindly merge what comes out of this. The agent can do way more than you asked, and unexpected stuff... Imagine scrolling through 40-50 runs of changes overnight… not fun to review all of that... It's scary because you're giving up control."

- **Source:** Developer blog, `mfyz.com`, [Claude Code on Loop: The Ultimate YOLO Mode](https://mfyz.com/claude-code-on-loop-autonomous-ai-coding/)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.8**

> "It took me some time to trust it — 2-3 days despite the model being Sonnet 4."

- **Source:** sankalp.bearblog.dev, [My Experience With Claude Code After 2 Weeks](https://sankalp.bearblog.dev/my-claude-code-experience-after-2-weeks-of-usage/)
- **Type:** `[frustration]` — trust is earned slowly and nervously
- **Theme:** Trust and Transparency

---

**Quote 5.9**

> "AI confidently writes broken code claiming that it's great. Always verify, especially for: Complex state management, Performance-critical sections, Security-sensitive code."

- **Source:** Vincent Quigley / Sanity.io blog, [First attempt will be 95% garbage](https://www.sanity.io/blog/first-attempt-will-be-95-garbage)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency

---

**Quote 5.10**

> "Developers demand fine-grained permissions for what agents can and cannot do autonomously, approval gates before destructive actions, and clear audit trails of every agent action."

- **Source:** RedMonk, [10 Things Developers Want from their Agentic IDEs in 2025](https://redmonk.com/kholterhoff/2025/12/22/10-things-developers-want-from-their-agentic-ides-in-2025/) (Dec 2025)
- **Type:** `[wish]`
- **Theme:** Trust and Transparency

---

**Quote 5.11**

> "A security-conscious developer working on sensitive projects — VPN infrastructure, access control systems, authentication mechanisms, financial systems, healthcare applications, government contracts — faces an impossible choice. Zero Data Retention doesn't solve this. Even with ZDR, code still travels to external servers for processing. The attack surface exists the moment data leaves the developer's machine."

- **Source:** GitHub, user `mscottgithub`, [claude-code issue #7178 — Support for Self-Hosted LLMs](https://github.com/anthropics/claude-code/issues/7178) (Oct 27, 2025)
- **Type:** `[frustration]`
- **Theme:** Trust and Transparency / Self-Hosted Identity

---

## Theme 6: Self-Hosted / Open Source Identity

_Developers who prefer running their own tools over hosted services. The n8n/Dify/self-hosted movement applied to AI agents._

---

**Quote 6.1**

> "Claude Code is arguably the best code harness on the market: it's fast, intuitive, multi-modal, and deeply contextual. But its use is locked to Anthropic models. There's a major market gap here. No one has built a best-in-class harness that is: IDE-like in productivity, model-agnostic, capable of supporting agentic workflows, prompt engineering, memory, etc."

- **Source:** GitHub, user `SynurDevelopers`, [claude-code issue #7178 — Support for Self-Hosted LLMs](https://github.com/anthropics/claude-code/issues/7178) (Sept 4, 2025) — _(Issue was closed as NOT_PLANNED by Anthropic)_
- **Type:** `[frustration]`
- **Theme:** Self-Hosted / Open Source Identity

---

**Quote 6.2**

> "I don't wanna be too dependent on one company & tool (Anthropic), and I want to have a less costly solution for my heavy use."

- **Source:** Peter Steinberger (psichix), [Self-Hosting AI Models After Claude's Usage Limits](https://steipete.me/posts/2025/self-hosting-ai-models) (2025) — developer who spent ~$6,000/mo on Claude and sought self-hosted alternatives
- **Type:** `[frustration]`
- **Theme:** Self-Hosted / Open Source Identity

---

**Quote 6.3**

> "Enterprises must define who is authorized to run autonomous agents, what audit trails must exist, and which code classes are prohibited from external processing."

- **Source:** Security/enterprise analysis, various sources via [Forrester blog on Claude Code Security](https://www.forrester.com/blogs/claude-code-security-causes-a-saas-pocalypse-in-cybersecurity/) (2025)
- **Type:** `[wish]`
- **Theme:** Self-Hosted / Open Source Identity / Trust

---

**Quote 6.4**

> "Privacy is the most consistently cited reason [for self-hosting]. Members who work with sensitive documents describe the peace of mind from knowing their prompts never leave their machine."

- **Source:** r/LocalLLaMA community summary, [aitooldiscovery.com — Local LLM Reddit (2026)](https://www.aitooldiscovery.com/guides/local-llm-reddit)
- **Type:** `[frustration]` — paraphrase of community sentiment
- **Theme:** Self-Hosted / Open Source Identity

---

**Quote 6.5**

> "Managed services like E2B offer convenience but come with variable costs, vendor lock-in, and limited customization. Sensitive data flows through someone else's infrastructure, which makes compliance teams nervous."

- **Source:** Self-hosted AI agent platform analysis, [fast.io — 8 Best Self-Hosted AI Agent Platforms for 2025](https://fast.io/resources/best-self-hosted-ai-agent-platforms/)
- **Type:** `[frustration]`
- **Theme:** Self-Hosted / Open Source Identity

---

**Quote 6.6**

> "I love claude code but I want to play around inside closed source and the litellm wrapper did the trick. However, things will break that way. Some commands like /init specify explicit models, which won't be available and some commands expect certain output formats, which will break the output parsing."

- **Source:** GitHub, user `Seikilos`, [claude-code issue #7178 — Support for Self-Hosted LLMs](https://github.com/anthropics/claude-code/issues/7178) (Oct 20, 2025)
- **Type:** `[workaround]` — hackily self-hosting but hitting breakage
- **Theme:** Self-Hosted / Open Source Identity

---

**Quote 6.7**

> "Developers, researchers, and enterprises are eager to adopt Claude Code if it just lets them bring their own engine."

- **Source:** GitHub, user `SynurDevelopers`, [claude-code issue #7178](https://github.com/anthropics/claude-code/issues/7178) (Sept 2025)
- **Type:** `[wish]`
- **Theme:** Self-Hosted / Open Source Identity

---

## Cross-Theme Synthesis

### What Developers Are Actually Building as Workarounds

The community response to these gaps is telling. In 2025-2026, dozens of third-party tools appeared to address exactly the problems listed above — each one a data point:

| Tool / Approach                        | Pain It Addresses                     |
| -------------------------------------- | ------------------------------------- |
| claude-code-scheduler (jshchnz)        | Background / Scheduled Execution      |
| RAgent (Docker wrapper + web terminal) | Terminal Isolation                    |
| Claude Code Telegram bot (RichardAtCT) | Agent Communication (notifications)   |
| Agent Reachout                         | Agent Communication (Telegram alerts) |
| Claude Code Remote (JessyTsui)         | Terminal Isolation                    |
| runCLAUDErun                           | Background / Scheduled Execution      |
| C9watch (menu bar monitor)             | Terminal Isolation (multi-session)    |
| Sustn (overnight token use)            | Background / Scheduled Execution      |
| MemCP / SQLite memory servers          | Session Memory / Context Loss         |
| Tailscale + tmux + Termius stack       | Terminal Isolation                    |
| TDD-Guard                              | Trust and Transparency                |

### Community Demand in Numbers

- GitHub issue #14227 (persistent memory): 70+ comments, filed Dec 2025
- GitHub issue #6454 (notifications when done): 5 duplicate issues filed independently
- GitHub issue #7178 (self-hosted LLM support): CLOSED as NOT_PLANNED despite significant developer demand
- r/LocalLLaMA: 266,500+ members, privacy-first ethos dominant
- RedMonk Dec 2025 report: background execution and multi-agent coordination in top 10 developer asks

---

## Notable Patterns

**The Mac Sleep Problem is Real and Documented**
Both third-party blogs and Anthropic's own Cowork docs acknowledge that Claude stops working when the machine sleeps. Developers are using `caffeinate`, third-party apps, and workarounds to keep their machines awake just so an agent can keep running. This is a solved-at-the-infrastructure-layer problem.

**Approval Fatigue is the Trust Paradox**
The permission system exists to build trust, but because developers get hundreds of approval prompts during a long task, they eventually rubber-stamp everything — which defeats the purpose. What developers actually want is _meaningful_ approval checkpoints, not a flood of them.

**Context Loss Compounds Over Time**
The frustration is not just losing context once. It's the compounding cost: every session re-explains the same things, every agent restart throws away accumulated understanding. Developers who use Claude Code daily describe this as one of their highest cognitive costs.

**Self-Hosting Is About Sovereignty, Not Just Cost**
The self-hosted preference comes from three distinct places: (1) privacy/compliance requirements that prohibit code leaving the machine, (2) vendor dependency anxiety, and (3) cost at scale. DorkOS running locally speaks to all three simultaneously.

---

## Source Index

- [Show HN: Claude Code Scheduler](https://news.ycombinator.com/item?id=46624100)
- [Show HN: RAgent – Claude Code on a VPS So Remote Control Never Drops](https://news.ycombinator.com/item?id=47148654)
- [Show HN: C9watch – macOS menu bar app to monitor all Claude Code sessions](https://news.ycombinator.com/item?id=47180850)
- [HN: Claude Code overnight usage discussion](https://news.ycombinator.com/item?id=44718795)
- [HN: Claude Code instances running in the background](https://news.ycombinator.com/item?id=44296358)
- [HN: Show HN: Stop Claude Code from forgetting everything](https://news.ycombinator.com/item?id=46426624)
- [HN: Has anyone run with dangerously-skip-permissions catastrophically?](https://news.ycombinator.com/item?id=44865926)
- [HN: Running Claude Code dangerously (safely)](https://news.ycombinator.com/item?id=46690907)
- [HN: Let your Claude Code message you on Telegram when it needs decisions](https://news.ycombinator.com/item?id=46563672)
- [HN: 20+ Claude Code agents coordinating on real work](https://news.ycombinator.com/item?id=46990733)
- [GitHub: claude-code issue #14227 — Persistent Memory Between Sessions](https://github.com/anthropics/claude-code/issues/14227)
- [GitHub: claude-code issue #2545 — Severe Session Memory Loss](https://github.com/anthropics/claude-code/issues/2545)
- [GitHub: claude-code issue #6454 — Notification when prompt finishes](https://github.com/anthropics/claude-code/issues/6454)
- [GitHub: claude-code issue #7178 — Support for Self-Hosted LLMs](https://github.com/anthropics/claude-code/issues/7178)
- [GitHub: claude-code issue #9905 — Background Agent Execution](https://github.com/anthropics/claude-code/issues/9905)
- [GitHub: claude-code issue #28420 — Remote Control from Phone](https://github.com/anthropics/claude-code/issues/28420)
- [DEV Community: Stop wasting hours on Claude Code Pro's session cooldown](https://dev.to/sleeyax/stop-wasting-hours-on-claude-code-pros-session-cooldown-4mak)
- [DEV Community: Embedding Memory into Claude Code](https://dev.to/shimo4228/embedding-memory-into-claude-code-from-session-loss-to-persistent-context-54d8)
- [DEV Community: I tried 3 different ways to fix Claude Code's memory problem](https://dev.to/gonewx/i-tried-3-different-ways-to-fix-claude-codes-memory-problem-heres-what-actually-worked-30fk)
- [Sanity.io: First attempt will be 95% garbage (staff engineer 6-week journey)](https://www.sanity.io/blog/first-attempt-will-be-95-garbage)
- [Simon Willison: Claude Code Remote Control](https://simonwillison.net/2026/Feb/25/claude-code-remote-control/)
- [tngranados.com: Keep your Mac awake when using Claude Code](https://tngranados.com/blog/preventing-mac-sleep-claude-code/)
- [mfyz.com: Claude Code on Loop — The Ultimate YOLO Mode](https://mfyz.com/claude-code-on-loop-autonomous-ai-coding/)
- [builder.io: How I use Claude Code](https://www.builder.io/blog/claude-code)
- [RedMonk: 10 Things Developers Want from their Agentic IDEs in 2025](https://redmonk.com/kholterhoff/2025/12/22/10-things-developers-want-from-their-agentic-ides-in-2025/)
- [Peter Steinberger: Self-Hosting AI Models After Claude's Usage Limits](https://steipete.me/posts/2025/self-hosting-ai-models)
- [sankalp.bearblog.dev: My Experience With Claude Code After 2 Weeks](https://sankalp.bearblog.dev/my-claude-code-experience-after-2-weeks-of-usage/)
- [GitHub: claude-code-telegram (RichardAtCT)](https://github.com/RichardAtCT/claude-code-telegram)
- [GitHub: Claude-Code-Remote (JessyTsui)](https://github.com/JessyTsui/Claude-Code-Remote)
- [Anthropic Cowork docs: Get started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-cowork)
- [fast.io: 8 Best Self-Hosted AI Agent Platforms for 2025](https://fast.io/resources/best-self-hosted-ai-agent-platforms/)
