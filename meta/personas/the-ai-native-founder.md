# Ikechi: The Founder

**Role**: Primary persona _(promoted 2026-10-06; was secondary)_
**Confidence**: Partly grounded. The core is modeled on a real DorkOS user (a close contact, not an organic one; see Evidence Limits). The broader "builds a big business with agents" shape is the 2026-10 target and is still assumption-based.
**Created**: 2026-07-09
**Rewritten**: 2026-10-06 (vision reset, `../positioning-202610/00-overview.md`)
**Review by**: 2027-04-06

---

## Demographics

- **Age**: 25-45
- **Role**: Founder. Often a serial entrepreneur, sometimes running more than one business at once
- **Company**: A small team of people plus many agents, aiming at a business far bigger than its headcount. Think of a YC company where most of the work is done by agents
- **Technical level**: Semi-technical and T-shaped. Deep in one area (product, sales, design, an industry), broad enough everywhere else to follow install steps, edit a setting, read what an agent did and ask good questions. Does not need to read source code, and does not want to be told that he should
- **Tools**: DorkOS, plus whatever the business runs on: Gmail, a calendar, a payments tool, accounting, social accounts, a site builder he is replacing with agent-built apps

## Context

Ikechi has a strong vision and strong taste, and more ideas than hours. He builds products and runs operations by directing agents: one agent writes the app, another drafts the investor update, another works the support inbox, another keeps the books in order. He treats agents as co-workers and co-creators, not as assistants or a chat box he types into. He sets the goals; each agent has a job and works toward them.

He wants **the tools his business needs without buying or building software**: he asks for a dashboard or a tracker, and his agents build it inside DorkOS (mini apps). He wants a product **made for founders**, not a general-purpose chat app, and a system he **owns**: his computer, his files, his own AI plan. The chat workspace (DMs, channels and threads with his people and agents, and agents acting in the outside tools the business depends on) is what he expects as a given, not why he chose DorkOS. He wants to trust his agents the way he trusts a good hire, and to be able to check the record when something looks off.

He is a **power user without being a programmer**. What separates him from the anti-persona (`the-prompt-dabbler.md`) is not skill, it is **operator mentality**: he wants to own and run his system, and he will climb whatever learning curve that takes.

DorkOS is load-bearing for him in a way it is not for Kai. Kai could approximate parts of DorkOS with tmux and shell scripts. Ikechi cannot. Without a workspace that holds his people, his agents and his tools together, he has no access to this way of working at all.

## Trigger

A piece of the business that would once have meant hiring: a new app, a support function, a sales process, a back office. Weeks of recruiting and real money before anything happens. Instead he opens DorkOS, gives the work to an agent, and starts directing.

## The Worst Day

An agent hit an error in the middle of a job and the message was a stack trace. Ikechi does not read stack traces. The work stalled, he could not tell whether his instructions, the agent or the tool was at fault, and he lost an afternoon to something Kai would have recognized in five seconds. Cryptic errors, dead ends, and docs that assume a developer's vocabulary are each a wall for him, not a speed bump.

The second-worst day: not knowing what an agent did in an outside account (an email sent, a record changed) and having no easy place to look.

## Jobs to Be Done

- When part of the business needs doing, I want to hand it to an agent the way I would hand it to a colleague, so that the business grows without hiring for every function.
- When I am thinking through a decision, I want a thought partner that knows this business's context, so that I reason better and faster.
- When work should recur (reports, follow-ups, content, checks), I want to schedule it and forget it, so that the business runs without me pushing every task.
- When agents act in Gmail or other outside tools, I want to see what they did and step in when I need to, so that I can trust them with real work.
- When the business needs a tool nobody sells (a dashboard, a tracker, a page for one odd job), I want to ask my agents for it and have it open inside DorkOS, so that I get the tool without hiring a developer.
- When I need a capability I do not have, I want to install it, so that I extend the system without writing code.

## Goals

1. Build a business far bigger than its headcount
2. Set the goals and let co-workers, people and agents, own the work toward them
3. Ask for the tools the business needs and have agents build them; let agents work the business's real tools
4. Trust agents with real work, with a record to check instead of a permission prompt for every step
5. Compound capability over time: every agent set up and every skill installed makes the next job faster

## Frustrations

1. Error messages and docs written for developers: jargon walls in an otherwise navigable product
2. Not knowing whether a stuck agent is his mistake, the agent's, or the tool's
3. Tools that treat agents as suspects and make him approve every small step
4. Tools that treat "not a developer" as "wants less power"
5. Juggling a separate app for each kind of work, none of which knows about the others

## Quote

"I'm not a developer. I run a business, and my agents do most of the work."

## What He Brags About

- "We launched that in a weekend, with no dev team"
- The size of his team, people and agents, and what each one owns
- Speed from idea to something live
- Doing with a monthly AI budget what used to take a payroll

## Fears & Objections

- "If something breaks, can I fix it without knowing how to code?" (recoverability)
- "Is what the agent built or sent actually right? I cannot check the code myself" (verification without expertise)
- "Will I hit a wall where this only works with a real developer?" (ceiling anxiety)
- "What did the agent do in my email while I was away?" (visibility)

## Buying Triggers

- Seeing a founder like him run real parts of a business on it
- One agent taking a whole job off his plate in the first week
- Word of mouth from other founders, not from developer channels

## Anti-Adoption Signals

- If setup or recovery requires reading code
- If the first failure produces a message he cannot act on
- If the product makes him babysit agents instead of working with them
- If the community treats non-developers as tourists

## Why This Persona Matters

Ikechi is who DorkOS is built for first. He is the standing test reader for the plain-language register (`writing-for-humans`): error messages, onboarding, docs and recovery paths must survive him. Meeting that bar helps every persona. Kai forgives a cryptic error, but he does not prefer one.

**Boundary.** Ikechi is semi-technical, not anti-technical. He does not justify visual workflow builders or a product that hides how it works. He chose a system he owns: it runs on his own computer for free, and DorkOS Cloud is an option he can take or leave.

## Evidence Limits (read before citing this persona)

The core of this persona is modeled on a real user who is a close contact rather than an organic one. He had live install help and prompt coaching from someone on the project, which no organic user gets. That limits what his case proves, not what he can do: it shows a semi-technical founder **can** run real work through DorkOS, and does not yet show one can do it unassisted. The 2026-10 broadening (a YC-style founder building a large business mostly with agents) is the target audience, not yet an observed user. The validation milestone is the first founder we have never met running part of a real business on DorkOS. Record what stops them.

## Key Assumptions to Validate

1. A semi-technical founder can install DorkOS and get to a first useful agent without a person helping
2. Error and recovery paths are survivable without reading code
3. Founders want to talk to people and agents in one workspace, rather than keep agents in a separate tool
4. A readable record of what agents did is enough for a founder to trust them with outside accounts
5. The marketplace is discoverable and trustworthy to someone who cannot audit a package
6. Founders want their agents to build the tools the business needs (mini apps), and will approve running them
