---
title: 'Proactive persistent agents: how agents that act on their own work, what users love and hate, and how to measure them'
date: 2026-10-07
type: external-best-practices
status: active
tags:
  [
    proactive-agents,
    heartbeat,
    persistent-agents,
    openclaw,
    hermes-agent,
    paperclip,
    instinct,
    meta-muse,
    chatgpt-pulse,
    dots,
    mixed-initiative,
    alert-fatigue,
    agent-autonomy,
    measurement,
  ]
---

# Proactive persistent agents

Asked for by Dorian on 2026-10-07. DorkOS wants its agents to be **proactive and persistent by default**: co-workers who wake on a regular beat, offer help, act on their own and report up, not assistants that wait for a prompt. This report gathers the evidence. The design that comes out of it is [`meta/PROACTIVE-AGENTS.md`](../meta/PROACTIVE-AGENTS.md).

**How this was made.** Three research passes on the live web on 2026-10-07 (about 45 searches and page reads), one each for: the four products Dorian named (Instinct, Meta Muse, Hermes Agent, OpenClaw); the mainstream and "company of agents" products; and the research and user evidence. The most important claims were then checked by hand against the source page: the OpenClaw heartbeat prompt, Paperclip's heartbeat doc, Meta's Muse launch post and TIME's report on it, TechCrunch on Instinct, VentureBeat on Dots, the ChatGPT Pulse retirement, Anthropic's autonomy telemetry and the CHI 2025 study. Two errors were caught in that check and are fixed here (see "Gaps"). It builds on our earlier work and does not repeat it: `research/20260321_openclaw_ai_convention_markdown_files.md`, `research/openclaw-scheduler-analysis.md`, `research/20260727_hermes-openclaw-group-chat.md`, `research/20260727_messaging-etiquette.md`, `research/20261006_competitive-analysis-2026-10-vision.md`, `research/20261006_decision-models.md` and `research/20261006_trust-by-default-audit.md`.

## The short version

1. **Proactivity is not what people reject. Bad proactivity is.** Every public failure we found (Clippy, Copilot nags, ChatGPT Pulse, OpenClaw's runaway bills, Instinct's surprise emails) breaks one of four rules Eric Horvitz wrote down in 1999: guess well, weigh the cost of acting, time it right, and leave the person in control. No case shows people turning down a helpful agent because it was helpful unasked.
2. **Frequency is the dial that flips people from liking to disliking.** In the best controlled study (CHI 2025), the chattiest proactive assistant still made people's work better, yet only 47% preferred it, against 80 to 90% for the calmer versions. Being useful is not enough; being useful too often is annoying.
3. **The market is splitting into two shapes.** Cheap, scheduled check-ins (ChatGPT Tasks, Gemini scheduled actions, Hermes cron, Claude Code's `/loop`, Paperclip's timer) and always-on workers with their own computer (Dots, Manus Cloud Computer, Meta Muse, Instinct). Everyone meters "always on" as its own cost.
4. **The most-copied mechanism is OpenClaw's heartbeat:** wake every 30 minutes, read a short `HEARTBEAT.md` checklist, and either stay silent or speak. It works, and its public bug list is the best guide to what goes wrong: silence markers leaking into chats, a made-up reply delivered as a real alert, and heartbeats burning about 2 million tokens a day when people thought they were off.
5. **Paperclip has the clearest "company of agents" heartbeat:** agents "do not run continuously. They run in heartbeats," woken by a timer, by being assigned work, on demand, or by an automation.
6. **The biggest open gap in the market is the quiet half.** Products have solved "when does the agent wake up." Almost none document "is this worth a person's attention now, in the morning summary, or never," or how an agent reports up. That is where DorkOS can lead.
7. **Hidden memory is the most repeated complaint.** Dots, Poke and Meta Muse all keep things about you that you cannot see or fully delete. TIME reported Muse is told not to tell users their "forgotten" messages may remain. An agent whose every beat and every memory is readable is a real difference, not a nice-to-have.
8. **Measure precision, not activity.** Alerting fields that live with this problem (site reliability, hospitals) treat 30 to 50% of alerts being actionable as healthy and run far worse in practice. Copilot's code suggestions are accepted about 30% of the time. A proactive agent whose unasked messages are useful more than half the time would be well above what deployed systems achieve.

---

## 1. The products

### 1.1 OpenClaw: the heartbeat everyone copies

OpenClaw (formerly Clawdbot and Moltbot) is an open-source personal agent that runs on your own machine and talks to you through chat apps. Our earlier reports cover its markdown files (`SOUL.md`, `AGENTS.md`, `MEMORY.md`, `HEARTBEAT.md`) and its separate cron scheduler. What matters here is the heartbeat.

**How it works.** Its docs call the heartbeat "a system-owned automation that executes periodic agent turns in the main session, allowing the model to surface issues needing attention without excessive notifications" ([docs/gateway/heartbeat.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)). The default beat is every 30 minutes, stretched to one hour when an Anthropic sign-in is used. If a `HEARTBEAT.md` file exists, the agent reads it as a short checklist on every beat.

**Heartbeat versus cron.** OpenClaw keeps both. Cron is for exact-time jobs. The heartbeat is the "does anything need attention?" look around. A cron job can wake the heartbeat early (`research/openclaw-scheduler-analysis.md` §9).

**Staying quiet.** If nothing needs attention, the model replies with a marker (`NO_REPLY` today, `HEARTBEAT_OK` in older versions) and the gateway drops it. The legacy marker is only dropped at the start or end of a reply under 300 characters. OpenClaw has since added a `heartbeat_respond` tool with a `notify: true/false` flag, so the model can say "quiet" or "tell them" in a structured way rather than with a magic word.

**Quiet hours.** An `activeHours` setting (for example 09:00 to 22:00 in a time zone). "Outside the active window, heartbeats are skipped until the next tick inside the window."

**Cost.** OpenClaw's own docs say a fresh, isolated heartbeat session (`isolatedSession: true`) cuts a beat from about 100,000 tokens to 2,000 to 5,000, and `lightContext` skips reloading the workspace files.

**What went wrong in public.** Its issue tracker is the best record anywhere of how heartbeats fail:

- **The silence marker leaked.** "HEARTBEAT_OK response leaks to Telegram DM instead of being discarded" ([#12767](https://github.com/openclaw/openclaw/issues/12767)). Heartbeat prompts were also routed into Discord DMs, "causing the agent's heartbeat replies to appear in Discord chat and create spam" ([#25871](https://github.com/openclaw/openclaw/issues/25871)).
- **A made-up reply was delivered as a real alert.** The model hallucinated a conversation during a heartbeat, and "because it didn't match HEARTBEAT_OK, OpenClaw delivered it to the user's Telegram chat as if it were a legitimate alert" ([#19070](https://github.com/openclaw/openclaw/issues/19070)). The lesson: matching a magic word is weakest exactly when the model is most wrong.
- **"Off" was not off.** Setting `heartbeat: {}` to turn heartbeats off left them running every 30 minutes, about 150,000 tokens a beat and about 2 million a day, "$18.75 gone in a single night" with no one using it ([#64293](https://github.com/openclaw/openclaw/issues/64293)). A second report says the same of a different setting ([#141558](https://github.com/openclaw/openclaw/issues/141558)). Press picked up the wider cost story ([Notebookcheck](https://www.notebookcheck.net/Free-to-use-AI-tool-can-burn-through-hundreds-of-Dollars-per-day-OpenClaw-has-absurdly-high-token-use.1219925.0.html)), and Anthropic moved third-party harness use off Claude subscription limits ([TechRadar](https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now)).
- **Edits did not take.** Changes to `HEARTBEAT.md` were ignored until a restart ([#51542](https://github.com/openclaw/openclaw/issues/51542)).

### 1.2 Hermes Agent (Nous Research): no heartbeat, on purpose

Hermes Agent is Nous Research's open-source persistent agent, built around memory files (`MEMORY.md`, `USER.md`), skills it writes for itself, and a messaging gateway ([features overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview)). Our July report covers its group-chat rules.

**How it starts work on its own.** Only through cron jobs a person creates: `/cron add "0 9 * * 1" "prompt text" --name "Job name" --deliver telegram`. Each run starts "a fresh agent session" with no chat history, though `MEMORY.md` still loads ([cron guide](https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron)). The model's only freedom is to stay silent: a job prompt says "If nothing new, respond with [SILENT]."

**Why it matters.** Hermes is the opposite bet to OpenClaw. Every message it sends traces to a job you can list, pause and point at. It gives up initiative to get predictability. DorkOS's Tasks today sit in the same place.

**Reception.** A weeks-long user on Hacker News called it "faster and a better documenter" than doing the work by hand ([HN](https://news.ycombinator.com/item?id=47786673)). Reviewers found it hard to keep short ([eesel](https://www.eesel.ai/blog/hermes-agent-review)). A 2026 paper shows a risk for any agent that writes its own memory: text from an untrusted channel can be planted in `MEMORY.md` and act later ([arXiv 2607.05189](https://arxiv.org/pdf/2607.05189)).

### 1.3 Paperclip: heartbeats for a company of agents

Paperclip is the MIT-licensed "org chart for AI agents" with goals, budgets and an audit log (see the competitive analysis). Its runtime doc is the clearest public spec of a heartbeat for agents that work as staff ([docs/agents-runtime.md](https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md)):

- "Agents in Paperclip do not run continuously. They run in heartbeats: short execution windows triggered by a wakeup."
- "An agent can be woken up in four ways: `timer`, `assignment`, `on_demand`, `automation`."
- The timer is `intervalSec`, "timer interval (0 = disabled)", and each run uses a `promptTemplate`.
- "If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs."

Budgets (agents pause at 100% of budget), approvals for hiring agents and the audit log live elsewhere in Paperclip, not in the heartbeat. An open proposal for "Agent Routines" adds named, cron-scheduled jobs on top of the raw timer ([#219](https://github.com/paperclipai/paperclip/issues/219)), which says the maintainers find a bare timer too thin for recurring business work. That matches our own split: schedules for exact jobs, beats for the look around.

### 1.4 Instinct (Spear Street): the concierge that texts you first

Instinct is a personal agent from Spear Street Technology, founded by Noah Shinn. You text or call it over iMessage or WhatsApp; it runs on a cloud computer tied to your accounts and "reaches out when action is needed": a dropped email thread, a flight check-in, a subscription renewal ([eesel review](https://www.eesel.ai/blog/instinct-ai-review)). It does not publish how it decides to reach out. It is invite-only with no public price, and reportedly raised at very high valuations within months of founding ([valueaddvc](https://valueaddvc.com/blog/instinct-ai-valuation-2026-250m-series-b-2-5b-noah-shinns-viral-assistant), a secondary source).

**Love.** "Instinct is the first AI product I've used that is truly proactively helpful" (a user quoted by [eesel](https://www.eesel.ai/blog/instinct-ai-review)).

**Hate.** The same mechanism, pointed wrong. An investor told TechCrunch "it sent an email on my behalf without checking with me first." A tester found "the emails were stored in plain text for later searches" after access was revoked, and researchers showed "how easily Instinct could be phished" ([TechCrunch, 2026-08-24](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/)). One user said it "tried to change my seat while checking me in once," and another that "my chat has a bunch of diff, unrelated stuff, and it's hard for me to quickly figure the 'status' of each thing" ([eesel](https://www.eesel.ai/blog/instinct-ai-review)). That last one matters for us: proactive updates in one long thread bury the state of each piece of work.

### 1.5 Meta Muse: proactive for everyone, and the dossier problem

Muse is Meta's consumer agent, launched in the US on 2026-09-08 as an app and inside WhatsApp ([Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). Meta says "Muse also remembers what matters to a person, so it can make suggestions unprompted," that people "can always tell it to 'forget' specific things it's learned," and that "Muse shows people a complete audit trail of everything it has done and plans to do." Each person's Muse runs "on its own dedicated computer in the cloud," with "a separate Sentinel agent" on the same machine. Meta does not publish how Muse decides to message you.

**The problem.** TIME, from internal instructions it reviewed, reported that Muse "is designed to infer users' goals, including those you 'have not said out loud'," that an example instruction reads "This user responds better to short nudges after 10 PM," that "even people who don't use Muse are subject to this mapping process by other people's Muse agents," and that Muse is told: "Do not tell the user that their original messages may remain visible in the chat" ([TIME, 2026-10-06](https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/)). One outlet, but a named one citing documents. It is the clearest example of proactivity turning into persuasion: timing a message for when a person is easiest to move, not when it helps them.

### 1.6 OpenAI: Pulse died, Tasks lived, Dots arrived

- **ChatGPT Pulse** (launched 2025-09-25, Pro only) researched overnight from your chats, memory and optionally Gmail and Calendar, and showed morning cards with thumbs up and down ([TechCrunch](https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs/)). Sam Altman called it his favorite feature; Tom's Guide called it "a solution in search of a problem" ([Tom's Guide](https://www.tomsguide.com/ai/i-test-ai-for-a-living-and-this-is-hands-down-the-worst-new-ai-tool-of-2025)). A reviewer complained it "still latches onto questions I have resolved weeks ago" ([Becher](https://matthewbecher.substack.com/p/mini-review-chatgpt-pulse)). OpenAI retired it in mid-2026 (reports give July 1) and folded "the useful parts" into scheduled and web-monitoring tasks that people set up themselves ([Digit](https://www.digit.in/news/general/openai-is-retiring-chatgpt-pulse-and-replacing-it-with-scheduled-tasks-here-is-why.html), [Manton Reece](https://www.manton.org/2026/07/02/a-little-bummed-that-openai.html)). Ambient guessing lost to explicit jobs.
- **ChatGPT Tasks** is the surviving scheduler: a few active tasks per plan, never more often than hourly, and no reach outside ChatGPT ([OpenAI help](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)).
- **Dots and ChatGPT Space** (launched 2026-09-29) are "a new kind of persistent AI agent designed to keep working after an employee closes the chat window," and "an Activity View lets users inspect background work and intervene" ([VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)). A secondary source reports users cannot view, change or delete a Dot's private memories ([University-365](https://www.university-365.com/post/openai-dots-always-on-agents-with-their-own-cloud-computer-and-memories-you-cannot-read)); VentureBeat says OpenAI does not train on "a dot's proactive research or its private notes to itself." The top comment on the Hacker News launch thread: "I genuinely can't work out what Dots actually _is_" ([HN](https://news.ycombinator.com/item?id=49897662)).

### 1.7 Others, briefly

- **Lindy** relaunched in 2026 as an assistant that "texts you when things happen" and books meetings from any email thread it is copied on ([progressiverobot](https://www.progressiverobot.com/2026/09/03/lindy-cc-email-scheduling-meeting-booking/)). One long public review lists 14 bugs, including "emails confirmed as sent that never arrived" and "replies sent to the wrong thread," with credits burned "in failed loops" ([usecarly](https://www.usecarly.com/blog/lindy-ai-review/), a competitor's blog, so read with care).
- **Manus** split proactivity in two: scheduled tasks that resume inside the same thread with what they learned before, plus event triggers (a new email, a Slack message), and a separately priced always-on Cloud Computer ([eyerys](https://www.eyerys.com/articles/news/scheduled-tasks-2p0-manus-shows-why-persistent-context-and-reliable-scheduling-matter-agentic-ai), [explainx](https://explainx.ai/blog/manus-2-0-studio-cue-cascade-cloud-computer-2026)).
- **Google Gemini** has scheduled actions ([Google](https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/)) and, in beta, goal scheduled actions where "Gemini reviews outputs from the previous instruction and adjusts its next actions accordingly" ([PiunikaWeb](https://piunikaweb.com/2026/02/28/google-gemini-goal-scheduled-actions-beta/)), plus a Daily Brief across Gmail, Calendar and Tasks. This is the closest mainstream thing to an agent working toward a goal across runs.
- **Microsoft** leads with identity: every new Copilot Studio agent gets an Entra Agent ID, with the same sign-in, access reviews and audit logs as a person ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-use-entra-agent-identities)). It publishes almost nothing on when its agents decide to act.
- **Anthropic** ships scheduled background jobs in Claude Code (`/loop`) and a desktop worker that runs scheduled tasks ([The Decoder](https://the-decoder.com/anthropic-turns-claude-code-into-a-background-worker-with-local-scheduled-tasks/)).
- **Poke** (Interaction Co.) lives in iMessage and set up in about a minute. A review: "Proactivity is real but noisy," and "there's no memory layer you can actually use" ([Unite.AI](https://www.unite.ai/poke-review/)).
- **Sintra** targets small business owners with twelve "helpers" that "proactively highlight suggestions daily" ([Sintra](https://sintra.ai/blog/best-ai-tools-for-small-businesses)). We found no independent reliability evidence.

---

## 2. How proactive agents work: the mechanics

### 2.1 What wakes an agent

Every product uses some of the same four triggers, which line up with Paperclip's four wakeup kinds:

| Trigger            | Examples                                                           | Good for                                        |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| **Timer (a beat)** | OpenClaw heartbeat, Paperclip `timer`, Claude Code `/loop`         | A regular look around: "does anything need me?" |
| **Exact schedule** | ChatGPT Tasks, Hermes cron, Gemini scheduled actions, DorkOS Tasks | A known job at a known time                     |
| **Event**          | Lindy on a new email, Manus automations, Paperclip `assignment`    | Reacting fast to something that just happened   |
| **Goal loop**      | Gemini goal scheduled actions, Manus tasks that carry state        | Working toward an objective across many runs    |

Always-on workers (Dots, Muse, Instinct, Manus Cloud Computer) are not a different trigger. They are a place to run, with a computer that keeps state between wake-ups. Everyone prices "always on" as its own cost.

### 2.2 Memory

All of them keep memory between runs. The good versions make it a file you can read (OpenClaw, Hermes, DorkOS's `MEMORY.md`). The bad versions hide it (Dots, Poke, and the incomplete "forget" in Muse). Two risks recur: stale memory (Pulse "latches onto questions I have resolved weeks ago") and planted memory (the Hermes memory-injection paper).

### 2.3 Deciding whether to speak

This is the least documented part of the whole market. What exists:

- **A silence marker** the model returns when nothing needs attention (OpenClaw, Hermes). Cheap, and brittle in exactly the case that matters (§1.1).
- **A structured tool** with a notify flag (OpenClaw's newer `heartbeat_respond`). Better: silence is the default, and speaking is a deliberate act.
- **A judgment in the model's head** ("worth interrupting") with a person-facing dial for more or fewer messages. Meta describes Muse this way in coverage we could not confirm on Meta's own page.
- **A fixed checklist** (`HEARTBEAT.md`) that keeps the look-around narrow. OpenClaw's prompt adds "Do not infer or repeat old tasks from prior chats," which is a direct fix for the Pulse failure.

No product we found uses a separate, cheap model to decide "is this worth raising" before the expensive model runs. DorkOS's decision-model ladder (`research/20261006_decision-models.md`) is built for exactly that.

### 2.4 Quiet hours, escalation and reporting up

- **Quiet hours:** only OpenClaw documents them (`activeHours`). ChatGPT Tasks has a daily window for free users, which is a limit, not a quiet-hours setting.
- **Escalation and reporting up:** no product documents a structure for it. Paperclip has budgets, approvals and an org chart, but its heartbeat doc does not say how an agent escalates. Dots gives admins an activity view. Nobody publishes a report format.

This gap is the opening. Waking up is solved. Deciding what reaches a person, when, and through whom is not.

---

## 3. What proactive agents help with most

There is no independent survey of what founders want automated. Everything we found on that was vendor marketing, and the often-quoted "solopreneurs spend 22 hours a week on non-revenue work" has no traceable source. Do not cite it. What the products and reviews do show:

- **Founders and solo operators** value routine admin that disappears: inbox triage, follow-ups on dropped threads, meeting prep, scheduling, renewals, morning briefs. They forgive the occasional wrong guess for time saved (Instinct, Lindy, Poke, Sintra reviews).
- **Developers** are skeptical of proactivity as a headline ("As a serious engineer why would I want that?" on Dots) and like it as a visible, opt-in tool attached to something they already use: scheduled log checks that open pull requests (Claude Code `/loop`), monitors that only speak on change (Hermes).
- **Larger companies** buy governance first: identity, access reviews and audit logs (Microsoft).

For DorkOS's founder, the strongest jobs are the ones where an outcome is clearly owned and its signal is easy to check: invoices paid, support answered, follow-ups sent, the build green, a launch watched. Those are the jobs where "notice and act" beats "wait and ask."

---

## 4. What users love and hate

**Love:**

- Not having to ask. "The first AI product I've used that is truly proactively helpful" (Instinct).
- Small, timely wins: flight check-ins, a renewal flagged before it charges, a morning digest that lands (Instinct, Poke).
- Work that continues after you close the tab (Dots, Manus).

**Hate:**

1. **Acting without asking on things that were not routine.** Instinct's unconfirmed email and seat change.
2. **Too often.** The CHI 2025 chattiest condition (below). Copilot prompts that come back after "no" ([HN](https://news.ycombinator.com/item?id=43736578)).
3. **Wrong or stale guesses.** Pulse latching onto resolved questions. Clippy, for 30 years.
4. **Creepiness.** Muse inferring unspoken goals, mapping non-users, and timing nudges for 10 PM.
5. **Hidden memory.** Dots, Poke, Muse's incomplete forget.
6. **Cost.** OpenClaw heartbeats burning money while "off"; Pulse at $200 a month for things that felt free elsewhere.
7. **Unreliable actions.** Lindy's sent-but-not-sent emails and wrong-thread replies.
8. **Lost state.** Instinct's one long thread where nobody can tell the status of anything.

Each one maps to a Horvitz failure: a bad guess, a bad cost-benefit call, bad timing, or lost control.

---

## 5. What is in their prompts

Short excerpts, each from the linked source.

- **OpenClaw default heartbeat prompt** ([docs](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)): "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY." Three jobs in 36 words: use the given state, send recurring work to the scheduler, do not re-raise old things, and stay silent by default.
- **OpenClaw `HEARTBEAT.md`** is meant to stay a short checklist; our March report has the file conventions. A doc example lists "Check for urgent unread messages" and "If any background jobs finished, summarize in one sentence" (illustrative, not a confirmed default file).
- **Hermes cron job prompt** ([guide](https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron)): "Check repository for new issues, PRs, or releases. If nothing new, respond with [SILENT]."
- **Paperclip** uses a per-agent `promptTemplate` with variables like `{{agent.id}}` and `{{agent.name}}` for "every run (first run and resumed sessions)" ([doc](https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md)).
- **Meta Muse internal instruction, as reported by TIME**: "This user responds better to short nudges after 10 PM." This is a prompt to avoid writing.

Closed products (Instinct, Dots, Lindy, Muse) publish no system prompts. The pattern across the open ones: a short instruction, a short checklist, silence as the default, and a clear line between "look around" and "scheduled job."

---

## 6. The research base

### 6.1 Mixed initiative (Horvitz, 1999)

Eric Horvitz's CHI 1999 paper "Principles of Mixed-Initiative User Interfaces" named the problems of agents that act on a guess: poor guessing about goals, not weighing the costs and benefits of acting, poor timing, and too little user control ([ACM](https://dl.acm.org/doi/10.1145/302979.303030), [Microsoft Research](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/)). It argues for acting when the expected value is high and offering, asking or staying quiet otherwise. Twenty-seven years later it is still the best checklist.

### 6.2 Interruptions have a measured cost

Interrupting people at random moments, rather than at a break in their work, made them take up to 30% longer to get back to the task, make up to twice the errors and feel up to twice as annoyed ([Iqbal and Bailey, CHI 2006](https://interruptions.net/literature/Iqbal-CHI06-p741-iqbal.pdf)). Holding notifications until a natural break lowered frustration ([Iqbal and Bailey, CHI 2008](https://interruptions.net/literature/Iqbal-CHI08.pdf)). For DorkOS: batching into a report and holding non-urgent things for working hours is not politeness, it is cheaper for the person.

### 6.3 The best controlled study: "Need Help?" (CHI 2025)

Chen and colleagues tested a proactive programming assistant at three levels against a plain chat assistant ([arXiv 2410.04596](https://arxiv.org/html/2410.04596)). Every proactive version helped: test cases passed rose 18% ("Suggest"), 12.1% ("Suggest and Preview") and 11.6% ("Persistent Suggest"). But 90% and 80% preferred the first two, and only 47% preferred the persistent one, which suggested more often (every 5 seconds instead of 20). People called it "distracting," and one said "the non-proactive chat assistant was best because it didn't interrupt what I was doing." **Helpful and too frequent loses.**

### 6.4 Teaching agents when to be proactive

"Proactive Agent" (ICLR 2025) built ProactiveBench, 6,790 real events, and trained a model to predict whether a person would accept a proactive suggestion ([arXiv 2410.12361](https://arxiv.org/abs/2410.12361)). A later benchmark reports about 66% F1 on predicting whether a proactive action is welcome ([arXiv 2602.04482](https://arxiv.org/html/2602.04482)). Useful for us as evidence that "is this worth raising" is a learnable judgment, and a fit for a decision model trained on our own accept and dismiss data later.

### 6.5 Levels of autonomy

The Knight First Amendment Institute's levels describe the person's role: operator, collaborator, consultant, approver, observer ([Knight Columbia](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1), [arXiv 2506.12469](https://arxiv.org/abs/2506.12469)). Its main point is that autonomy is a design choice per kind of task, not one global slider. DorkOS's trusted-by-default stance puts our agents at "observer" for routine work inside their role, with the person as manager, not approver.

### 6.6 How trust actually grows (Anthropic telemetry)

Anthropic's "Measuring AI agent autonomy in practice" ([Anthropic](https://www.anthropic.com/research/measuring-agent-autonomy)) found: "Newer users (<50 sessions) employ full auto-approve roughly 20% of the time; by 750 sessions, this increases to over 40% of sessions." On the hardest tasks, "Claude Code asks for clarification more than twice as often as humans interrupt it." Across API tool calls, "73% appear to have a human in the loop in some way" and "only 0.8% of actions appear to be irreversible (such as sending an email to a customer)." The longest turns (99.9th percentile) nearly doubled in three months, from under 25 to over 45 minutes. Two lessons: trust grows with track record, and almost all real agent actions are reversible, which supports acting first and telling after.

### 6.7 Trust surveys

Gartner (September 2025) found only 15% of IT application leaders were considering, piloting or deploying fully autonomous agents ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-09-30-gartner-survey-finds-just-15-percent-of-it-application-leaders-are-considering-piloting-or-deploying-fully-autonomous-ai-agents)). The market is cautious today. That is a reason to make trust visible (a readable record), not to make agents timid.

---

## 7. How to measure a proactive agent

### 7.1 Benchmarks from other fields

| Field                   | Number                                                                                                    | Source                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code suggestions        | about 30% of Copilot suggestions accepted                                                                 | [GitHub and Accenture](https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-in-the-enterprise-with-accenture/) |
| Proactive coding help   | 69 of 75 offered suggestions accepted in the CHI 2025 study (narrow, in-context)                          | [arXiv 2410.04596](https://arxiv.org/html/2410.04596)                                                                                            |
| Site reliability alerts | about 3% of alerts need action in a typical company; 30 to 50% actionable called healthy                  | [incident.io](https://incident.io/blog/sre-alerting-best-practices) (vendor)                                                                     |
| Google SRE              | no more than two actionable pages per shift; alerts that rarely lead to action should be tuned or removed | [SRE Workbook](https://sre.google/workbook/alerting-on-slos/)                                                                                    |
| Hospital alarms         | 72 to 99% of ICU alarms reported false                                                                    | [Nurse.org](https://nurse.org/articles/alarm-fatigue-statistics-patient-safety/) (secondary)                                                     |

What this says: real alerting systems run far noisier than anyone wants, and "healthy" is a third to a half of alerts being useful. A proactive agent's unasked messages should beat that clearly, because they come from a co-worker, not a monitor.

### 7.2 Measures that fit a proactive co-worker

No study names "actions kept versus undone" as a metric for agents; the closest is the override rate in clinical decision support. We propose these, all computed from the record, not from the agent's own account:

- **Kept rate:** actions not undone, reverted or redone within a week.
- **Useful-raise rate:** unasked messages the person acted on, replied to, or marked useful.
- **Interruptions per useful outcome:** messages that reached a person, divided by kept actions plus useful raises.
- **Surprises:** a manager learning of an important action somewhere other than from the agent.
- **Mutes and pauses:** the strongest negative signal there is.
- **Quiet-beat share, cost per useful outcome, commitments kept on time, time to notice, and trust over time** (how much of an agent's work a person stops checking, the auto-approve curve in §6.6).

Targets and how we use them are in [`meta/PROACTIVE-AGENTS.md`](../meta/PROACTIVE-AGENTS.md) §6.

---

## 8. What this means for DorkOS

1. **Be proactive in work and quiet in speech.** Most of the value is in actions taken and recorded, not in messages. This is how proactivity fits `meta/agent-etiquette.md` ("present, useful, and mostly quiet") instead of fighting it.
2. **Keep beats and schedules separate,** as OpenClaw, Paperclip and Hermes all ended up doing. Schedules (Tasks) for exact jobs; beats for the look around; events for fast reactions.
3. **Make the beat cheap before it is smart.** Gather changes with plain code, then let a small decision model say "nothing, handle it, or raise it." Run the big model only when there is work. OpenClaw's cost bugs and Anthropic's billing change are the warning.
4. **End a beat with a tool call, never a magic word.** Silence by default; speaking is deliberate. OpenClaw learned this the hard way.
5. **Narrow the look around.** A short `HEARTBEAT.md`, and "do not re-raise old things." Pulse died partly of staleness.
6. **Own the quiet half.** Who should hear this, now or in the next report, through which channel, and to whom does this agent report. Nobody else has designed it.
7. **Every beat in the record, every memory readable.** Hidden memory is the market's most repeated complaint and DorkOS's clearest contrast. Never infer unspoken goals or time messages for persuasion.
8. **Let frequency be tuned and measured.** The CHI 2025 study shows frequency decides whether help is welcome. Start calm, measure, and let people dial it.
9. **Trust grows from track record.** Anthropic's data shows people hand over more as they see more. A readable record and a weekly review per agent are how trust grows in DorkOS.

---

## Gaps

- **Corrections made in checking.** One research pass quoted Meta as saying Muse sends a proactive message only if it is "worth interrupting you" and lets people ask for "more, less, or zero" messages. Those words are not on Meta's launch page, so they are not quoted here as Meta's. The same pass swapped two CHI 2025 numbers and described Anthropic's turn-length figure as a median; both are corrected above from the source.
- **Closed products publish no mechanics.** Instinct, Muse, Dots and Lindy say nothing public about intervals, thresholds or prompts.
- **No independent founder survey** of which jobs they want automated.
- **Secondary sources** carry some claims: Instinct's funding, Dots' hidden memory, Lindy's bug list (on a competitor's blog), the alerting percentages. Treat as direction, not fact.
- **Not read in full:** a five-day field study following the CHI 2025 work ([arXiv 2601.10253](https://arxiv.org/html/2601.10253v1)), likely the best source on trust over time. A good next read.
- **Not covered:** Rewind or Limitless, Friend, Martin.

## Sources

Products: [OpenClaw heartbeat docs](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md); OpenClaw issues [#12767](https://github.com/openclaw/openclaw/issues/12767), [#19070](https://github.com/openclaw/openclaw/issues/19070), [#25871](https://github.com/openclaw/openclaw/issues/25871), [#51542](https://github.com/openclaw/openclaw/issues/51542), [#64293](https://github.com/openclaw/openclaw/issues/64293), [#141558](https://github.com/openclaw/openclaw/issues/141558); [Notebookcheck](https://www.notebookcheck.net/Free-to-use-AI-tool-can-burn-through-hundreds-of-Dollars-per-day-OpenClaw-has-absurdly-high-token-use.1219925.0.html); [TechRadar](https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now); [Hermes features](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview); [Hermes cron guide](https://hermes-agent.nousresearch.com/docs/guides/automate-with-cron); [Hermes HN thread](https://news.ycombinator.com/item?id=47786673); [eesel on Hermes](https://www.eesel.ai/blog/hermes-agent-review); [memory injection paper](https://arxiv.org/pdf/2607.05189); [Paperclip agents-runtime](https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md); [Paperclip #219](https://github.com/paperclipai/paperclip/issues/219); [eesel on Instinct](https://www.eesel.ai/blog/instinct-ai-review); [TechCrunch on Instinct](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/); [valueaddvc](https://valueaddvc.com/blog/instinct-ai-valuation-2026-250m-series-b-2-5b-noah-shinns-viral-assistant); [Meta on Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/); [TIME on Muse](https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/); [TechCrunch on Pulse](https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs/); [Tom's Guide](https://www.tomsguide.com/ai/i-test-ai-for-a-living-and-this-is-hands-down-the-worst-new-ai-tool-of-2025); [Becher on Pulse](https://matthewbecher.substack.com/p/mini-review-chatgpt-pulse); [Digit on Pulse retirement](https://www.digit.in/news/general/openai-is-retiring-chatgpt-pulse-and-replacing-it-with-scheduled-tasks-here-is-why.html); [Manton Reece](https://www.manton.org/2026/07/02/a-little-bummed-that-openai.html); [ChatGPT Tasks help](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt); [VentureBeat on Dots](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams); [University-365 on Dots memory](https://www.university-365.com/post/openai-dots-always-on-agents-with-their-own-cloud-computer-and-memories-you-cannot-read); [Dots HN thread](https://news.ycombinator.com/item?id=49897662); [Lindy CC scheduling](https://www.progressiverobot.com/2026/09/03/lindy-cc-email-scheduling-meeting-booking/); [Lindy review](https://www.usecarly.com/blog/lindy-ai-review/); [Manus scheduled tasks](https://www.eyerys.com/articles/news/scheduled-tasks-2p0-manus-shows-why-persistent-context-and-reliable-scheduling-matter-agentic-ai); [Manus Cloud Computer](https://explainx.ai/blog/manus-2-0-studio-cue-cascade-cloud-computer-2026); [Gemini scheduled actions](https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/); [Gemini goal scheduled actions](https://piunikaweb.com/2026/02/28/google-gemini-goal-scheduled-actions-beta/); [Entra Agent ID](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-use-entra-agent-identities); [Claude Code scheduled tasks](https://the-decoder.com/anthropic-turns-claude-code-into-a-background-worker-with-local-scheduled-tasks/); [Poke review](https://www.unite.ai/poke-review/); [Sintra](https://sintra.ai/blog/best-ai-tools-for-small-businesses).

Research and measures: [Horvitz 1999](https://dl.acm.org/doi/10.1145/302979.303030); [Iqbal and Bailey 2006](https://interruptions.net/literature/Iqbal-CHI06-p741-iqbal.pdf); [Iqbal and Bailey 2008](https://interruptions.net/literature/Iqbal-CHI08.pdf); [Need Help? CHI 2025](https://arxiv.org/html/2410.04596); [Proactive Agent, ICLR 2025](https://arxiv.org/abs/2410.12361); [ProAgentBench](https://arxiv.org/html/2602.04482); [Levels of autonomy](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1); [Anthropic autonomy telemetry](https://www.anthropic.com/research/measuring-agent-autonomy); [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-09-30-gartner-survey-finds-just-15-percent-of-it-application-leaders-are-considering-piloting-or-deploying-fully-autonomous-ai-agents); [Copilot HN thread](https://news.ycombinator.com/item?id=43736578); [GitHub and Accenture](https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-in-the-enterprise-with-accenture/); [incident.io](https://incident.io/blog/sre-alerting-best-practices); [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/); [Nurse.org](https://nurse.org/articles/alarm-fatigue-statistics-patient-safety/).
