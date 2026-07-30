---
design-session: .dork/visual-companion/43322-1785446167
date: 2026-07-30
participants: operator (Dorian) + orchestrator
research: two grounding audits ran during the session — the field/plumbing inventory
  and the onboarding/auto-set audit (findings inlined below; the OpenCode effort
  verdict has its own subsection)
---

# Design Decisions — execution defaults (runtime · model · effort)

Operator-approved design session: the server and each agent get settable defaults
for runtime, model, and effort, with inheritance (agent explicit → server default
→ built-in) and provenance visible everywhere. Every decision below was chosen by
the operator against rendered alternatives; the mockups live in the session
directory in frontmatter.

## 1. Architecture: in context, plus an exceptions overview

**Screen:** `defaults-architecture.html` · **Options:** A in-context editing ·
B dedicated fleet matrix · C = A + exceptions overview · **Chosen: C.**

Server defaults live in a new **Defaults card** on Settings → Runtimes (the first
UI `runtimes.default` has ever had). Per-agent overrides live in the Agent Hub
**Config** tab, where the runtime dropdown already lives. Under the Defaults card
sits a compact read-only **exceptions strip** (see §5). No new navigation
destination.

## 2. Per-agent composition: three inline rows

**Screen:** `controls-and-chips.html` · **Options:** A three rows with inline
controls · B one summary row opening the shared popover · **Chosen: A**
(operator overrode the orchestrator's B lean).

The Config tab shows **Runtime, Model, Effort as three separate rows**, each with
its own control and its own provenance chip. Effort renders as an inline segmented
control when the selected model supports it, and as muted truth-text when it
doesn't (§4). The rows consume the same data the status-bar popover consumes
(`GET /api/models?runtime=…`, `ModelOption.supportsEffort` /
`supportedEffortLevels`) — shared data source, per-surface composition.

## 3. Approved behaviors (and two explicit declines)

**Screen:** `controls-and-chips.html` behaviors list · **Chosen: 1, 3, 4, 7.**

1. **The chip is the reset.** Every row wears "server default · X" or "set here";
   clicking a "set here" chip offers exactly one action — "Use server default
   (currently X)". The chip morph is a 120ms crossfade with the spring settle from
   the messaging motion set.
2. **Honest timing, progressively disclosed.** After any change: "Applies to new
   conversations — running ones keep their settings," appearing only once
   something changed. **Live-apply is part of the build**: the config-change
   subscription primitive does not exist and gets built, so the server default
   applies without a restart. Shipping a settings UI over a restart-required field
   was judged a quiet lie.
3. **The pre-launch gap closes.** Today model/effort cannot be chosen before a
   session's first message (the popover is disabled — "Send a message first").
   The same picker becomes available pre-launch, seeding the session at creation.
4. **Unsupported means said, not hidden.** OpenCode renders "Not supported by
   OpenCode"; a model without effort support says so; an inherited value that the
   agent's runtime/model cannot honor shows a soft warning chip. Nothing silently
   disappears.

**Considered and declined by the operator** (recorded so they are not reopened as
oversights): the ripple count ("affects N inheriting agents") on server-default
changes; **operator-only write policy** for the three defaults (they remain
`agent-writable`, matching `runtimes.default` today); **locking DorkBot to
inherit** (the system agent's execution settings remain editable).

## 4. Effort semantics — the verified ground

- The normalized enum already exists (`EffortLevelSchema`:
  `none·minimal·low·medium·high·max·xhigh`) and is exactly OpenAI's six variants
  ∪ Anthropic's `max`. Reuse; never fork.
- **claude-code**: full support via thinking config; **codex**: full support via
  thread options; the two adapters' `none`/`minimal` clamps deliberately differ —
  a shared default makes that visible, so the build documents the mapping at the
  clamp sites.
- **OpenCode: verified unsupported at the API.** The prompt body is seven fields,
  none effort-shaped, in both the pinned and current SDK; effort exists only as
  config-file variants with no API selection. So "Not supported by OpenCode" is
  literal truth, **and the adapter's dead effort plumbing (persisted, threaded,
  echoed, dropped) gets removed or documented as reserved** in the build.
- Operator's standing principle: effort is settable wherever the runtime can
  honor it for at least some models, with per-model truth labels — "works
  sometimes" is labeled, never blanket-hidden.

## 5. The exceptions strip: deviations + broken, and the Needs-attention bridge

**Screen:** `exceptions-and-mobile.html` Q1 · **Options:** A broken-only ·
B deviations + broken · **Chosen: B, plus an operator addition.**

The strip lists every agent that differs from the server defaults — broken rows
first in warning color (runtime not connected, model no longer offered, effort
set where unsupported), healthy deviations after ("effort xHigh", "model
Sonnet"). A fleet where everything inherits shows nothing. Clicking a row opens
that agent's Config tab.

**Operator addition (hard requirement): broken execution configs also qualify
the agent for the sidebar's "Needs attention" smart group** — the same concept
sessions already use (`dashboard-sidebar`'s All / Active / Needs attention
filter). Breakage surfaces where attention already lives, not only in Settings.

## 6. Mobile: rows push a bottom drawer

**Screen:** `exceptions-and-mobile.html` Q2 · **Chosen: A.**

The three rows keep the iOS-settings idiom; tapping one opens the vaul drawer the
app already uses everywhere, with the option list and the reset-to-inherit line
("Using server default: Opus — tap to restore") at the drawer's foot. Provenance
moves into the row's value color on narrow screens (green inherited / amber set
here).

## 7. Onboarding and auto-set (decided after a dedicated audit)

Onboarding's requirements stage already detects per-runtime readiness and offers
the connect flows; it never touches the default, and the first DorkBot session
**hardcodes `claude-code` twice** (`OnboardingConversation.tsx:108,195`).
Auto-set has clean precedent (`maybeSetDefaultAgent`) but one blocking
constraint: `getDefault()` is assumed Claude-shaped (the relay `AdapterManager`
cast + four route fallbacks; the registry TSDoc calls a non-Claude default
"technically possible but unsupported").

**Decided sequence:**

1. **This build**: the Defaults card is the first UI for `runtimes.default`; the
   two hardcoded onboarding literals are fixed so the first session respects the
   default. No auto-set.
2. **Prerequisite ticket**: de-Claude-shape `getDefault()` (relay cast + the
   four route fallbacks).
3. **Then**: post-requirements-step auto-set to the ready runtime (never at boot
   — readiness changes during onboarding), with the existing "Claude Code is
   connected." sentence becoming the disclosure plus a one-tap change.

## 8. The build's load-bearing seams (from the inventory audit)

- **Inheritance resolver**: extend `resolveRuntimeTypeForNewSession`
  (`routes/sessions.ts`) into `resolveSessionDefaults`, seeding
  `session_metadata.model/effort` at first-write — one change; all three
  adapters' existing `persisted → runtime default` chains inherit it unchanged.
- **Server default model is per-runtime** (model ids are runtime-namespaced;
  OpenCode's are `provider/model`). New config leaves under `runtimes.*` run the
  full 9-step adding-config-fields lifecycle + the three exhaustiveness tables
  (disclosure, write-policy, safe-defaults).
- **Agent manifest gains `model` and `effort`** (schema, create/update surfaces,
  derived cache if list views need them). Validity when the agent's
  runtime/model can't honor them renders as §3.4's warning chip, not a write
  refusal.
- **Rooms are the biggest beneficiary**: room turns currently have no model/effort
  path at all — the per-agent default is their only lever. The room turn runner
  picks up seeded settings through the same first-write seam. Interacts with the
  session-identity defects DOR-763/DOR-764, which should land first or together.
- **Live-apply**: build the ConfigManager change-subscription primitive and
  re-apply the default runtime on change; model/effort defaults are read-at-use
  so they need no re-application machinery.
- Unvalidated `effort` strings read from the DB get hardened through
  `EffortLevelSchema` while in there (known latent gap).

## Build order

1. **E1 — server foundations**: config fields (per-runtime default model,
   default effort), write-policy/disclosure/safe-defaults rows, the
   change-subscription primitive + live-apply for `runtimes.default`, the
   `resolveSessionDefaults` first-write seam, DB effort hardening.
2. **E2 — agent manifest fields** (model/effort) + API surfaces; room turns
   inherit through the seam; the OpenCode dead-plumbing cleanup rides here.
3. **E3 — client**: Defaults card + exceptions strip + Needs-attention bridge;
   the three Config rows with chips; the pre-launch picker enablement; mobile
   drawers; the onboarding literal fix.
4. **E4 (separate, prerequisite for auto-set)**: de-Claude-shape `getDefault()`.
5. **E5 (after E4)**: post-onboarding auto-set with disclosure.

E1/E2 are server-only and can overlap the messaging-programme client work; E3
touches Settings + Agent Hub + status bar (no room-view collision).
