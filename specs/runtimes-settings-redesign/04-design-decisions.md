---
design-session: .dork/visual-companion/9035-1785779428
date: 2026-08-03
participants: operator (Dorian) + orchestrator
---

# Design Decisions — Runtimes settings redesign (per-runtime cards)

Operator-approved design session. The Runtimes settings tab is restructured
around two operator-stated principles: **(1) every setting that belongs to a
runtime lives on that runtime's card** — including the default-runtime choice,
which becomes a state of a card rather than a dropdown — and **(2) runtime
settings options are declared by the runtime**, not hardcoded per-runtime in the
client. Mockups live in the session directory named in frontmatter.

## Grounding: what the code says today

- The tab (`apps/client/.../tabs/RuntimesTab.tsx`) stacks five components:
  intro paragraph, `RuntimeSetupPanel` (three ready/connect cards),
  `ExecutionDefaultsCard` (default runtime + model + effort dropdowns + trust
  section), `ExecutionExceptionsStrip`, `ClaudeAccountsCard`.
- **Capability hole:** model/effort defaults are only editable for whichever
  runtime is currently the default — `executionDefaults.perRuntime[]` stores
  them for every runtime, but the UI renders only the chosen one. Setting
  Codex's default model requires first making Codex the default.
- Already runtime-declared (keep, build on): readiness + connect kind
  (`install`/`login`/`provider-picker`), dependency checks + install hints,
  model catalog per runtime (`ModelOption.supportsEffort` /
  `supportedEffortLevels`), permission modes (`RuntimeCapabilities.permissionModes`).
- Hardcoded in the client (to be replaced by runtime-declared equivalents):
  `configSectionForRuntime()`'s hand-kept runtime→config-key map; the
  Claude-only `ClaudeAccountsCard` bolted onto the tab; descriptor fallback
  install commands (acceptable fallback — server hints win).
- Runtime logos exist and are used (`@dorkos/icons/adapter-logos`) but at 16px
  `currentColor`; each descriptor's accent color is unused on this page.

## 1. Page structure: one card per runtime, default as a state

**Screen:** `01-structure.html` · **Options:** A per-runtime cards ·
B alternative structures first · **Chosen: A.**

- One card per runtime (Claude Code, Codex, OpenCode, plus any future
  registered runtime via the descriptor fallback).
- Card header: logo tile tinted with the runtime's accent color, name, one-line
  identity subtitle, readiness (`● Ready` / `Connect` button), and the default
  marker: an accent **"Default" pill** on the default runtime's card, a quiet
  **"Make default"** text affordance on the others. The default card carries a
  subtle accent border ring.
- The old "Runtime" default dropdown, the bottom-of-page `ClaudeAccountsCard`,
  and the model/effort rows of `ExecutionDefaultsCard` are all absorbed into
  the cards. Nothing Claude-specific remains at the tab level.
- A not-ready runtime shows Connect only; its settings unlock after connecting
  ("One sign-in away. Settings unlock once it's connected.").
- Below the cards: the global trust row (§3), then the exceptions strip
  (unchanged behavior — broken first, rows link to the agent's Config tab).
- The intro paragraph shrinks to one line; "Check again" shrinks to a small
  refresh icon in the header area (maintenance action, not primary).

## 2. Card anatomy: fixed skeleton + runtime-declared sections

**Screen:** `02-card-anatomy.html` · **Chosen: as rendered** (Claude Code and
OpenCode shown expanded side by side).

Expanded card body, in order:

1. **Model** — select over the runtime's live catalog, with "Runtime's choice"
   as the inherit option.
2. **Effort** — segmented control (Low/Medium/High/Max) filtered by the
   selected model's `supportedEffortLevels`; renders honest muted text when the
   runtime or model doesn't take effort ("Not supported by OpenCode" /
   "<model> doesn't take an effort setting" with one-tap clear of a stranded
   saved value).
3. **Where it stops for you** — per-runtime trust override; reads "Global
   setting" until overridden. Full-autonomy consent dialog unchanged
   (server-enforced acknowledgement, same request carries ack + stop).
4. **Runtime-declared sections** (boxed sub-sections): Claude Code declares
   **Billing account** (account list, in-use marker, add/remove — the whole
   `ClaudeAccountsCard` feature, relocated); OpenCode declares **Power source**
   (current provider + Change → provider picker); Codex declares none.
5. **Setup details** — collapsed disclosure, unchanged content (dependency
   rows, install hints, transparency note).

Ready-state affordances survive: quiet "Fix sign-in" (Claude/Codex) and
"Change" (OpenCode) next to the Ready badge.

**Principle 2 mechanism:** the card skeleton is fixed; the boxed sections are
declared by the runtime and rendered by feature-injected renderers keyed on the
declared kind — the same pattern `renderConnect` already uses for
`login`/`provider-picker`. The `AgentRuntime`/`RuntimeCapabilities` surface
grows a declaration for settings sections (e.g. Claude declares an
`accounts`-kind section, OpenCode a `power-source`-kind section) plus whatever
is needed to retire the client's hand-kept `configSectionForRuntime()` map.
Genuinely bespoke UI stays in client features, but _which_ sections exist comes
from the runtime.

## 3. Global trust: one quiet row beneath the cards

**Screen:** `02-card-anatomy.html` (question) · **Options:** A global row
beneath cards · B per-card only · C global moves to Security tab ·
**Chosen: A.**

"Where agents stop for you" renders once, beneath the three cards, as a
segmented control (Asks before acting / Pauses at big steps / Full autonomy)
with the hint "Every runtime follows this unless its card says otherwise."
Semantics identical to today's `DefaultTrustStopSection` global dial; per-card
rows are the overrides. Set-time-is-consent-time is preserved.

**Addendum (2026-08-03, P2 adversarial review):** the row ships as "Where new
conversations stop for you", not the wording above. DOR-853's D0 invariant
reserves the bare word "agent" for a named teammate in the fleet, and this
setting governs neither a teammate nor a fleet: it sets where a new
conversation starts on the trust dial, whichever runtime it lands on. The
newer vocabulary invariant outranks the older local design copy. Everything
else in this decision (placement, the three stops, the hint line, the
overrides, the consent contract) is unchanged.

## 4. Disclosure model: all collapsed, summary lines do the talking

**Screen:** `03-disclosure.html` · **Options:** A all collapsed · B default
card pre-opened · C always open · **Chosen: A.**

- At rest, every card is header + **summary line**: "Starts with **Opus 4.6** ·
  **High effort** · **Asks first** · billing **Personal**". The page reads as a
  status board; the summary answers "what will a new conversation do?" with
  zero clicks.
- Clicking the card (header/summary) expands it in place; cards expand
  independently (no accordion auto-close); collapse restores the summary.
- Summary segments render only what's real: inherit shows "Runtime's choice";
  a runtime with no accounts/provider shows no such segment; a not-ready card
  shows "One sign-in away." instead of a summary.

## 5. Edge states: said, not hidden (carried forward)

**Screen:** `02-card-anatomy.html` edge row · **Chosen: all three as rendered.**

- **Default but not connected:** the card keeps its Default pill AND shows the
  warning + Connect together ("Your default runtime isn't connected — new
  conversations can't start here."). The problem and the setting share a card.
- **Saved model no longer offered:** still listed/selectable, labeled
  "(no longer offered)" — never silently swapped.
- **Effort saved but model ignores it:** amber "…is saved here and does
  nothing — clear it" with one-tap clear; the row never disappears.
- Unknown/future runtimes degrade to the generic descriptor card.
- Half-loaded capability map: sections render optional-all-the-way-down, as
  today.

## 6. Mobile: inline expansion, no drawer

**Screen:** `04-final-composite.html` · **Chosen: approved** (operator
delegated the drawer decision; orchestrator chose inline, operator approved).

- Cards stack full-width and expand **inline** — no drawer. Rationale: the
  Settings surface on mobile is already a full-screen drill-in, so a drawer
  here is a sheet-inside-a-sheet; card bodies are short (3–5 rows at 390px);
  surrounding cards keep context visible.
- Mobile compressions: summary line shortens and wraps (status chips never
  wrap); redundant "Ready" text drops where the pill/Connect already implies
  it; **"Make default" moves into the expanded body** (no room for a quiet
  header affordance); global trust row stacks its segmented control full-width.
- Connect flows keep rendering inline in the card at all sizes.

## 7. Playground parity (hard requirement)

The current `ExecutionDefaultsCard` and `ExecutionExceptionsStrip` are absent
from the dev playground because they are hook-coupled with no prop injection.
The replacement components are built **props-first / presentational** (like
`RuntimeSetupPanel`, which is showcaseable for exactly this reason) with thin
hook-wired containers. Every state mocked in this session — collapsed, expanded,
ready, connect, default, default-but-broken, model-gone, effort-ignored,
declared-sections variants, mobile — ships as a playground showcase with section
registry entries, replacing the two coverage gaps.

## Final Design Summary

Settings → Runtimes becomes: one line of intro; three (or more) runtime cards,
each carrying the runtime's full identity (accent-tinted logo, name, subtitle),
its readiness/connect state, its default marker, and — expanded — its model,
effort, trust override, runtime-declared sections (Claude accounts, OpenCode
power source), and setup details; then a single global "Where agents stop for
you" row; then the read-only exceptions strip. All cards collapsed by default
behind one-line "Starts with …" summaries. The default runtime is chosen by
"Make default" on a card and shown as an accent pill + ring. Per-runtime
model/effort are editable for every runtime at all times (closing today's
capability hole). The `AgentRuntime` interface grows a settings-section
declaration so the tab renders whatever a runtime declares, retiring the
hardcoded Claude accounts placement and the client's runtime→config-section
map. Components are presentational-first with full playground showcases.
Retired: `ExecutionDefaultsCard` (its trust section survives as the global row

- per-card overrides), `ClaudeAccountsCard` (absorbed into the Claude card),
  the "Runtime" default dropdown. Unchanged: exceptions strip behavior, connect
  flows, autonomy consent, all honesty edge-state copy.
