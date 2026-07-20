# Agent creation, reborn — specification

Status: **specified** · Founder-approved 2026-07-20 (companion artifact + defaults table, in full).
Source facts verified against the codebase 2026-07-19; file references are anchors, not
line-number promises.

## Decisions (bound)

| Decision               | Choice                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| "Blank" card           | **"Design your own"** — outcome-named, first card in the gallery                                   |
| Hello scope            | **All creations** — template agents greet + offer first action; design-your-own runs the interview |
| Faces                  | Curated emoji set v1, seeded from the template's icon; generated avatars later                     |
| Import placement       | Quiet link in the gallery **and** the palette entry stays; import leaves the creation dialog       |
| Name suggestions       | Static per-template list v1 with a reroll; model-generated later                                   |
| Dialog form            | **Fullscreen** dialog variant (modal mechanics, fullscreen presence)                               |
| Agent naming precedent | Shape-offered agents keep template names (e.g. Linear **Keeper**, registry 1.1.0)                  |

## The four moments

### M1 — Arrival (contextual entry: shape offer, marketplace agent install)

No gallery, no fork. A single confirm card: agent face + "Meet {displayName}", the job in
the agent's own voice (from the template persona), an honest ledger (what turns on, what
it needs — e.g. API key, where it lives, which runtime), primary **Create {name}**, quiet
**Customize first** (→ M3 pre-filled), **Not now** (offer stays recoverable from its
source). Acceptance: from "Set up Linear Keeper" the user reaches a created, correctly
seeded agent in one click; zero mechanism vocabulary on the screen.

### M2 — Gallery (generic entry: ⌘K, sidebar +, /agents, session tab +)

Fullscreen dialog titled "New agent" / "What will your agent do?". Cards: **Design your
own** first, then template cards reading like job listings — face, display name, what it
does, cadence/connection chips. Footer: "Already have a project folder on disk? Bring in
an existing project →". Acceptance: no card is named by mechanism; template cards show
human names (requires `displayName` on the aggregated package shape — see contract); the
three-way fork no longer exists anywhere.

### M3 — Naming (the birth)

One screen, split: left = name field (big), static themed suggestions with a 🎲 reroll,
emoji face picker (seeded from template icon), one folded **Details** row (directory,
runtime picker, live slug); right = live preview card of the agent taking shape, and the
create button labeled **"Bring {name} to life"**. Validation carries over from today's
form (slug derivation, live directory conflict states, "Import instead?" hand-off).
Acceptance: Ikechi can complete it touching only the name; Priya can reach directory,
runtime, and slug in one disclosure.

### M4 — Hello (it's alive)

On create: existing celebration plays, session opens, **the agent speaks first** — an
auto-first-turn generated from its just-written soul. Template agents introduce their job
and propose their first action (one-click, e.g. "Set up my API key" / "Do a dry run").
Design-your-own agents run **the interview**: ask what they should take care of, then
write SOUL.md live in the conversation and confirm schedule/scope questions. A quiet
birth-certificate line opens the session ("★ {name} · born {date} · lives in {path} ·
runs on {runtime}"). Acceptance: first agent utterance arrives without user input; the
interview produces a real SOUL.md the user watched being written; reduced-ceremony is
respected (`prefers-reduced-motion` for the celebration; greeting is one model turn).

## Contract changes (server + shared)

1. **Create API** (`CreateAgentOptionsSchema`, `createAgentWorkspace`): add `persona`
   (written into SOUL.md at creation), pass through `runtime` (dialog must send it),
   stop hardcoding `capabilities: []` — pass through. TSDoc + OpenAPI regen.
2. **Creation seed**: the creation store accepts `{ template, origin }` (shape offer,
   marketplace package, none). `ShapeSwitcherDialog`'s "Set up {agent}" passes the offer's
   full template. Arriving with a seed renders M1; without, M2.
3. **Schedule re-bind** (test-proven bug, filed): shape schedules created global/disabled
   re-target and enable when a matching agent appears — on agent create and on re-apply.
   The service TSDoc already promises this; make it true.
4. **`displayName` on the aggregated package shape** so M2 template cards stop showing
   raw slugs (server flatten + shared schema + client card).
5. **Skills honesty**: M1's ledger only claims "comes with its skills ready" when the
   needed packs are installed; otherwise it offers them. No per-agent skills field is
   invented — skills remain harness-synced packs.
6. **Auto-first-turn**: a creation-time kickoff — trigger the agent's first session with
   a synthetic prompt derived from origin (template greeting vs. interview). Must ride the
   existing session trigger + SSE machinery; no new transcript store.
7. **Entry unification**: onboarding's `NoAgentsFound` and the marketplace agent-package
   install ride this flow (onboarding = M2 with an import lead-in; agent-package install =
   M1). The bespoke onboarding form and its persona→description mislabel are removed.
8. **Import extraction**: import leaves the creation dialog; its flow gains a completion
   state ("N projects joined") and closes cleanly.

## Ship order (waves)

1. **Wave 1 — bugs + contract**: (Rebind) schedule re-bind; (Seed) seed carry-through +
   minimal M1 confirm + contract items 1-2. The fork must never appear from a shape offer
   again, even before the full redesign.
2. **Wave 2 — the dialog**: (Atelier) M2 + M3 + full M1, fullscreen variant, contract
   item 4; (Unify) contract items 7-8.
3. **Wave 3 — the hello**: (Hello) M4 auto-first-turn + birth certificate; (Soul) the
   interview + a `packages/evals` judgment eval guarding interview quality (asks ≤3
   questions, writes a coherent SOUL.md, proposes a sensible first action).

## Non-goals (v1)

Generated avatars; model-generated name suggestions; per-agent skills fields; opening
`sidebar.body`-style creation surfaces to third-party extensions; reworking DiscoveryView
internals beyond the completion state.
