# One-minute onboarding and automatic model choice — ideation

**Linear:** DOR-2783 (DorkOS-first onboarding, up and running in under one minute) and DOR-2784 (automatic model choice, with the model hidden in the status bar by default). Parent: DOR-2735. Both waited on Doe (DOR-2786, DOR-2787), which is merged.

**Sources:** `research/20261007_one-minute-onboarding.md` (the audit and the design this builds), `research/20261007_dorkos-runtime.md` (the engine, §4.3 model routing), `meta/PRINCIPLES.md` §5, `plans/2026-10-vision-reset-decisions.md` §22 and §25, and Dorian's comment on DOR-2783 (2026-10-07).

## The problem

A new person who has no Claude, ChatGPT or OpenRouter account cannot get an agent to reply. Today's first run is runtime-first: a requirements scan names Claude Code, Codex and OpenCode, credits appear only inside one runtime's card, linking a DorkOS account takes a typed code and an email check, and a six-beat scripted chat follows. It takes 4 to 8 minutes from the first screen to a first reply. With Doe merged, the pieces for a DorkOS-first path exist; the order and the words are wrong, and Doe cannot run at all until a person types a model id, endpoint and context window.

## Decisions already made (not reopened here)

| #   | Decision                                                                                                                                                     | Who, when                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 1   | Path: install, "Continue with DorkOS" (Google/GitHub sign-in), add a card, land in #team where DorkBot offers the first mini app                             | Dorian, 2026-10-07         |
| 2   | The account is the default and can be skipped; free local use stays true                                                                                     | Dorian, 2026-10-07         |
| 3   | No free starter credits; a card is required for DorkOS's own AI                                                                                              | Dorian, 2026-10-07         |
| 4   | Paid plans are US-only and 18+ at launch, so the card path is US-only. "Use my own AI key or sign-in" is a launch item, the real first run for everyone else | Dorian, DOR-2783 comment   |
| 5   | No runtime, model or vendor names during setup; the app says "Runs on: DorkOS", never "Doe"                                                                  | PRINCIPLES §5, VOICE       |
| 6   | DorkOS picks the model; change it in Settings and from a status-bar item hidden by default but pinnable                                                      | Dorian, 2026-10-07         |
| 7   | Card is taken on the same dorkos.ai page as sign-in, before approval completes (one browser visit)                                                           | research §10.1 recommended |
| 8   | Onboarding lands in #team with a server-posted DorkBot welcome                                                                                               | research §10.3 recommended |

## Options weighed

**Where the DorkBot welcome lives.** (A) A real room message the server posts as DorkBot: durable, visible on every device, part of the room's history. (B) A client-only card above the room. **Pick A.** Room messages render widgets read-only (`render-room-body.tsx`), so the chips are a client-side strip under the welcome, shown only while the person has not posted in #team yet.

**How Doe gets a model with no setup.** (A) Seed `runtimes.doe.inference` with a fixed model at install. (B) Leave `inference: null` to mean "chosen by DorkOS" and resolve at the first turn of each chat from the credits catalog's `recommendedOn`. **Pick B.** It needs no model name in app code, it follows the catalog as Cloud changes it, and `null` already means "nothing chosen" in the schema. Own key and local keep explicit settings, but the form fills them from a small table of known services so a person enters only a key.

**When new work switches to Doe.** (A) Change the schema default `runtimes.default` to `doe`. (B) Switch only when the person picks a DorkOS path in the first run. **Pick B.** A schema default flip touches upgrades through the twice-declared defaults trap; a pick in the first run is the person's choice the money rule asks for (ADR 261001-000811), and existing installs never move.

**The power step.** Dropped from the first run. The moments rail and Control Center keep the door; trust by default (DOR-2738) removes the question later.

**DecisionModel ladder for model choice.** Not on the launch path (runtime report §4.3): it returns labels, adds a call before every turn, and needs usage to tune against. Auto-pick is per chat, from the catalog.

## Out of scope

Optional bundled vendor binaries and the desktop splash (research §7, install time, separate ticket), model tiers in the catalog (cut line), the docs rewrite (after it works, demo-claim gate), and the per-turn router.
