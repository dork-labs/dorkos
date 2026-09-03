---
id: 260822-235801
title: The color economy — green means full power, red is reserved for alarms
status: accepted
created: 2026-08-22
spec: full-power-defaults
superseded-by: null
amends: null
---

# 260822-235801. The color economy — green means full power, red is reserved for alarms

## Status

Accepted — extracted from spec `full-power-defaults`.

## Context

The Trust Dial shipped with autonomy styled as the danger tier: red caption and status word, `ShieldOff` iconography, red confirm buttons, an amber warning banner. Under the full-power-by-default posture that styling tells users the recommended state is the dangerous one. The operator brief asked for the inverse ("full autonomy green; not-autonomous is the locked, red mode"). The codebase already carries the alarm-economy lesson (the Auto-mode dialog's comment: spending red on non-alarms teaches people to stop reading it).

## Decision

Styling stays semantics-derived (never mode-id keyed) with a new tint map: the **autonomy stop renders green** (dial caption, status word, settings standing note, consent dialogs — ⚡ presentation, primary/green confirm, no `ShieldOff`); the **ask stop stays neutral** with a lock affordance ("Limited" framing + a quiet unlock pointer) rather than red; **amber remains information** (declared-semantics divergence, e.g. Codex's silent workspace-write); **red is reserved for genuine alarms** (quarantine, unreadable access rules, errors, destructive confirmations). The unattended-autonomy banner survives but reframes from warning-amber fear copy to matter-of-fact info tone. Honest fact lines in consent dialogs are kept verbatim, styled as facts. This deliberately deviates from the literal "not autonomous = red" brief; the deviation is recorded and overrulable (spec design-decisions §6).

## Consequences

- Full autonomy reads as the unlocked, celebrated state without hiding what it does — copy stays honest while tone stops being fearful.
- Red regains alarm value; a red surface in DorkOS now always means something is wrong, not something is powerful.
- The cautious choice is never shamed — no dark pattern pushing users off Supervised.
- Divergence styling (amber) and the `needsConsentRitual` door are untouched; only tint and copy move.
