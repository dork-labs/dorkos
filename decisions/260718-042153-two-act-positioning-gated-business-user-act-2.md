---
id: 260718-042153
title: 'Two-act positioning: launch on operator/dev framing now, gate business-user Act 2 on evidence triggers'
status: accepted
created: 2026-07-17
spec: null
superseded-by: null
---

# 260718-042153. Two-act positioning: launch on operator/dev framing now, gate business-user Act 2 on evidence triggers

## Status

Accepted

## Context

The 2026-07-17 Shapes/BYOA research (`research/20260717_shapes-byoa-positioning.md` §7) surfaced a live tension: the founder wants to reposition DorkOS toward business users on the strength of Shapes, but the entire `meta/positioning-202607/` corpus, the imminent 14-week GTM plan, and the demo-claim gate (`09-gtm-plan.md` §2.0) are built on the developer/operator beachhead — and business-facing Shapes are the plan's least-verified surface (zero reference shapes shipped, zero non-developer users, unevaled). Editing Act-1 launch copy now to lead with business users would market capabilities that do not yet exist end-to-end, breaking the same demo-claim gate that already governs every other launch pillar in `09-gtm-plan.md` §2.2.

## Decision

We will run positioning in two acts. **Act 1 (now):** launch and market DorkOS on the existing operator/developer positioning exactly as planned in `02-positioning.md` and `09-gtm-plan.md` — no changes to Act-1 launch copy. **Act 2 (business users/operators broadly):** fires only when all three evidence triggers are met — (1) at least three business-facing Shapes work end-to-end, (2) a real non-developer user cohort exists, (3) desktop-app install friction is effectively zero. When Act 2 fires, it gets its own positioning review cycle (a fresh pass through the calibration process), not an edit-in-place of Act-1 copy. Until the triggers clear, Shapes marketing stays the Script-2 / second-visit story (`08-demo-video-scripts.md`), introduced after launch rather than as the headline (`plans/shapes-program.md` Phase 4).

## Consequences

### Positive

- Protects the imminent 14-week launch plan from a mid-flight repositioning that would contradict its own demo-claim gate.
- Gives the founder's business-user instinct a concrete, evidence-gated path instead of either ignoring it or shipping it prematurely.
- Keeps Shapes marketing honest — no claim outruns shipped and evaled work (`plans/shapes-program.md` W4/P8).

### Negative

- Delays the business-user narrative the founder wants, potentially past the 14-week launch window if the triggers are slow to clear.
- Requires an explicit Act-2 trigger dashboard (`plans/shapes-program.md` success criterion 5) to track trigger status, or the gate becomes unenforceable vibes.
- Introduces a second decision point mid-program (when do the triggers actually count as "met"?) that could itself get contested later — e.g., what "install friction ≈ zero" means operationally is not defined here.

## Alternatives Considered

- **Reposition now, alongside Shapes work** — rejected: business Shapes are unproven, so this would violate the demo-claim gate on day one of the new positioning.
- **Never reposition toward business users** — rejected: the door is already open ("operator mentality, not technical skill" per `AGENTS.md`'s persona framing), and closing it ignores real founder intent and Ikechi-persona evidence in the research.
- **Soft-blend business language into Act-1 copy without a hard gate** — rejected: an implicit, ungated blend is how demo-claim violations happen by accretion; an explicit trigger set is the only way to keep the gate enforceable.
