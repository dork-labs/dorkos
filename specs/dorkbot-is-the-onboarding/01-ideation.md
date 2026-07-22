# DorkBot Is the Onboarding — Ideation

**Id:** 260722-110713 · **Created:** 2026-07-22 · **Project:** DorkBot Is the Onboarding (Linear) · **Origin:** founder walkthrough of a fresh Docker install, 2026-07-22

## The problem, observed live

A fresh-install walkthrough (browser, pristine container) found that the onboarding flow's designed ending — landing in a live DorkBot session with a personalized greeting — is unreachable for almost everyone:

1. The finish screen unmounts itself (config-refetch race) before the "Start your first session" CTA can be clicked. Users land on the dashboard instead.
2. The dashboard buries the protagonist: a zero-activity DorkBot is filed under a collapsed "1 inactive agent" row; the /agents page labels it "Stale" / last seen "Never" minutes after the user picked its personality.
3. The dashboard has zero conversation affordance: every section is observability; the Getting Started card offers only fleet-building rows.
4. Discovery silently skips on zero candidates; the user can't tell it ever ran.

Beyond the bugs, the deeper critique: onboarding is **screens about DorkBot** followed by a hand-off that fails. The product's promise is directing agents; the first run should deliver that promise, not configure software.

## The idea

**DorkBot is not a step in the onboarding. DorkBot IS the onboarding.**

After the ready gate, no more forms. DorkBot _arrives_ (the FirstLight newborn treatment: face, name, soft pulse) and speaks. Everything that used to be a screen becomes a beat in one conversation:

- **Personality** is an inline widget in the chat (preset chips + radar). Tuning it changes the voice of DorkBot's _next scripted message_, audibly. Show, don't tell. The standalone Meet DorkBot screen is deleted.
- **Discovery** is a consent moment in dialogue: "Want me to look around for projects and agents you already have?" Results return as cards in the conversation; zero results gets an honest sentence, never silence.
- **The ending is deleted.** There is no finish screen. The conversation's last beat is DorkBot asking "What are we building today?" over a real composer. The user's first real message completes onboarding as a side effect, navigates into a real session, and auto-sends that message. Onboarding dissolves into use.

## Constraints that make it shippable

- **Token-free shell.** All DorkBot speech in the scripted conversation is client-generated (the existing `dorkbotFirstMessage` mechanism proves the pattern). Real inference starts only with the user's first real message. Nobody pays tokens to watch a tour, and the flow works before any runtime has spent a cent.
- **Reuse over invention.** Message bubbles, composer, FirstLight, PersonalityPicker, the discovery store and candidate cards, the agent-birth kickoff mechanism — all exist. Tier 1 is mostly recomposition.
- **The ready gate stays.** "You're ready / Claude Code is connected" (with the one-click connect disclosure) remains the pre-conversation gate; a conversation that can't dissolve into a real session is a dead end.
- **Skip stays honest.** "Skip setup" remains one click away and keeps its dismiss semantics.

## Tiers (working backwards from the ideal)

- **Tier 0 (DOR-416, bug-level, independent):** latch the finish screen against the unmount race; never-active agents present as new, not dead; "Talk to DorkBot" + dashboard conversation CTA; bound the confetti. Ships regardless of the rest.
- **Tier 1 (DOR-417, this spec's core):** the scripted DorkBot conversation replacing Meet-DorkBot + finish screens.
- **Tier 2 (DOR-418):** dashboard with hands — composer front and center, messageable agent cards, status in human outcomes.
- **Tier 3 (DOR-419):** the living tour — DorkBot walks real surfaces (deep-link + spotlight) as topics come up; Tasks/Relay/Mesh earn their names on first genuine use.

## Non-goals

- No server-side onboarding state machine; the script lives in the client.
- No LLM-generated onboarding copy; the script is authored, deterministic, and personality-inflected by template.
- No re-run of the conversation for existing users (Replay setup keeps whatever flow exists at the time).
- Telemetry consent stays in its existing banner (independent, already server-gated); DorkBot does not negotiate privacy.

## Decision filters check

- _Describe what happens for the user_: "DorkBot introduces itself and sets itself up with you" — passes.
- _Every element justifies its existence_: deletes two screens and a progress bar; net-negative surface area — passes.
- _Kai_: faster to a working session, skippable in one click. _Priya_: no magic, a readable script state machine, no tokens burned — passes.
