# Jordan Wells — The Prompt Dabbler

**Role**: Anti-persona
**Confidence**: Proto-persona (assumption-based)
**Created**: 2026-02-27
**Reviewed**: 2026-07-09 (boundary redrawn: the disqualifier is operator mentality, not technical skill) · 2026-10-06 (vision reset: DorkOS Cloud is an optional hosted layer; the "never hosted" list is gone)
**Review by**: 2027-04-06

---

## Demographics

- **Age**: 25-45
- **Role**: Product manager / marketing manager / any founder who wants to rent an outcome rather than run a system
- **Company**: Any size
- **Technical level**: Beginner — uses ChatGPT/Claude.ai daily, but through web UIs only
- **Tools**: ChatGPT, Claude.ai, Notion, Google Docs, Zapier

## Why They're an Anti-Persona

Jordan wants a prettier ChatGPT. They heard "AI agents" are powerful and want one, but they expect drag-and-drop workflows, a dashboard that runs itself, and someone else to run it all. They would never own a system: install it, configure it, learn its shape, recover when it breaks. They want to rent an outcome.

**The disqualifier is operator mentality, not technical skill** _(redrawn 2026-07-09)_. Earlier versions of this persona drew the line at "non-technical," but real usage falsified that: Ikechi (`the-ai-native-founder.md`, now the primary persona) is a semi-technical founder who runs DorkOS himself precisely because he wants ownership and control. (A second grounded example, Lil, is now retired for focus; see `../archive/personas/`.) What separates him from Jordan is not what he knows, it's what he is willing to own. A manager who insists her personnel data stays on her machine is more of a dork, in the brand's sense, than a developer who pastes everything into a consumer chat app. "Dork" was never a credential; it's caring too much.

DorkOS still deliberately does not build for Jordan. A hosted option now exists, but it is not the line: DorkOS Cloud is optional, and the same program runs free on your own computer _(changed 2026-10-06)_. What stays out of scope is the mindset of renting an outcome: no promise that nothing ever needs setting up, and no product that hides how it works so nobody has to own it. Trying to serve that would compromise the design for everyone who came to run a business on their own system.

## What Jordan Wants That DorkOS Will Not Build Around

- A product that runs itself with no owner: nobody sets up agents, gives them jobs or reads what they did
- Visual workflow builders as the main way to work, instead of giving agents real jobs in plain words
- A promise that nothing will ever need configuring or recovering
- Someone else to run the system for them

_Removed 2026-10-06:_ "a hosted, no-install web app" (DorkOS Cloud is an optional hosted layer now), "plain English instead of cron syntax" and "no terminal required at any step" (plain words are a goal for every surface now, and the desktop app needs no terminal), and "customer support" (people who report problems get a real reply; see `../user-care.md`).

## Quote

"I just want to tell the AI what to do and have it happen. Why do I need to install anything?"

## Value of This Anti-Persona

When feature requests arrive for "simpler onboarding" or "no-code configuration", this persona is the filter, but apply the redrawn line. If the request would primarily serve someone who won't operate their own system (zero ownership, rented outcomes, nobody in charge of the agents), it's out of scope. If it removes a jargon wall for an operator who happens not to code (a readable error message, a plain-language doc, a desktop install path, an optional hosted setup), that serves Ikechi and is in scope. The test is never "is this user technical?" It's "will this user own it?"
