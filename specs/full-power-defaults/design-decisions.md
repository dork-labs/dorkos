# Design Decisions

Visual companion session: `.dork/visual-companion/63891-1787441390/` (mockup HTML preserved in `content/`).

Decisions 1 was made by Dorian interactively on 2026-08-22. Dorian then stepped away and explicitly delegated every remaining decision ("please make the remaining decisions yourself... You have my permission to make all necessary decisions"). Decisions 2–6 were made by the agent under that delegation and are flagged accordingly; each records its reasoning so Dorian can overrule any of them cheaply.

## 1. Program scope — which locks open

**Screen:** `01-findings-map.html`
**Options:** Six candidate flips (multi-select): ① autonomy as default trust level, ② open mesh, ③ standing grants, ④ warm agents + scheduler concurrency, ⑤ unattended surfaces follow operator power level, ⑥ adapter canInitiate. Plus a stay-locked list (extension execution approval, network exposure guards, marketplace clamp, telemetry defaults, TTL ceiling).
**Chosen (Dorian):** **All six flips.** The stay-locked list was not contested and stands.

## 2. Nothing flips silently (the A1 invariant)

**Delegated decision.** "Full power by default" is implemented as: the recommended, pre-selected, one-click path leads to full power. Consent-gated capabilities (autonomy default, open mesh, standing grants, unattended power, canInitiate) are written by the consent door's **accept** — for new users at onboarding, for existing users via the modal. They are never flipped by a schema default or a config migration. Two safety-neutral settings (`runtimes.claudeCode.persistentSession`, `scheduler.maxConcurrentRuns` 1→4) flip as plain defaults.

**Why:** the server already refuses autonomy without a recorded acknowledgment (`428 AUTONOMY_ACK_REQUIRED`); the safe-defaults ADR (260727-181825, "absence is not consent") is a build-enforced posture, not a preference; and a silent flip would be the one thing that makes "unleash the Kraken" read as reckless instead of confident. Decline ("Keep asking me first") is a first-class, no-shame path that records the answer and never re-asks.

## 3. The consent shape — one door

**Screen:** `02-consent-shape.html`
**Options:** A) One door — single modal, one green "Unlock full power" button, "Customize…" escape hatch. B) Checklist door — per-area switches, pre-checked. C) Staged doors — small asks over time.
**Chosen (delegated):** **A — one door.** Presented to Dorian with this recommendation before he stepped away; he did not object. B's granularity survives inside the Control Center behind "Customize…"; C nags existing users repeatedly. One acknowledgment covers the set; the accept writes all consent-gated flips atomically. The same door content renders as an onboarding stage (new users) and a moments-rail modal (existing users).

## 4. Placement — onboarding stage + moments rail

**Delegated decision.**

- **New users:** a dedicated onboarding stage ("Choose your power level") between `requirements` and `conversation`. A DorkBot conversation beat was rejected (conversation steps are skippable and chat-buried; consent must be unmissable and auditable); folding into the welcome screen was rejected (dilutes both). Skipping the stage = supervised start, no nag beyond the standard re-ask rules.
- **Existing users:** the same door as a **modal** (Dorian's explicit requirement: modal, not banner), shown once, on a new generalized **moments rail**: a registry of one-time modals (id, priority, predicate, render) with persisted acknowledgments, one moment per app launch, arbitrated like the app-banner slot. The onboarding overlay always outranks it.
- **Telemetry:** the consent banner retires; telemetry becomes the second moment on the rail (Dorian's explicit requirement). This finally wires the documented-but-dormant re-prompt intent behind `telemetry.lastPromptedVersion`.

## 5. The Control Center

**Delegated decision.** A global flyout opened from a persistent glyph in the app chrome (top-level, always visible — placement candidate: the sidebar header row; exact anchor decided at implementation against the real layout), plus a command-palette entry and a keyboard shortcut. Contents, in order:

1. **The global Trust Dial** (writes `runtimes.defaultTrustStop` through the existing consent-gated path) with the living caption.
2. **Power switches:** open mesh, standing grants, warm agents, schedule concurrency.
3. **Overrides section** — the honesty ledger: per-runtime `defaultTrustStop` overrides, sessions whose bound mode diverges from the global stop, tasks/bindings and their modes, each row deep-linking to its owning surface. The flyout states plainly that the global dial applies to **new** sessions (bound rows are never touched — existing ladder semantics).
4. **Unattended status line** when `isUnattendedAutonomy` drivers are live (same collector as the banner).

**Why this shape:** Dorian asked for Apple-Control-Center ergonomics — view + change a subset of system-wide settings without entering Settings — and for overrides to be visible and respected. The flyout reads effective state; it never invents a new settings store or bypasses the ladder.

## 6. Color & language — green means unlocked

**Delegated decision, with one recorded deviation from the brief.**

- **Full autonomy = green** (⚡ stays): dial stop, status-strip word, settings standing note ("New sessions run at full power — change", green not red), consent dialog icon/button (green primary, no `ShieldOff` fright). The dialog keeps the honest fact line ("This never pauses to ask. Whatever it decides to do, it does.") stated as fact, not fear.
- **Act (middle) = neutral.** **Ask first = neutral with a lock affordance** (🔒 "Limited" framing + quiet "unlock" affordance pointing at the door/Control Center).
- **Amber stays** for divergence info (e.g. Codex's silent workspace-write). **Red is reserved for genuine alarms** (quarantine, unreadable rules, errors).
- **Unattended-autonomy banner:** kept, non-dismissible, but reframed from warning-amber fear copy to matter-of-fact info tone ("Running unattended at full power: {drivers}") — post-flip this is a normal expected state; the Control Center shows the same fact.
- **Deviation:** Dorian's brief said "when it's not fully autonomous, it's locked — that should be the red mode." Making the safe resting state red would shame the cautious choice, spend the alarm color on a non-alarm (the exact mistake the Auto-mode dialog comment documents: "Spending the alarm colour here is what taught people to stop reading it"), and violate the no-dark-patterns filter in AGENTS.md. The lock _iconography_ honors the "locked" mental model; red does not. Flagged for Dorian to overrule.

## Final Design Summary

One consent door — "DorkOS runs at full power" — rendered as a dedicated onboarding stage for new users and a one-time moments-rail modal for existing users. Accepting writes, atomically: the standing autonomy acknowledgment, `runtimes.defaultTrustStop = 'autonomy'`, the open-mesh `* → *` allow rule, `approvals.standingGrants = true`, unattended-surface power-level follow, and `canInitiate` for new bindings — every write through existing consent-gated server paths. Declining records the answer, changes nothing, and never re-asks. Warm agents and scheduler concurrency flip as plain defaults (migration key `0.66.0`). The moments rail generalizes one-time modals and absorbs telemetry consent (banner retired). A global Control Center flyout exposes the dial, the power switches, and an overrides ledger with deep links. Green celebrates full power; neutral-plus-lock marks limited modes; amber stays informational; red is reserved for real alarms. The stay-locked list (extension execution, network exposure, marketplace clamp, telemetry defaults, TTL ceiling, agent-side task permission writes) is untouched by design.
