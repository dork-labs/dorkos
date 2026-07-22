# Dashboard With Hands — Ideation

**Id:** 260722-120505 · **Created:** 2026-07-22 · **Project:** DorkBot Is the Onboarding (Tier 2, DOR-418)

## Problem

The dashboard is pure observability. Every section reads state (needs-attention, promos, system status, activity feed); none takes action. A user who lands on `/` cannot start or continue a conversation from the page body: the only route into chat is the sidebar roster, which may be collapsed, and which files agents by an attention model built for mature fleets. The status row speaks internals (Relay, Mesh, adapters) that mean nothing to a new operator. Tier 0 added a stopgap "New conversation" header button; the dashboard body itself still has no hands.

## Idea

Mission control **with hands**: the dashboard's first section is a composer ("What are we building today?") that starts a real session with your default agent, followed by messageable agent cards, with system status translated into human outcomes. Observability stays; it just stops being the whole story.

- **Composer first.** Type, hit enter, and you're in a live session with the message already sent (the `first-message` seam from ADR 260722-111316). The dashboard becomes the same question DorkBot asks at the end of onboarding: what are we building today?
- **Agents you can touch.** A "Your agents" section of cards: avatar, name, a one-line human status ("New", "Working on X", "Resting since Tuesday"), and click-to-chat. A fresh install shows DorkBot's card front and center.
- **Status in outcomes, not internals.** "Relay: 1 adapter / claude-code" becomes "Connected to Claude Code". "Tasks: 0 schedules" becomes "Nothing scheduled yet". Same data, operator language.

## Non-goals

- No dashboard redesign: sections, slots, and priorities stay; this adds one section, upgrades another, and rewords a third.
- No multi-agent composer routing UI beyond a simple default-agent target (a future refinement can add an agent switcher).
- The sidebar is untouched (Tier 0 already fixed the fresh-agent burial).

## Fit

Kai gets a faster path into any agent from the page he lands on. Ikechi gets a dashboard that speaks his language. The composer reuses the exact mechanism onboarding's dissolve uses, so the first-run muscle memory ("type here, agent responds") carries straight into daily use.
