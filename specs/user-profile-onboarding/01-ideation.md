# User Profile + Onboarding — Ideation

**Id:** 260729-084310 · **Created:** 2026-07-29 · **Origin:** founder direction (DorkOS should learn who the user is) · **Builds on:** `specs/dorkbot-is-the-onboarding/` (ADR 260722-111314), coordinates with `specs/connector-completion/` (Connections page, specced separately)

## The problem

DorkOS knows a lot about the user's agents and nothing about the user. Consequences, observed:

1. **Every agent works for a stranger.** The context append (`services/runtimes/shared/agent-context.ts`) tells a session who the _agent_ is (identity, SOUL.md, NOPE.md) and what DorkOS is — but nothing about the person it works for. A recruiter's DorkBot and a game developer's DorkBot open every conversation equally blind, and each agent re-learns the user from scratch, per session, at token cost.
2. **Recommendations have nothing to stand on.** The connector gateway can connect Gmail, Slack, Notion, Greenhouse, and more; the marketplace has installable agents and skill-packs. But with zero signal about what the user does, every surface can only show the same unranked catalog to everyone. "You do hiring, so Gmail + Greenhouse" is impossible today.
3. **The one moment to ask goes unused.** Onboarding is now a scripted DorkBot conversation (arrival → personality → discovery → handoff). DorkBot asks how it should sound and whether it may look around the machine — but never asks the one question a competent new hire asks on day one: _what kind of work will we be doing together?_

## The idea

**DorkBot asks about the user's work, in conversation, for the agents' sake — and DorkOS remembers the answer locally.**

- A `profile` block in `~/.dork/config.json`: `roles` (free-form strings with a suggested canon), `tools`, optional `displayName`. Local-only. Never phoned home.
- One new beat in the scripted onboarding conversation: DorkBot asks "what kind of work will we be doing together?" with quick-pick chips + free text. The privacy promise is said in the same breath as the question, because the honest framing IS the framing: this is for your agents, not for us.
- The answer is projected into every session's agent context as a short, factual `<user_profile>` block — every runtime, via the existing shared seam. Agents finally know who they work for.
- A small pure data mapping (role → suggested connector services + marketplace search terms) that both the onboarding beat and the Connections page read. Data, not ML: a lookup table anyone can read and correct.
- Existing users (who onboarded before this beat existed) get one dismissible, non-modal, DorkBot-voiced prompt in the sidebar — once, with "don't ask again" honored via config state. No modal, no nag.

## Constraints that make it shippable

- **One beat, not a form.** Onboarding grows by exactly one beat. Chips + free text, skippable in one tap, and skipping is remembered as an answer ("asked, declined") so nobody is asked twice.
- **Token-free, like the rest of the script.** DorkBot's role question and its suggestion reply are authored lines in `@dorkos/shared/dorkbot-templates`. The suggestions come from the static mapping, not inference.
- **Local-only is structural, not a promise.** The profile lives in `config.json`; the telemetry heartbeat and usage-event payloads are strict allowlists that never carried it and a test pins that they never will.
- **Reuse over invention.** The beat rides the existing script engine and reducer; persistence rides `PATCH /api/config` deep-merge like traits and tours; the existing-user prompt rides the ProgressCard slot; injection rides the existing runtime-neutral context seam.

## Non-goals

- No account, no cloud profile, no sync. This is `~/.dork/config.json` on one machine.
- No ML inference of roles from behavior. The user says who they are, or they don't.
- No Connections-page UI. That page is `specs/connector-completion`'s; this spec only ships the shared recommendation data it reads.
- No mid-onboarding OAuth. Suggestions during onboarding are one spoken line, not a connect flow.
- No personalization of DorkBot's script copy by role in v1 (the mapping is for recommendations, not voice).

## Decision filters check

- _Describe what happens for the user:_ "Tell DorkBot what you do once, and every agent knows who it works for" — passes.
- _Every element justifies its existence:_ one beat, one config block, one card, one context block, one data table. Nothing decorative — passes.
- _Honest by design:_ the privacy fact travels with the question; skipping is one tap and permanent; nothing leaves the machine — passes.
- _Kai:_ his ten agents stop asking who he is; skippable in one tap. _Priya:_ a readable lookup table and a Zod schema, no magic. _Ikechi:_ "I'm hiring" → Gmail + Greenhouse suggested in plain words — passes.
