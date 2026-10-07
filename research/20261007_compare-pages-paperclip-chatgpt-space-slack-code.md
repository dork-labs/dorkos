---
title: 'Compare pages: verified facts for Paperclip, ChatGPT Space (with dots) and Slack Code'
date: 2026-10-07
type: competitive
status: active
tags: [competitive, compare-page, paperclip, chatgpt-space, dots, slack-code, vision-202610]
---

# Compare pages: Paperclip, ChatGPT Space and Slack Code

Asked for by Dorian on 2026-10-07: build `/compare` pages for these three, researched first. `research/20261006_competitive-analysis-2026-10-vision.md` verified only about 7 of the 13 rows each page scores, so every row was checked again on the live web on 2026-10-07, one research pass per product, primary sources first (product docs, help centres, GitHub, pricing pages), press only where those were silent. The page data lives in `apps/site/src/layers/features/marketing/lib/comparisons.ts`; every `yes` or `partial` cell there cites one of the URLs below.

## Corrections to the 2026-10-06 note

- **Slack Code:** OpenAI (ChatGPT/Codex) is **not** a supported Slack Code agent today. Slack's launch blog said "available soon"; neither current list includes it. The Salesforce press release is dated Aug 24, not Aug 25.
- **ChatGPT Space:** OpenAI writes the agents as lowercase "dots". Rollout is "gradual" from Sep 29, not a fixed Oct 1. Dots need Pro ($100, $200 or $500 tiers) or Business Premium; Enterprise gets a beta an admin must switch on; Pro dots are not offered in the EEA, UK or Switzerland at launch. "Own credentials to company systems" describes the specialist-dots pilot, not the general product.
- **Paperclip:** no doc says "append-only"; say "audit log". The four goal tiers are unverified in wording. Runtime list also includes Pi, Grok and Kimi Code. The official hosted version is a waitlist; paperclip.inc was an unrelated third-party host that shut down on 2026-10-02. CVE-2026-41679 was published 2026-04-10 and fixed in 2026.416.0 (the earlier note's "August" refers to the press write-ups).

## Choices made on the pages

- **Framing:** Paperclip and ChatGPT Space are `competitor` (same job for the same founder). Slack Code is `adjacent`, scoped to people and agents in one channel, matching how Buzz is framed.
- **Left off the pages on purpose:** Paperclip's fixed CVE (a closed bug is not a current fact, and leading with it reads as a dig), Paperclip's default-on anonymous telemetry (not what any row asks), and every unverified number (extra-dot pricing, Slack Code limits).
- **Conceded on the record:** Paperclip's budgets beat our reply caps; dots keep working with the laptop shut; Slack Code's multiplayer review and app reach.

## Not verifiable on 2026-10-07

- openai.com and help.openai.com refused direct fetches; those claims rest on search-engine excerpts, cross-checked with learn.chatgpt.com (read in full) and press.
- Extra-dot pricing; per-dot spend caps; answering a dot's approval from the phone app; dot-to-dot handoff.
- Where Devin, Copilot and Vercel's agents run inside Slack Code (only Anthropic documents it); Slack Code's own limits; when Factory joined.
- Paperclip's Goals page wording, and `paperclip_runner` billing.

---

## Paperclip: verified facts for the compare page

All sources retrieved 2026-10-07. Primary sources (GitHub API, README, docs.paperclip.ing) are preferred over press.

### Basics

| Item             | Finding                                                                                                                                                                       | Source                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Maker            | Paperclip Labs; created by the pseudonymous developer "dotta" (CEO). GitHub owner is the `paperclipai` organization.                                                          | [ai.engineer talk](https://ai.engineer/talks/h403btjldDQ-paperclip-open-source-human-control-plane-ai), [GitHub API](https://api.github.com/repos/paperclipai/paperclip) |
| Homepage         | https://paperclip.ing (docs at https://docs.paperclip.ing)                                                                                                                    | [GitHub API](https://api.github.com/repos/paperclipai/paperclip)                                                                                                         |
| Repo             | https://github.com/paperclipai/paperclip                                                                                                                                      | same                                                                                                                                                                     |
| Repo description | "The open-source app everyone uses to manage agents at work"                                                                                                                  | same                                                                                                                                                                     |
| Homepage tagline | "The app people use to manage AI agents for work"                                                                                                                             | [paperclip.ing](https://paperclip.ing)                                                                                                                                   |
| Category         | A control panel for running a company of AI agents: org chart, goals, tasks, budgets, approvals. README: "if OpenClaw is an employee, Paperclip is the company."              | [README](https://github.com/paperclipai/paperclip)                                                                                                                       |
| License          | MIT                                                                                                                                                                           | [GitHub API](https://api.github.com/repos/paperclipai/paperclip)                                                                                                         |
| Stars            | 98,176 stars, 16,593 forks (GitHub API, 2026-10-07). Our 2026-10-06 note said 98k: confirmed.                                                                                 | same                                                                                                                                                                     |
| Launched         | Repo created 2026-03-02; press says public launch 2026-03-04. "March 2026" is correct either way.                                                                             | [GitHub API](https://api.github.com/repos/paperclipai/paperclip)                                                                                                         |
| Latest release   | v2026.1005.0, published 2026-10-06 (agent files kept across tasks, Browser Use Cloud live view, two-way Slack sync, Agent Chat sidebar). Previous: v2026.1001.0 (2026-10-02). | [Releases API](https://api.github.com/repos/paperclipai/paperclip/releases)                                                                                              |
| Install          | `npx paperclipai onboard --yes`, Node 24+, embedded PostgreSQL, server on localhost:3100, data in `~/.paperclip/`.                                                            | [Installation docs](https://docs.paperclip.ing/guides/getting-started/installation/)                                                                                     |

### The 13 rows

### 1. multi-runtime: **yes**

Paperclip runs many agent brains side by side under one org chart: Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Pi, Grok, Hermes, Kimi Code (added in v2026.831.0), plus OpenClaw gateway, HTTP webhook bots and plain shell processes.
Source: [Agent Adapters guide](https://docs.paperclip.ing/guides/org/agent-adapters/), [Adapters reference](https://docs.paperclip.ing/reference/adapters/overview/), [README](https://github.com/paperclipai/paperclip). README: "If it can receive a heartbeat, it's hired."
Note: our note's list (Claude, Codex, Gemini, Cursor, Hermes, OpenClaw, OpenCode) is correct but incomplete.

### 2. your-own-subscriptions: **yes**

It uses your own sign-in or key and does not resell model use: the Claude Code adapter accepts "`ANTHROPIC_API_KEY`, Bedrock settings, or Claude subscription login", and the Costs page has a "Billers" tab that tracks subscription plan windows (e.g. Anthropic Pro's 5-hour window) separately from pay-as-you-go API.
Source: [Claude Code adapter](https://docs.paperclip.ing/reference/adapters/claude-code/), [Costs & Budgets](https://docs.paperclip.ing/guides/day-to-day/costs/).
Caveat: the Installation page still tells new users to get an Anthropic or OpenAI API key, so the docs lean toward keys. Found no resold credits. An experimental `paperclip_runner` adapter exists ([adapters overview](https://docs.paperclip.ing/reference/adapters/overview/)); its billing model is not documented in what we read.

### 3. scheduling: **yes**

Routines fire on a cron schedule in your time zone (or a signed webhook) and run whether or not you are there: "Paperclip creates a task, assigns it to the agent, and that assignment wakes that agent immediately."
Source: [Heartbeats & Routines](https://docs.paperclip.ing/guides/projects-workflow/routines/).

### 4. self-scheduling-trust: **partial**

An agent can create and edit routines, but only ones assigned to itself ("Agents can only manage routines assigned to themselves"); no doc says a person must approve a new routine first.
Source: [paperclip SKILL.md](https://github.com/paperclipai/paperclip/blob/master/skills/paperclip/SKILL.md), [Heartbeats & Routines](https://docs.paperclip.ing/guides/projects-workflow/routines/).
Found nothing on an approval step for agent-made routines (searched the Routines, Approvals and agent-developer Approvals pages). Agents can file a generic `request_board_approval`, so an agent could ask first, but the system does not require it. The fixed approval gates are hiring, the CEO's strategy, and budget overrides ([Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/)).

### 5. coordination: **yes**

Agents sit in an org chart with reporting lines, delegate tasks to each other (a manager agent can hire subordinates after approval) and pass work through tickets with blocker dependencies.
Source: [README](https://github.com/paperclipai/paperclip), [Approvals for agent developers](https://docs.paperclip.ing/guides/agent-developer/handling-approvals). It is task handoff through a ticket board, not a shared chat room.

### 6. spend-guardrails: **yes** (Paperclip is stronger here)

Monthly company and per-agent budgets plus lifetime project budgets; a warning at 80%, and at 100% "The agent is automatically paused. No further heartbeats are triggered." Restarting past a hard stop needs a board budget-override approval.
Source: [Costs & Budgets](https://docs.paperclip.ing/guides/day-to-day/costs/), [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/).
Our note's "pause at 100%" is confirmed.

### 7. local-first: **yes**

It runs as one Node process with an embedded Postgres on your own computer; data lives in `~/.paperclip/`. Production options add external Postgres, Docker, Tailscale-only binding, or a VPS/Fly.io deploy.
Source: [Installation](https://docs.paperclip.ing/guides/getting-started/installation/), [Deploy reference](https://docs.paperclip.ing/reference/deploy/overview/).
Caveat: anonymous usage telemetry is on by default and can be turned off by env var or config ([README](https://github.com/paperclipai/paperclip)).

### 8. open-and-yours: **yes**

MIT source on GitHub, self-hosted, and "No Paperclip account required."
Source: [README](https://github.com/paperclipai/paperclip), [paperclip.ing/product/open-source](https://paperclip.ing/product/open-source/).

### 9. surfaces: **partial**

A responsive web UI that works in a phone browser; no native mobile app, no installable app with push, and no desktop app ("Desktop App" is listed as planned on the roadmap).
Source: [README roadmap](https://github.com/paperclipai/paperclip), [issue #14736, open, 2026-09-30](https://github.com/paperclipai/paperclip/issues/14736): the web UI "lacks push notifications, background operation, and offline queuing". Web Push request: [issue #597](https://github.com/paperclipai/paperclip/issues/597). Reaching it from a phone away from home means your own network setup (Tailscale/VPS); found no built-in tunnel.

### 10. approvals-anywhere: **partial**

You can approve from a phone browser if you can reach your server, but the docs list approvals only in the web app (Approvals page, dashboard card, Inbox item) and say nothing about approving from Slack, Telegram or email.
Source: [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/), [Review Requests](https://docs.paperclip.ing/connectors/review-requests/) (answered under "Connectors > Review"), [Slack connector](https://docs.paperclip.ing/connectors/slack/).
Searched: Approvals, Review Requests, Slack connector and Agent Chat pages. Slack, Discord, Teams and Telegram chat connectors exist but are experimental ("Slack is available, but it is not yet fully functional"). A community plugin posts Slack notifications "when issues ... need approval" ([mvanhorn/paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack)), notification only as far as its description says.

### 11. attention-management: **yes**

There is an Inbox with an "attention feed", a Blocked tab for stopped work, and a separate Approvals queue and Decisions page; approvals also show up as Inbox items.
Source: [Blocked Inbox](https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/), [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/).
Nuance: it is one Inbox with several tabs plus dedicated pages, not a single flat list, and there are no push notifications.

### 12. extensibility: **yes** (Paperclip is stronger on sharing whole teams)

Plugins (out-of-process workers that can add pages, widgets, jobs, tools and webhooks), a Skill Studio with versioned company-wide skills, MCP servers, and full company export/import as markdown packages (secrets scrubbed) from a folder, zip or GitHub repo; "Ready-Made Teams" can be previewed and installed.
Source: [Plugin SDK](https://docs.paperclip.ing/reference/plugins/sdk/), [Export & Import](https://docs.paperclip.ing/guides/power/export-import/), [README](https://github.com/paperclipai/paperclip).
Found no official plugin marketplace or registry; sharing is through GitHub repos and the community list "awesome-paperclip".

### 13. pricing: **free, MIT; hosted version waitlist only**

The software is free and MIT. The official hosted "Paperclip Cloud" is a waitlist with no published price ("Paperclip is rolling out gradually").
Source: [paperclip.ing/waitlist](https://paperclip.ing/waitlist/), [README](https://github.com/paperclipai/paperclip) ("Sign up for the Paperclip Cloud waitlist"; Cloud deployments marked in progress).
Watch out for look-alikes, which are NOT the official product:

- paperclip.inc, run by "Paperclip.inc OÜ" (Estonia), "Built on paperclipai/paperclip", was EUR 10/month, and states "Paperclip.inc is shutting down on 2 October 2026 and no longer accepts new accounts." ([paperclip.inc/pricing](https://paperclip.inc/pricing)). Some search summaries wrongly call it the official cloud.
- paperclipcloud.com: a third-party managed host, reported at $21 / $69 / $149 a month (search result, not fetched) ([paperclipcloud.com](https://paperclipcloud.com/)).
- The docs' older "Cloud Sync" feature (push a local company into Paperclip Cloud) is "retired upstream and replaced by full-fidelity company Import/Export" ([Cloud Sync](https://docs.paperclip.ing/experimental/cloud-sync/)).

### Other questions

- **Chat or channels for people and agents:** partial and experimental. Agent Chat is one-to-one only ("You get exactly one conversation with each agent"), off by default ([Agent Chat](https://docs.paperclip.ing/experimental/agent-chat/)). No group chats or channels inside Paperclip; Slack/Discord/Teams/Telegram connectors bring agents into those tools, experimental ([Slack connector](https://docs.paperclip.ing/connectors/slack/)). Mixed human and agent org charts exist, and multi-user login is shipped ([README](https://github.com/paperclipai/paperclip)).
- **Agents building apps or UI ("mini apps"):** found nothing. Plugins can add pages and widgets, but the SDK is written for human developers and says nothing about agents building them ([Plugin SDK](https://docs.paperclip.ing/reference/plugins/sdk/)).
- **Aimed at founders:** yes. The site frames it around running "autonomous businesses", hiring a CEO agent that drafts strategy, and goal alignment back to a company mission ([paperclip.ing](https://paperclip.ing), [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/)). Founder origin: dotta ran his companies with 20 to 30 Claude Code windows ([ai.engineer](https://ai.engineer/orgs/paperclip)).
- **Tiered goals:** the homepage claims "Goal alignment tracing tasks back to company missions" and docs have a Goals page under Projects & Workflow. We did not open the Goals page, so the exact four tiers in our note (mission, project goal, agent goal, task) are UNVERIFIED in wording.
- **Audit log:** "Mutating actions, heartbeat state changes, cost events, approvals, comments, and work products are recorded as durable activity" ([README](https://github.com/paperclipai/paperclip)); homepage: "full tool-call tracing and audit log". Found no doc using the words "append-only"; say "audit log", not "append-only".
- **Agent email:** AgentMail addresses for agents arrived in v2026.916.0 ([Releases](https://api.github.com/repos/paperclipai/paperclip/releases)).

### Security (CVE-2026-41679)

- GitHub advisory GHSA-68qg-g8mg-6pr7 / CVE-2026-41679: "Unauthenticated remote code execution via import authorization bypass", CVSS 10.0, published 2026-04-10, vulnerable `<2026.416.0`, **patched 2026.416.0** ([GitHub advisories API](https://api.github.com/repos/paperclipai/paperclip/security-advisories)).
- The chain: open sign-up without email check, a new user could approve their own CLI login challenge (getting a board-level key), then import a company with a process adapter that runs shell commands. It affected instances in authenticated mode reachable over a network ([SecurityWeek](https://www.securityweek.com/critical-paperclip-flaw-allowed-admin-access-code-execution/), [GitLab advisory](https://advisories.gitlab.com/npm/paperclipai/CVE-2026-41679/)).
- Dispute: the GitLab advisory says fixed in 2026.410.0; the GitHub advisory (primary, from the maintainers) says 2026.416.0. Use 2026.416.0. Our note's "open sign-up self-approval, CVSS 10, fixed v2026.416.0" is confirmed.
- Same day (2026-04-16) six more advisories were published, including two CVSS 9.9 cross-tenant key flaws and a 9.8 command injection, all patched in 2026.416.0 ([advisories API](https://api.github.com/repos/paperclipai/paperclip/security-advisories)). One High (8.7) advisory on an inherited ChatGPT Gmail connector in `codex_local` lists patched version "TBD" in the API response; check before citing.
- Fairness: all known critical issues are fixed, and the default local mode is not the network-exposed configuration.

### Changes since August 2026

- v2026.831.0 (2026-09-02): company skill library reaches agents at runtime; Kimi Code adapter.
- v2026.916.0 (2026-09-16): runtime credentials move to "Connections"; experimental chat connectors for Slack, Discord, Telegram, Teams; AgentMail agent email; managed GitHub connections.
- v2026.1001.0 (2026-10-02): agent personas with an animated onboarding character; GitHub PR review bots; MCP aggregators (Arcade, Composio, Zapier); rebuilt Slack setup.
- v2026.1005.0 (2026-10-06): agent files kept across tasks; Browser Use Cloud live view; two-way Slack threads; Agent Chat sidebar; memory connectors (Cognee, Honcho, Supermemory, Zep).
- Third-party host paperclip.inc shut down 2026-10-02.
  Sources: [Releases API](https://api.github.com/repos/paperclipai/paperclip/releases), [docs changelog](https://docs.paperclip.ing/reference/changelog/).

### Genuine strengths (where Paperclip is better)

1. **Business layer that ships today:** org chart, goals, projects, tickets with blocker dependencies, CEO strategy approval and hiring approvals, all open source.
2. **Spend control:** company, agent and project budgets with an 80% warning and an automatic pause at 100%, plus a Billers view that understands subscription windows. This is more complete than a reply cap.
3. **Breadth of brains and integrations:** about a dozen runtimes, 60+ connector pages, MCP aggregators, agent email, memory connectors, and a fast weekly release pace.
4. **Portable companies:** export and import a whole team (agents, skills, routines, projects) as a markdown package from GitHub, with secrets stripped; ready-made teams. Plus distribution: 98k stars.

### Where Paperclip is weaker (for balance)

No native mobile or desktop app and no push notifications; approvals live only in the web app; chat with agents is one-to-one and experimental; no official hosted version yet; a CVSS 10 history.

### Research gaps

- Did not open the Goals, Delegation or Team Catalog pages; tier wording is unverified.
- `paperclip_runner` billing (could involve hosted compute) is undocumented in what we read.
- paperclipcloud.com prices come from a search summary only.

---

## ChatGPT Space (with dots): fact check for the DorkOS comparison page

Retrieved: 2026-10-07. Sources are inline. openai.com and help.openai.com returned HTTP 403 to direct fetches, so help-center claims below come from search-result excerpts of those pages; claims marked "(read in full)" come from learn.chatgpt.com docs pages that were fetched and read directly.

### Corrections to the 2026-10-06 note

- **Naming.** OpenAI writes the agent as lowercase "dots" / "your dot" ("Introducing dots", "Meet dots", "Get started with your dot"). Press capitalizes it as "Dots". The workspace is "ChatGPT Space" or just "Space". Pages are "Pages". Use "dots" in our copy to match OpenAI.
- **Plans.** dots: Pro (three tiers, Pro 100, Pro 200, Pro 500) and Business Premium seats; Enterprise as a beta that is off by default until an admin enables it. Space: Pro, Business and Enterprise. Our note was right about Pro and Business Premium. It left out the Pro tiers and the region limits (below).
- **Regions.** On Pro, dots are not available in the EEA, Switzerland or the UK at launch. Users must be 18+.
- **Date.** Announced at DevDay on 2026-09-29 and "rolling out gradually" from that day (not a fixed Oct 1 date). The help center's Business release note about plugin admin controls is dated Oct 1.
- **"Credentials to company systems"** is about **specialist dots**, which are a pilot, not the general product. The general product has a private sign-in flow with saved logins.
- **Model.** dots run on GPT-6 Astra.

### Product basics

- **Names:** ChatGPT Space (Space), dots (your dot), Pages, Scheduled (tasks), Activity, Custom rules, Plugins.
- **Homepages:** [Introducing dots](https://openai.com/index/introducing-dots/), [Meet dots (docs)](https://learn.chatgpt.com/docs/dots), [ChatGPT Space (docs)](https://learn.chatgpt.com/docs/space), [ChatGPT Work](https://openai.com/chatgpt-work/).
- **Category:** a shared work area inside ChatGPT where people, ChatGPT, Codex and always-on agents ("dots") work on the same pages and files.
- **What Space is:** "Space brings your Pages, files, and related work together in ChatGPT... create a space for a project, add the material you need, and share it with other people" ([openai.com search excerpt](https://openai.com/index/chatgpt-for-your-most-ambitious-work/)). Space replaces Library for accounts with access and is available to eligible Pro, Business and Enterprise users in the desktop app and on the web ([Getting started with Space](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt), excerpt). In Pages you mention `@ChatGPT` or `@dot` inline, in comments or in a side chat ([Work with agents in Space](https://learn.chatgpt.com/codex/space/agents), read in full).
- **What a dot is:** "Powered by GPT-6 Astra, they have their own cloud computer, learn from feedback over time, and can work towards your goals 24/7. Through the ecosystem of plugins, they can readily connect to over 4,000 apps" ([Introducing dots](https://openai.com/index/introducing-dots/), excerpt).
- **Can agents build apps or UI inside it?** Yes, in part. Pages support spreadsheets, presentations, sites, images and files ([Space docs](https://learn.chatgpt.com/docs/space), read in full). The `/` menu has **Visualize** for interactive visualizations ([Space agents](https://learn.chatgpt.com/codex/space/agents), read in full). ChatGPT Sites is in public beta (Pro, Pro Lite, Edu, then Plus; not Free or Go; publishing not in EEA/CH/UK at launch) ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes), excerpt), and a plugin can be hosted with Sites ([Hosting a plugin with ChatGPT Sites](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites)). "Plugin Extensions" add sidebar apps, panels and file viewers to the desktop app ([What's new, Sep 28 to Oct 2](https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026), read in full).
- **Founders / small business:** found nothing aimed at founders specifically. Searched OpenAI and help pages for founder and small-business wording. The pitch is teams and companies (Business, Enterprise); internal specialist-dot examples are procurement, invoices, email marketing, support and contracts ([VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)).
- **Plan and region limits:** dots on Pro 100/200/500 for users 18+ outside the EEA, UK and Switzerland; Business Premium and Enterprise worldwide; Enterprise off by default; you create your dot on desktop app or desktop browser, then can use mobile ([Meet dots](https://learn.chatgpt.com/docs/dots), read in full). Space: Pro, Business, Enterprise only, desktop app and web.

### The 13 rows

| #   | Row                    | Verdict                                | What it actually does                                                                                                                                                                                                                                                                                                                                                | Source                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | multi-runtime          | **no**                                 | Space and dots run on OpenAI models only (GPT-6 Astra for dots); the only coding agent inside is Codex. The separate open-source Codex CLI can point at local open models (Ollama, LM Studio via `--oss`), but that is not Space and is not another company's agent. Found no Claude Code, OpenCode or non-OpenAI model in Space or dots.                            | [Meet dots](https://learn.chatgpt.com/docs/dots); [openai/codex](https://github.com/openai/codex); [Codex advanced config](https://developers.openai.com/codex/config-advanced)                                                                                                                                                        |
| 2   | your-own-subscriptions | **partial**                            | It is the ChatGPT plan itself: your first dot is included in Pro or Business Premium, chatting with it does not count toward limits, but tasks it starts in Codex or ChatGPT Work do, and past the allowance you buy OpenAI credits. You cannot bring another company's plan. More dots, faster dots and more monthly work are "in the future", price not published. | [Introducing dots](https://openai.com/index/introducing-dots/); [Pricing docs](https://learn.chatgpt.com/docs/pricing)                                                                                                                                                                                                                 |
| 3   | scheduling             | **yes**                                | Scheduled tasks run in the background on web, desktop, mobile, Codex CLI, IDE extension and Codex Cloud; on web and mobile tasks can also fire on Gmail, Slack or GitHub events; Team Tasks run in the cloud on a team service account; a dot works 24/7 on its cloud computer while your computer is off.                                                           | [Scheduled tasks](https://learn.chatgpt.com/docs/automations); [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)                                                                                                                                                                                            |
| 4   | self-scheduling-trust  | **partial**                            | ChatGPT drafts the schedule from your description and you confirm it; a dot can "decide when to pause and wake up to continue work" and can list, change or cancel its scheduled tasks. Found no doc saying a dot sets up a new repeating job on its own behind an explicit approval step; Custom rules ("Ask before taking action") are the general approval tool.  | [Scheduled tasks](https://learn.chatgpt.com/docs/automations); [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory); [Meet dots](https://learn.chatgpt.com/docs/dots)                                                                                                                                              |
| 5   | coordination           | **partial**                            | One dot can "divide work among background agents that run in parallel and report back to it", and a dot can start Codex or ChatGPT Work tasks. Docs say nothing about two dots finding each other or handing work across; a community feature request asks for exactly that. Collaborators in a Page "may use different agents".                                     | [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory); [Feature request: multiple specialized dots](https://community.openai.com/t/multiple-specialized-dots-with-shared-context-and-clear-task-ownership/1402778); [Space agents](https://learn.chatgpt.com/codex/space/agents)                                    |
| 6   | spend-guardrails       | **yes** (Business) / **partial** (Pro) | Business owners and admins set monthly credit limits per seat type and per user (default: no limits); only owners buy credits or set auto-reload. Pro users buy credits themselves; found no per-dot spend cap. During launch, dots usage does not count against allowances.                                                                                         | [Credits and spend controls in Business](https://help.openai.com/en/articles/20001155-managing-credits-and-spend-controls-in-chatgpt-business) (excerpt); [Pricing docs](https://learn.chatgpt.com/docs/pricing)                                                                                                                       |
| 7   | local-first            | **partial** (lean no)                  | A dot "lives in the cloud and has its own computer and browser". You can connect one personal computer at a time (ChatGPT app open and online) so it can reach local files, code and apps and run Codex locally, but the agent and its memory live in OpenAI's cloud. Codex CLI itself runs locally.                                                                 | [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps); [Meet dots](https://learn.chatgpt.com/docs/dots)                                                                                                                                                                                                         |
| 8   | open-and-yours         | **no**                                 | ChatGPT, Space and dots are closed, hosted by OpenAI, and need an account on a paid plan. Only Codex CLI is open source (Apache-2.0).                                                                                                                                                                                                                                | [openai/codex](https://github.com/openai/codex); [Meet dots](https://learn.chatgpt.com/docs/dots)                                                                                                                                                                                                                                      |
| 9   | surfaces               | **yes**                                | Message or call your dot in ChatGPT on desktop app, web and mobile (create it on desktop first), plus Slack and Microsoft Teams; texting is "coming soon". Activity (watching background work) is described in the desktop app. Space itself is desktop app and web.                                                                                                 | [Message your dot](https://learn.chatgpt.com/docs/dots/channels); [Control your dot](https://learn.chatgpt.com/docs/dots/controls); [Space help](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt)                                                                                                   |
| 10  | approvals-anywhere     | **partial**                            | In Slack and Teams, ChatGPT "can show a private approval card with Allow and Deny controls"; you can tell your dot to bring decisions to you in Slack; mobile push exists for tasks. The dot docs say you open and answer waiting requests from Activity in the desktop app; found no doc confirming a dot's approval can be answered from the phone app.            | [Using @ChatGPT in Slack and Teams](https://help.openai.com/en/articles/20001537-using-chatgpt-in-slack-and-microsoft-teams) (excerpt); [Message your dot](https://learn.chatgpt.com/docs/dots/channels); [Control your dot](https://learn.chatgpt.com/docs/dots/controls)                                                             |
| 11  | attention-management   | **partial**                            | Two places, not one: **Scheduled** "acts as your inbox" for task runs with an unread marker, and a dot's **Activity** lists work waiting for a decision, sign-in, app connection or approval. Found no single list across everything.                                                                                                                                | [Scheduled tasks](https://learn.chatgpt.com/docs/automations.md?surface=app) (excerpt); [Control your dot](https://learn.chatgpt.com/docs/dots/controls)                                                                                                                                                                               |
| 12  | extensibility          | **yes**                                | Plugins bundle skills, apps and MCP servers; dots use any supported plugin you have enabled; Business and Enterprise users share plugins with people, groups or the whole workspace; admins import plugin marketplaces from public or private GitHub repos (daily sync). Custom GPT workflows are being moved to plugins.                                            | [Plugins in ChatGPT](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt); [Business release notes](https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes); [Build plugins](https://learn.chatgpt.com/docs/build-plugins); [Migrate custom GPTs](https://learn.chatgpt.com/docs/migrate-custom-gpts) |
| 13  | pricing                | **paid only, closed**                  | Space and a dot need Pro ($100, $200 or $500 a month) or a Business Premium seat ($125 per user monthly, $100 billed annually); Enterprise is custom. Standard Business is $25 monthly / $20 annual per user and gets Space but not a dot. Extra dots: price not yet published. Not open source.                                                                     | [Pricing docs](https://learn.chatgpt.com/docs/pricing); [Premium seats in Business](https://openai.com/index/premium-seats-chatgpt-business/) (excerpt); [Billing and seats](https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business)                                                               |

### Row notes

- **Row 2:** "During the initial launch period, dots usage won't count toward eligible Pro, Business, and Enterprise users' plan allowances" and the plan includes "extended limits for the first month after launch" (search excerpts of [Introducing dots](https://openai.com/index/introducing-dots/) and [Meet dots](https://learn.chatgpt.com/docs/dots)). Treat that as temporary.
- **Row 6:** VentureBeat reports OpenAI has not published numeric limits for heavy work, extra dots, specialist dots or higher speed ([VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)).
- **Row 10:** Custom rules have four settings: "Take action without asking", "Take action when you say so", "Ask before taking action", "Hand off to you" (desktop wording, [Control your dot](https://learn.chatgpt.com/docs/dots/controls)); the mobile wording in the help center is "Take action if pre-approved" ([Manage dots in workspaces](https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces), excerpt). An automatic review checks consequential actions against your instructions, permissions, rules and safety rules first.
- **Row 13:** Business Premium price is from search excerpts of openai.com and help.openai.com (direct fetch was blocked). The Pro tier names (Pro 100/200/500) come from [Meet dots](https://learn.chatgpt.com/docs/dots); the $100 to $500 range from [Pricing docs](https://learn.chatgpt.com/docs/pricing).

### Where ChatGPT Space is genuinely better (say this on the page)

1. **Always on, no computer needed.** Each dot has its own cloud computer and browser and keeps working when your laptop is off. DorkOS needs your computer awake.
2. **Sign up and go.** No install. It sits inside a product hundreds of millions already use, with a phone app, web, desktop, voice calls, Slack and Teams on day one.
3. **Polished shared documents.** Pages with live co-editing, comments, `@ChatGPT`/`@dot` mentions, interactive visuals, sites, spreadsheets and slides, plus file permissions that carry over.
4. **Mature admin and app reach.** 4,000+ apps through plugins, workspace plugin marketplaces from GitHub, per-seat and per-user credit limits, custom rules with an automatic safety review, and event triggers from Gmail, Slack and GitHub.

### Where DorkOS differs (for context, verify against our own demo-claim gate)

Any brain (OpenAI only there), your own files on your own computer (cloud-first there), open source with no account needed for a local install (closed and paid there), and works through plans you already pay for.

### Contradictions and gaps

- **Enterprise:** help center says Enterprise is a beta, off by default; learn docs list Enterprise "worldwide". Both agree an admin must turn it on.
- **Rollout date:** our note said "from Oct 1"; OpenAI says rolling out gradually from the Sep 29 announcement.
- **"Dots in Space":** OpenAI frames Space as for people, ChatGPT, Codex and dots, but the Space docs only show `@dot` mentions in Pages; "team chats" as a feature name was not found in primary docs (Slack and Teams channels are where the team chat happens).
- **Not found:** founder-specific positioning; per-dot spend caps; a confirmed way to approve a dot's request from the phone app; dot-to-dot handoff; extra-dot pricing.
- **Access:** openai.com and help.openai.com blocked direct fetching (403); those claims rest on search-engine excerpts of the pages, cross-checked against learn.chatgpt.com and press where possible.

### Sources

- [Introducing dots (openai.com)](https://openai.com/index/introducing-dots/)
- [Meet dots](https://learn.chatgpt.com/docs/dots)
- [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
- [Control your dot](https://learn.chatgpt.com/docs/dots/controls)
- [Connect computers and apps to your dot](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [Message your dot](https://learn.chatgpt.com/docs/dots/channels)
- [ChatGPT Space docs](https://learn.chatgpt.com/docs/space)
- [Work with agents in Space](https://learn.chatgpt.com/codex/space/agents)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Pricing docs](https://learn.chatgpt.com/docs/pricing)
- [What's new, Sep 28 to Oct 2, 2026](https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026)
- [Getting started with Space (help)](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt)
- [Manage dots in ChatGPT workspaces (help)](https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces)
- [Using @ChatGPT in Slack and Teams (help)](https://help.openai.com/en/articles/20001537-using-chatgpt-in-slack-and-microsoft-teams)
- [Credits and spend controls in Business (help)](https://help.openai.com/en/articles/20001155-managing-credits-and-spend-controls-in-chatgpt-business)
- [Plugins in ChatGPT (help)](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt)
- [ChatGPT Business release notes](https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes)
- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Premium seats in ChatGPT Business](https://openai.com/index/premium-seats-chatgpt-business/)
- [openai/codex on GitHub](https://github.com/openai/codex)
- [VentureBeat launch coverage](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)
- [CNBC DevDay recap](https://www.cnbc.com/2026/09/29/openai-devday-2026-live-updates.html)
- [OpenAI community: multiple specialized dots request](https://community.openai.com/t/multiple-specialized-dots-with-shared-context-and-clear-task-ownership/1402778)

---

## Slack Code: fact check for the DorkOS vs Slack Code comparison page

Retrieved 2026-10-07. Primary sources first; press only where Slack's own pages are silent.

### Identity

- **Exact name:** "Slack Code". The working space it creates is a "code channel" (lowercase in help docs; the Salesforce press release says "code channels"). Tagline on the feature page: "Where Building is a Team Sport."
- **Homepage:** https://slack.com/features/code-channels
- **Help article:** https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code
- **Category in a few words:** shared team channels for outside coding agents, inside Slack.
- **Launch date:** Slack blog dated August 20, 2026 ("Slack Code is live today for teams using Claude (Anthropic), Devin (Cognition), GitHub (Copilot), and Vercel integrations, with OpenAI (ChatGPT) available soon.") https://slack.com/blog/news/slack-code-channels-for-agents . Salesforce press release dated August 24, 2026 (APAC newsroom URL; our note said Aug 25, which is wrong for this copy): https://www.salesforce.com/ap/news/press-releases/2026/08/24/salesforce-launches-slack-code-to-make-ai-software-development-multiplayer/
- **GA or beta:** not labelled beta, but the help article says it is "rolling out gradually" ("We appreciate your patience as we make it available to all customers"). Treat as launched, still rolling out.
- **Plans:** help article: "Available on all plans with a supported agent installed." Press release: "available today on all Slack plans." Salesforce product page: "Access to each partner agent is required." and "Pricing and packaging are subject to change." https://www.salesforce.com/slack/introducing-slack-code/

### Corrections to our 2026-10-06 note

1. **ChatGPT/Codex is NOT on Slack's current supported-agent list.** Launch blog said OpenAI was "available soon". The help article's list (12): Claude (Anthropic), CodeRabbit, DataDog, Devin (Cognition), Factory, GitHub Copilot, Lovable, Mistral Vibe, NanoClaw, Replit, Rhythms, Vercel. The feature page list (13) differs slightly: Cedar, Claude, CodeRabbit, Datadog, Devin, Factory, GitHub Copilot, Lovable, Mistral, NanoClaw, Rhythms, Snowflake, Vercel. Neither lists OpenAI. Say "Claude, Devin, GitHub Copilot, Vercel and others", not "ChatGPT/Codex". (OpenAI separately offers @ChatGPT/Codex in Slack through its own app: https://help.openai.com/en/articles/20001538-setting-up-and-managing-chatgpt-in-slack-and-microsoft-teams , which is not the same as a Slack Code code channel.)
2. **Factory joined later:** consistent with it being absent from the Aug 20 launch blog and present in today's lists. Exact join date not found.
3. **Press release date** is Aug 24 on the APAC newsroom copy.

### Where the agent actually runs

Slack's pages never say. The answer comes from the agent vendors. For Claude, Anthropic's docs: "When you mention @Claude with a coding task, Claude automatically detects the intent and creates a Claude Code cloud session... Each session runs under your own Claude account, using your connected repositories and your plan limits." Limitations: "GitHub only", "One PR at a time", "Cloud session access required." https://code.claude.com/docs/en/slack . Note: that page now documents the "earlier" Claude Code in Slack; Team/Enterprise orgs move to "Claude Tag", which runs @Claude as an org-shared identity, and the legacy bot was retired for connected workspaces "effective October 5, 2026". Devin, Copilot coding agent and Codex cloud are likewise vendor-hosted. **Fair wording: the agent runs in each vendor's cloud on a copy of your GitHub repo; Slack shows the conversation, plan, diffs and preview.**

### The 13 rows

| #   | Row                    | Verdict     | What it actually does                                                                                                                                                                                                                    | Source                                                                                                                    |
| --- | ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | multi-runtime          | **yes**     | Any of about a dozen partner agents (Claude, Devin, GitHub Copilot, Vercel, Factory, Replit and more) can be @mentioned from the same Slack, each opening its own code channel.                                                          | https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code                                   |
| 2   | your-own-subscriptions | **yes**     | Slack does not resell coding model use; each agent is your own account with the vendor (Claude: "Each session runs under your own Claude account... and your plan limits").                                                              | https://www.salesforce.com/slack/introducing-slack-code/ ; https://code.claude.com/docs/en/slack                          |
| 3   | scheduling             | **partial** | Slack can run things on a timer (Workflow Builder scheduled triggers; Slackbot tasks, max three automatic runs a day), but no source shows a schedule starting a Slack Code coding agent.                                                | https://slack.com/help/articles/202026038-How-to-work-with-Slackbot ; https://api.slack.com/automation/triggers/scheduled |
| 4   | self-scheduling-trust  | **partial** | Slackbot (Slack's own agent) drafts a repeating task from a request and a person clicks "Create task" before it runs; found nothing on coding agents scheduling themselves.                                                              | https://slack.com/help/articles/202026038-How-to-work-with-Slackbot                                                       |
| 5   | coordination           | **partial** | Slackbot can route a request to the right agent ("universal router", Mar 31 2026), but found nothing on coding agents in code channels finding each other or handing off work. Searched "Slack agent-to-agent", agent sessions API docs. | https://slack.com/blog/news/agent-orchestration                                                                           |
| 6   | spend-guardrails       | **partial** | Slack caps its own Slackbot (15 messages per member per week on Business+, credits after that); coding agent spend is each vendor's plan limits, and Slack offers nothing to cap it.                                                     | https://slack.com/help/articles/53579676130195-Slackbot-limits-and-credit-usage                                           |
| 7   | local-first            | **no**      | Slack is hosted, and partner agents run in vendor clouds (Claude Code in Slack creates a "cloud session"); nothing runs on your computer.                                                                                                | https://code.claude.com/docs/en/slack                                                                                     |
| 8   | open-and-yours         | **no**      | Closed source, Salesforce-hosted, needs a Slack account plus an account with each agent vendor.                                                                                                                                          | https://slack.com/pricing                                                                                                 |
| 9   | surfaces               | **yes**     | Desktop, mobile and web Slack apps; the help article covers code channels on desktop and mobile, and the Agents & tools tab shows live status.                                                                                           | https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code                                   |
| 10  | approvals-anywhere     | **yes**     | High-stakes steps like shipping to production "route to a person for a fast approval, right in the channel", and anyone in the channel can pause or stop the agent, from any Slack app.                                                  | https://slack.com/blog/news/slack-code-channels-for-agents ; press release above                                          |
| 11  | attention-management   | **yes**     | The Agents & tools tab has a "Code channels" section showing "whether the agent is working or whether it needs your attention", on top of Slack's Activity view.                                                                         | https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack                                               |
| 12  | extensibility          | **partial** | Huge app marketplace, official MCP server (GA Feb 17 2026), agent sessions API; but only partner agents create code channels today ("will open to custom enterprise agents"). Sharing setups: found nothing.                             | https://docs.slack.dev/ai/agent-sessions/ ; https://slack.com/blog/news/mcp-real-time-search-api-now-available            |
| 13  | pricing                | see below   | Slack Code is included in every Slack plan; you also pay each agent vendor; closed source.                                                                                                                                               | https://slack.com/pricing                                                                                                 |

### Row 13 detail (pricing)

- Slack Code: no extra Slack charge ("available today on all Slack plans"); "Access to each partner agent is required"; "Pricing and packaging are subject to change."
- Slack plans (per user per month, from https://slack.com/pricing on 2026-10-07): Free $0 (90 days of history, up to 10 apps); Pro $7.25 annual / $8.75 monthly; Business+ $15 annual / $18 monthly; Enterprise+ custom. A 50% intro discount was shown on Pro and Business+.
- Slackbot beyond plan allowance uses Salesforce Flex Credits.
- Not open source.

### Other things asked for

- **Agents building apps/UI in Slack:** partial. Code channels show "code diffs, canvas documents, HTML views" and a live preview (help article). That is a preview of what the agent built, not a mini app living in Slack. The MCP server lets outside agents "manage canvases". Found nothing on agents building Lists or interactive apps inside Slack.
- **Code-only or general:** code today. Non-developers (PMs, designers, marketers) can trigger and review, per the press release, and Salesforce says it "will eventually" cover things like "marketing team building a campaign or legal running a document review". Slackbot covers general work separately.
- **Founders/small business:** nothing aimed at founders. It runs on the Free and Pro plans, so a small team can use it, but the pitch is enterprise (EKM, DLP, Discovery APIs on the feature page).
- **Lifecycle:** code channels close after seven days of inactivity or by hand; archived channels stay searchable as a record.

### Genuine strengths (say these honestly)

1. **It is where many teams already talk.** No new app, every teammate already has an account, and it is included in every Slack plan.
2. **Real multiplayer review.** Separate tabs for conversation, plan, diffs and live preview; anyone in the channel can pause, redirect or stop the agent; production pushes need a person's sign-off.
3. **Wide partner list.** About a dozen coding agents from different companies, each billed on the account you already have.
4. **Enterprise controls and mature apps.** Inherits Slack's admin, app approval, EKM, DLP and eDiscovery, with polished desktop, mobile and web apps.

### Gaps and contradictions

- No Slack source says where agents run; vendor docs (Anthropic) do.
- The two Slack-owned supported-agent lists disagree (Replit vs Cedar/Snowflake).
- OpenAI was a named launch partner in the press release but is missing from today's lists.
- No limits documented for Slack Code itself (count of channels, sessions, rate limits).
- Scheduling a coding agent, agent-to-agent handoff in code channels, and spend caps for partner agents: found nothing despite searching help, docs.slack.dev and blogs.

### Search methodology

About 10 searches and 14 fetches. Main sources: slack.com/help, slack.com/features, slack.com/blog, docs.slack.dev, salesforce.com, code.claude.com, help.openai.com, slack.com/pricing. Secondary: siliconangle.com, therundown.ai.
