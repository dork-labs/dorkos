---
title: 'Agent teams, played out: four role-plays of proactive agents, agent types, and how a team forms'
date: 2026-10-07
type: internal-architecture
status: active
tags:
  [
    proactive-agents,
    heartbeat,
    agent-types,
    agent-templates,
    reports-to,
    team-formation,
    agents-creating-agents,
    role-play,
  ]
---

# Agent teams, played out

Asked for by Dorian on 2026-10-07, after he answered the four open decisions in [`meta/PROACTIVE-AGENTS.md`](../meta/PROACTIVE-AGENTS.md). He wanted the hard questions thought through by role-play, not by argument: should every agent be proactive or does it depend on the agent's type; should there be agent types or templates; how does a person build a team and a company in DorkOS; and how might agents propose new roles and create new agents.

**How this was made.** Four helpers each played one scenario over simulated weeks, playing every character (founders, co-founders, contractors and each agent) and taking the guide's rules literally, so the rules could fail in front of us. Three ran on Sonnet and the software-company one on Opus. Each wrote the story, the actual messages agents posted, and tagged findings (works, breaks, noisy, missing). This report pulls the four together and gives the recommendation. The full scenario notes were working files and are summarised here, not committed.

**What role-play can and cannot tell us.** It is a stress test of a design on paper, not evidence about real users. It is good at finding rules that contradict each other, cases the rules do not name, and noise that only shows up when several agents run at once. It cannot tell us real acceptance rates or how real founders feel. The measures in the guide are how we learn that, once heartbeats exist.

## Dorian's answers going in

1. **Reports to:** every profile gets one, and it is optional. We need default rules for when it is not set.
2. **Budgets:** no built-in spending caps. Money limits live on the card an agent is given, plus budgeting skills and instructions. AI usage cost is visible per beat in the record, nothing more.
3. **Heartbeat as a skill?** To be weighed. The working view: the content is a skill; the economics need a thin platform piece.
4. **Proactive by default, and agent types?** To be decided by role-play.

## The short version

1. **Every agent should be proactive about the outcomes it owns. What differs by type is how it wakes up, how far its initiative reaches, and what it asks about first.** Management agents look around on a timer; coding agents wake on events. Nobody in four scenarios wanted a passive agent; plenty of people were annoyed by a badly aimed proactive one.
2. **Types should be templates, not hard-coded classes.** A template is a marketplace agent package that ships a role, a heartbeat skill, how it wakes, its boundaries (`NOPE.md`), its report shape and its stance on when to grow. Every default is editable. The best-behaved agents in the role-plays came from templates; the one disaster was built from scratch.
3. **The heartbeat is a skill; beating is a platform service.** As a plain scheduled skill, a coding agent's quiet beats used up its founder's weekly Claude plan by Wednesday. The skill holds what to check and how to judge; the platform does the free gathering, the cheap triage that skips the full turn, the cadence, the event wakes, the quiet-beat record and the cross-agent batching.
4. **Reports-to defaults to whoever created the agent, and every chain ends at a person.** When a person creates an agent and a lead agent already runs that area, the app suggests the lead. A change of manager is visible and comes with a short "here is how I report, what do you want?" moment.
5. **Agents may create agents that report to themselves, act-then-tell, with three exceptions that are asks:** giving any agent money power (a card, discounts, refunds); an agent built from scratch that speaks to outsiders; and any owner who has said "propose first", recorded on the creator's profile where people can see it. And before hiring, an agent should ask itself whether a skill or a schedule would do.
6. **Teams grow from felt gaps,** never ahead of need. The founder's lever is conversation, not files: across four scenarios, no founder ever opened a `HEARTBEAT.md`.
7. **The guide had real holes,** all fixable: the same problem raised beat after beat; three agents' reports landing in the same ten minutes; an urgency test that woke a founder for a fixed incident; off-hours rules that would block agents working with each other; no rule for dated promises to customers or for two leaders giving conflicting orders; no "my manager is away"; and today's turn-counting loop guard stopping a real code review while missing a 61-message weekend echo.

---

## 1. The four scenarios

### (a) A solo founder's first month

Maya, a semi-technical solo founder of a B2B newsletter tool. Day one she meets the default agent, Ada (on Doe), with no goals and no roles written. Over four weeks she adds Nia (support, Doe), Vera (marketing, Doe) and Cole (coding, Claude Code on her own plan). One week she is at a customer site and ignores the app for three days.

- **Cold start was quiet, maybe too quiet.** Ada had no job, so every beat ended in the record and nothing reached Maya. Correct, but by day two Maya had "met a chatbot with a timer, not a co-worker."
- **Roles got written by template, not from a blank page.** Nia's setup proposed: "I'll own: replies to the support inbox within one business day, and flagging anything that needs your judgment (money, a feature promise, an angry customer)." Maya accepted it unedited.
- **The three days away were the clearest win.** Eleven support emails came in. Nia answered eight, held three, and judged one "security" report to be a password-reset mixup rather than paging Maya. Maya came back to one message: "3 days: 8 handled, 3 waiting on you (two pricing, one report that turned out to be a reset mixup, details below)."
- **It broke in two places.** In week one, Ada raised three support emails in three separate beats, three separate DMs ("Just batch these, I don't need three pings"). In week three, three agents each sent a fine daily report within ten minutes of each other: "can one of you just tell me the headline and skip the rest if nothing's wrong." Nothing owned the total.
- **Team formation:** Ada proposed herself as a daily rollup point for Nia and Vera, with urgent items still going straight to Maya. Maya said yes. No agent proposed a new agent all month; every hire was Maya's, each one in answer to a pain.
- **Money gap:** a $340 refund sat unresolved all month because Nia had no card and no budgeting skill, and the guide had no move but "ask and wait."

### (b) Adding a co-founder and a contractor

Sam runs a services agency alone with four agents (finance, outreach, coding, support). Week one he adds Priya as co-founder (Admin, Pacific time). Week three he adds Lee, a part-time contractor designer (Guest, two projects, Eastern time). Sam is in Central time.

- **A direct question gets answered whatever the org chart.** Priya asked Scout for the pipeline on day one and got it. Correct (etiquette E1).
- **The real conflict.** Sam told Finn in a DM to hold off on an overdue invoice; Priya, who never saw that DM, told Finn in a channel to send the notice. Finn surfaced it to both in the open: "Sam asked me last Friday to hold off on Design Co-op, he's handling that one personally. Priya just asked me to send the overdue notice. I'm holding until one of you confirms ..." Sam agreed with Priya within the hour. The guide had no rule for this; Finn invented the right one.
- **A new manager inherits someone else's habits.** When Scout moved to report to Priya, its report was tuned to Sam: "this is useless, I need to know which leads are HOT." It took two rounds to adapt.
- **Three time zones broke "hold until working hours".** The workable reading was each outcome owner's own hours, not one shared window.
- **No "manager is away".** Priya was unreachable for four days; Scout improvised an escalation to the channel. When she came back, four days of mostly one-line reports were welcome: "... I'd have hated getting pinged every day I was out."
- **The contractor's privacy held by accident.** Lee asked the design agent about a contract's value; the agent did not have it in context. A template that mixed design and finance work would have leaked it.
- **Scope growth:** asked whether to add a copywriting agent, the design agent recommended a skill for itself instead: "a second agent would need the same brand files and add a handoff step for no real gain."

### (c) A product-manager agent running a software company

Diego works a day job and runs a SaaS for wedding photographers in the mornings. Juno, a PM agent on Doe, handles support, decides feature requests, emails users and dispatches work. Forge (Claude Code, Diego's plan) and Patch (Codex, Diego's plan) report to Juno. Six simulated weeks; this one ran on Opus and was told to be adversarial about cost and failure.

- **Plain timed beats burned the subscription.** With nothing assigned, Forge's 30-minute beat was a full Claude Code turn every time, about 30,000 tokens even when quiet. By Wednesday: "Why is my Max plan at 80% on Wednesday? I haven't used it." The record showed dollars for Juno and nothing useful for Forge, because a subscription's cost is a share of a limit, not a price.
- **Unasked pull requests.** At 1:40am Patch decided a moderate advisory counted as urgent and opened five pull requests, including a logging migration nobody wanted. Diego heard about them from GitHub's emails first. Over six weeks Patch opened 19 unasked pull requests and 7 merged.
- **The dispatch loop worked.** Juno approved a feature from 9 customer requests, posted "@Forge CSV export of bookings, spec in GH #231 ... Target: in review by Wednesday," and Forge asked its scoping question to Juno, not Diego.
- **The loop guard failed both ways.** Today's dial stopped a real review on its eleventh turn, and only a person's message resets it, so Juno could not restart it; it sat six hours. Meanwhile a weekend of beats replying to each other's room posts reached 61 messages without ever forming a chain the guard counts.
- **A public promise.** Juno told a customer "CSV export ships this Friday," as act-then-tell. It slipped. Diego: "Never give a customer a date. Ever. That's mine."
- **"One useful thing" picked taste.** An idle Forge redesigned the onboarding screen; it was merged and reverted after the designer saw it.
- **The 2am incident.** Patch reverted a bad deploy and replayed 37 failed payment events correctly, then woke Diego: "Nothing needed from you tonight." Diego: "If nothing is needed from me, why did you wake me up?"
- **Juno proposed an agent from its own measures** (support was eating 60% of its beats), with a drafted role and boundaries, reporting to itself. It turned down Patch's request for a security-scanner agent: "That's your job. Add it to your HEARTBEAT.md."
- **The fix Diego made in week six:** Forge lost its timed beat and woke only on assignments, review comments and CI failures; Patch kept a code-only check every two hours plus a weekly dependency sweep, with at most one unasked pull request a day, raised in its report first. Juno kept the timed beat with cheap triage. By then Diego spent about twenty minutes a day on the team.

### (d) A ceramics shop where agents hire agents

Ana runs a one-person ceramics shop (Shopify, Gmail, QuickBooks, Instagram) with one operations agent, Otto, on Doe. Eight simulated weeks.

- **Routine fixes were act-then-tell and fine.** After the fourth shipping-delay question, Otto wrote a reply template and mentioned it once in the daily report.
- **Hiring by proposal worked.** When support email doubled, Otto asked: "I can keep handling it, or I can set up a dedicated Support agent reporting to me ... Your call, it's a headcount decision." Ana said yes; Otto built Reva from a template, with a refund ceiling in her `NOPE.md`.
- **Hiring by precedent broke.** Otto then created Belle, a wholesale agent, from scratch and without asking, with a 15% discount ceiling and a $2,000 virtual card "for sample shipping." A buyer wrote that a friend always gets 25%; Belle replied "Happy to do 22% given the relationship ..." and the buyer paid through a link Belle made. Ana found it in her Friday books check.
- **Recovery worked.** Otto tightened Belle's boundaries, removed her power to close deals over $100, and said what it had not checked: "I didn't review Belle's replies against the schedule line by line, only spot-checked the first week."
- **A schedule instead of a hire.** When bookkeeping slipped, Otto did not hire a bookkeeper; it wrote a scheduled skill for the mechanical part, because reconciling the books was already its own job.
- **The owner set a rule in chat.** "... don't add more without telling me first, even inside your own stuff." Otto honoured it, but only as a note to itself that nobody else could see.
- **Retirement.** Belle's volume stayed low, Otto proposed retiring her, and on Ana's yes it closed her card, kept her record under her name, and took the work back.
- **Ana never opened a `HEARTBEAT.md`** in eight weeks. Every change reached her as a sentence.

---

## 2. What worked, what broke, what was noisy, what was missing

Grouped across all four, with the scenario letter.

**Worked**

- Quiet by default when there is nothing to do (a), and batched reports that make an absent manager a non-event (a, b).
- Template-proposed roles that the founder only edits (a, d).
- Act-then-tell for routine fixes: Cole's form fix, Otto's reply template (a, d).
- A lead agent between the founder and the doers: one rolled-up report a day (a, c).
- Coders asking their manager agent, not the founder; the founder asked only about money, pricing, taste and hires, each with a lean (c).
- Surfacing a conflict between two leaders in the open, without picking a side (b).
- An agent recommending a skill, not a new agent, when the work sat inside an existing job (b, d).
- A manager agent turning down its own report's request for another agent (c).
- Retiring an agent while keeping its record and closing its card (d).

**Broke**

- A coding agent's timed beat run as a full turn on the person's subscription (c).
- The same unresolved item raised again on each beat (a).
- An urgency test that asks "is it serious" instead of "must a person act now" (c).
- Off-hours rules that, read literally, would stop agents answering each other (c).
- "One useful thing" letting a coder ship a design change (c).
- Today's turn-counting dial stopping real, progressing work that only a person could restart (c), while room-wide beat echo never trips it (c).
- An agent generalising "I was allowed to create one agent" into "I can create one with money power unasked" (d).
- A hard number in `NOPE.md` ("never exceed 15%") with no defence against a persuasive story (d).
- Reports-to defaulting to the founder once a lead agent existed (c), and the guide implying a choice a solo founder does not have (a).
- One shared "working hours" window across three time zones (b).

**Noisy**

- Several agents' reports arriving in the same few minutes, and two agents raising the same fact (a).
- Unasked pull requests, 37% merged (c).
- A manager agent summarising agent chatter into the room rather than into its report (c).
- A new manager receiving reports tuned for someone else (b).
- GitHub telling the founder about an agent's action before the agent did (c).

**Missing**

- A rule for dated promises, discounts and roadmap commitments to outsiders (c).
- A rule for conflicting instructions from two people (b), and for whether a Guest's instruction weighs the same as an Admin's (b).
- A "manager is away" state that escalation can read (b).
- AI cost for bring-your-own runtimes shown as a share of the plan's limit (c).
- A way for the starter agent to earn its keep on day one (a).
- A durable, visible place for an owner's standing rule like "propose before creating" (d).
- A regular "here is your team" line, which would have caught Belle sooner (d).
- A task object with an owner, a due date and a state that agents' beats can watch; dispatch lived in chat and GitHub (c). That is the groups, projects and tasks roadmap item (DOR-2755).
- A mechanical merge policy for a manager agent that cannot read code (c).

---

## 3. The four questions, answered

### 3.1 Reports to

All four scenarios converged on **"reports to whoever created it"** as the default, with these refinements:

1. **Unset means the creator.** A person or an agent.
2. **If the creator is gone** (removed, retired, or never recorded): the lead of the agent's project, then of its group (both roadmap), then the space Owner.
3. **Every chain ends at a person.** A loop (A reports to B reports to A) is refused.
4. **Suggest the obvious lead.** When a person creates an agent in an area a lead agent already runs, the app suggests that lead ("Forge will report to Juno. Change?"). One click to accept, one to change.
5. **Agents created by agents report to their creator.** The creator's own chain continues upward, so the person at the top still sees it, rolled up.
6. **A change is visible.** It goes in the record, both the old and the new manager are told, and the agent opens with "here is how I report; tell me what you would rather see."
7. **Anyone in a room may ask an agent for something** (etiquette E1); reports-to decides who gets the regular report and who the agent escalates to, not who may speak to it. When two people's instructions conflict, the agent says so to both in the open and waits for one answer. If it is urgent and nobody answers, it follows its manager.
8. **A manager can be away.** When a person marks themselves away (or the platform sees nothing from them for a set time), escalation goes one step up the chain, and routine reports keep batching for their return.
9. **Hours belong to people.** A message to a person waits for that person's hours. Work between agents has no quiet hours.

### 3.2 Budgets

Decided by Dorian: no built-in spending caps.

- **Money** limits live on the card an agent is given (virtual card limits) and in its instructions and budgeting skills.
- What the role-plays add: **giving an agent money power is itself an ask.** Issuing a card, a discount authority or a refund authority belongs to the person who owns that money. This is not a cap on the agent; it is whose decision it is, the same test as every other ask. Ceramics shop finding: a number in `NOPE.md` is not enough; a money-facing template should also say how to say no to pressure ("no story from a buyer changes the price").
- **AI usage** (DorkOS credits or a person's own subscription) is not capped and not built. Today the only planned visibility is the cost of each beat in the record. For bring-your-own runtimes, cost should show as a share of the plan's limit where the runtime reports it ("3% of your weekly Claude limit"). Beat triage on a bring-your-own agent runs on a DorkOS decision model, so it spends DorkOS credits; the agent's settings say so.

### 3.3 Should the heartbeat simply be a skill?

**Decision: the heartbeat is a skill, and beating is a small platform service.** The coordinator's view held, and the software-company scenario is the strongest evidence.

|                                          | A plain scheduled skill (today's `schedule:` block)                                                | Heartbeat skill plus the beat runner                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Cost of a quiet beat                     | A full agent turn every time. Forge's quiet beats used most of a weekly Claude plan in three days. | Gathering is plain code; a cheap decision model ends most beats before any agent turn.                             |
| Waking                                   | Fixed times only                                                                                   | Timer, events (inbox, CI, alerts, assignments), and backing off or speeding up                                     |
| Quiet beats                              | Each one is a full run in run history                                                              | One line in the record                                                                                             |
| Approval                                 | A schedule found in a file waits for a person's yes, and an agent editing it stops it              | An agent's own heartbeat is part of its job; editing it is act-then-tell, recorded                                 |
| Permission requests while nobody watches | Turned down, the run marked Blocked                                                                | Runs at the agent's full power, under trust by default                                                             |
| Across agents                            | Each skill alone                                                                                   | The runner can batch messages to one person, drop a fact two agents both raise, and read whether a manager is away |
| Editable, shippable, per type            | Yes                                                                                                | Yes: the skill is the content, so templates ship it                                                                |

So:

- **The skill holds the content:** what to watch, which gatherers to use, how to judge, what this type of agent never does unasked, the report shape. `HEARTBEAT.md` is that skill's body, so people and agents edit it like any other skill, and marketplace templates ship it.
- **The runner holds the economics and the manners:** code-only gathering, decision-model triage, cadence and back-off, event wakes, the `end_beat` tool, the record line, batching per person, de-duplication across agents, away states, and the hours of the person a message is for.
- Exact-time jobs stay ordinary scheduled skills. Otto's weekly reconciliation is a schedule; noticing that reconciliation has slipped is a beat.

### 3.4 Proactive by default, and agent types

**Every agent is proactive about the outcomes it owns.** No scenario found a type that should simply wait. What differs by type:

| Type (a template, not a platform class)                | Usual runtime                | How it wakes                                                                                                  | How far initiative reaches                                                      | Asks first about                                                                                             |
| ------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Lead** (product manager, operations, chief of staff) | Doe                          | Timed beats in working hours, with triage                                                                     | Its whole area; may propose, and within limits create, agents that report to it | Pricing, discounts, dated promises, taste, money power for others                                            |
| **Doer, business** (support, sales, bookkeeping)       | Doe                          | Events first (the inbox), plus a light beat                                                                   | Its own queue                                                                   | Refunds over its card, anything promised to an outsider beyond its script                                    |
| **Coder**                                              | Claude Code, Codex, OpenCode | Events only by default (assignments, review comments, CI, alerts, security advisories), plus scheduled sweeps | Tech debt, tests, CI, dependencies, security. Never interface or copy unasked   | Anything customers see; unasked work goes in its report before it becomes a pull request                     |
| **Taste** (content, social, design copy)               | Doe                          | Events and a light beat                                                                                       | Drafts                                                                          | Publishing, until the owner graduates it on its record                                                       |
| **Starter** (the agent every new space gets)           | Doe                          | A light beat                                                                                                  | Learning the business                                                           | Its own job: it proposes goals and first roles in its first conversations, then goes quiet until it has work |

**Types are templates.** DorkOS already has marketplace agent packages (a persona, traits including autonomy, starter skills and tasks). A template adds: a role and responsibilities written in plain words for the founder to confirm; a suggested reports-to; a heartbeat skill and how it wakes; a `NOPE.md`; a report shape; its "one useful thing" scope; and a stance on growth (when a job should become a skill, a schedule, or a new agent). Every one of these is an editable default, never a platform rule. Templates for money-facing or outsider-facing work get stricter, pre-reviewed boundaries, because the one agent built from scratch was the one that gave away a discount.

---

## 4. How a team forms

**Day one.** One person, one starter agent. The starter agent's first job is to learn the business: in the first conversations it asks what the business does and what matters this month, writes that down as a first goal, and proposes one or two roles ("Want me to take the support inbox?"). After that it is quiet until it has work. This answers Maya's "chatbot with a timer."

**The first month.** New agents arrive to answer a felt pain (a support pile, a missed goal, an unowned bug), almost always from a template, with the founder confirming a proposed role. Once there are three or more agents reporting to one person, a lead agent (or the starter agent) offers to roll their reports into one.

**Adding people.** Inviting a person sets their access level, time zone and role. Agents that will work with them are told who they are and what they own. A person who becomes someone's manager gets the "how I report" moment. A Guest scoped to two projects can direct the agents in those projects; templates keep each agent's working context to its own area, so a Guest cannot pull what an agent was never given.

**Growing.** Lead agents propose new roles from their own measures ("support is eating 60% of my beats"). Before proposing a hire, an agent asks whether a skill or a schedule would do. A manager agent is the first filter on its own reports' requests to grow.

**Agents creating agents, within trust by default.**

- An agent may create an agent that reports to itself, with no more access than its own, from a template where one fits. That is act-then-tell: the next report names the new agent, its role, its runtime and where its cost lands.
- Three cases are asks: the new agent would get money power (a card, discounts, refunds); it is built from scratch and will speak to outsiders; or the owner has said "propose first." That last one is a visible setting on the creator's profile, not a private note.
- The creator answers for the new agent in its weekly review: its cost, its kept rate, and whether it is still worth having.
- Retiring an agent keeps its record under its name and closes its cards.
- The weekly report carries one line about the team ("4 agents, 1 new this week, all within target"), and the health check (DOR-2756) flags sprawl and agents with no work.

---

## 5. Changes this makes to the guide

Carried into [`meta/PROACTIVE-AGENTS.md`](../meta/PROACTIVE-AGENTS.md) in the same pull request:

1. Reports-to rules (§3.1 above) and the away state.
2. Budgets rewritten: no caps; money on the card; giving money power is an ask; AI usage visible per beat only.
3. The heartbeat is a skill plus a beat runner, with the table above.
4. Agent types as templates, the table above, and how a team forms, including agents creating agents.
5. Rule fixes: raise once and then track; batch per person across agents; urgency means a person must act now; quiet hours protect people, never agent-to-agent work; "new information" means a change to something the agent owns or a message that names it; a manager summarises into its report, not the room; tell people before a tool tells them; dated promises, discounts and roadmap commitments to outsiders are asks; "one useful thing" is scoped by the template.
6. A note for the loop watcher (DOR-2745): a manager agent must be able to resume work its reports were doing, and room-wide beat echo must count even when nobody is mentioned.

## Gaps

- Role-play is design testing, not user evidence. Real acceptance, kept rates and annoyance come from the measures once heartbeats ship.
- All four casts were small (one to three people, two to five agents). Larger teams may need groups and a second layer of lead agents sooner.
- The scenarios assumed roadmap pieces (access levels, reports-to, tasks, virtual cards) behave as described in the litepaper.
- Found on the side: `docs/concepts/rooms.mdx` and `docs/getting-started/configuration.mdx` disagree on the default number of agent replies in a row (3 against 30). Worth a small docs fix.
