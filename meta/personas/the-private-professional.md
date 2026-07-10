# Lil — The Private Professional

**Role**: Horizon persona (staged — NOT a launch target; see Staging Rules)
**Confidence**: Grounded — modeled on a real DorkOS user (founder-adjacent; see Validation Caveat)
**Created**: 2026-07-09
**Review by**: 2027-01-09

---

## Demographics

- **Age**: 30-50
- **Role**: Middle manager at a major hospital
- **Company**: Large, regulated institution
- **Technical level**: Non-technical. No terminal, no config files by choice. Comfortable with consumer software; had help installing DorkOS
- **Tools**: DorkOS with the LifeOS Starter Kit agent from the marketplace, plus the usual consumer/work stack (email, calendar, hospital systems)

## Context

Lil runs two agents, and one of them runs her life. The LifeOS Starter Kit agent handles both sides of her world: personally, it's her advisor for life decisions, vacation planning, and household projects; professionally, it's her thought partner and her drafting help for employee reviews. She isn't building a fleet — she's living with a small, trusted staff.

What makes her a DorkOS user instead of a ChatGPT user is **the same operator mentality that defines the tribe, expressed non-technically**: she wants the thing on her machine, under her control, with her data going nowhere she didn't approve. She compared it to Claude Desktop and ChatGPT and chose the one she owns.

Her killer scenario is the sharpest privacy story in the persona set: a hospital manager drafting **employee reviews** — sensitive judgments about real people's careers — has no business typing them into a consumer chat app. "It runs on her machine" is not an ideology for Lil. It's basic professional hygiene.

## Trigger

Realizing that the tool she was about to pour her work life and personal life into is someone else's server — and that an alternative exists where it isn't.

## Jobs to Be Done

- When I face a decision (work or life), I want a thought partner that knows my full context, so that I decide better without exposing that context to a third party.
- When I write employee reviews, I want drafting help that keeps personnel details on my machine, so that I never trade my staff's privacy for convenience.
- When life admin piles up (trips, house, plans), I want one assistant that already knows my situation, so that I don't re-explain myself to a blank chat box.

## Goals

1. One trusted assistant for everything, instead of a different app per task
2. Control: her data, her machine, her rules
3. No new technical skills required after setup

## Frustrations

1. Anything that requires the terminal after initial setup
2. Consumer AI tools that want her data in exchange for memory
3. Being treated as a temporary guest in a developer's product

## Quote

"Why would I put my employees' reviews into someone else's chatbot?"

## Why This Persona Matters

Lil is live evidence for two strategic claims:

1. **The privacy story works on non-developers.** Local-first control is usually marketed as a developer ideology; Lil proves it sells as professional common sense. Her use case belongs in the trust pillar's evidence base.
2. **The marketplace absorbed the Wing vision.** Wing (the life layer) is vision-stage and forbidden from marketing — yet Lil lives the Wing use case today via a marketplace agent package. The life layer turned out to be a package, not a product module. This validates the marketplace as the expansion mechanism without new subsystems.

She is also a plausible early **Solo** subscriber in the revenue arc (`positioning-202607/11-revenue-model.md`): remote reach for someone who will never configure a tunnel is exactly what the Cloud tier monetizes.

## Staging Rules (the point of "horizon")

- **Do not target Lil in launch messaging.** The beachhead is Kai; positioning finding #10 ("no consumer broadening this phase") stands. Lil appears in no launch copy, no Show HN framing, no homepage persona language.
- **Do use Lil in product decisions** about privacy defaults, plain-language copy (`writing-for-humans`), first-run experience, and the desktop app surface — the staged surface that would actually serve her (she is a "why the desktop app exists" persona, and it's gated on DOR-155).
- **Graduation criteria**: Lil moves from horizon to secondary when (a) the desktop app is a shipped, signed, tested surface, and (b) at least one organic Lil-shaped user exists. Until both, she informs the bar and nothing else.

## Validation Caveat (read before citing this persona)

This persona is modeled on the founder's wife. She had the founder as installer, support channel, and prompt coach — scaffolding no organic user gets. Her existence proves the product _can_ serve a non-technical professional; it does not prove acquisition, self-serve setup, or unassisted recovery. Do not cite her in public copy as evidence that "anyone can use DorkOS."

## Key Assumptions to Validate

1. A Lil-shaped user can be acquired at all without a founder in her house (channel unknown — she is not on HN)
2. The desktop app closes the install gap for non-terminal users
3. "Local and yours" is a purchase driver for privacy-sensitive professionals beyond this one instance
4. The LifeOS-style marketplace package is reproducible by third-party authors (ecosystem claim, not just product claim)
