---
id: 261010-143211
title: DorkOS picks the model per chat from the credits catalog; the model item is hidden by default
status: accepted
created: 2026-10-10
spec: one-minute-onboarding
superseded-by: null
amends: [261008-052830]
---

# 261010-143211. DorkOS picks the model per chat from the credits catalog; the model item is hidden by default

## Status

Accepted (operator decision 2026-10-07; Linear DOR-2784). Spec: `specs/one-minute-onboarding/` §6.

**Amends:** [261008-052830](261008-052830-doe-host-boundaries.md): "explicit inference sources" now allows `runtimes.doe.inference: null` on credits, meaning the catalog chooses.

## Context

Doe could not run until a person typed a model id, endpoint, context window and output limit. The operator decided DorkOS picks the model and a person can change it in Settings and from a status-bar item that is hidden by default. The credits catalog already names a suggested model per request format (`recommendedOn`) and names no vendor. The decision-model ladder returns labels, not model ids, and would add a call before every turn.

## Decision

With credits chosen and nothing configured, a chat's first turn freezes the catalog's recommended model for the first request format the held token serves, in a fixed preference order. No match refuses; it never falls to another payer. An explicit per-chat or per-agent model still wins when credits serve it. Own keys and local models use a small preset table plus the service's own model list, so a person enters only a key. The status bar's model item and, for this engine, its Runs on item appear only when pinned.

## Consequences

### Positive

- The default path needs no model setup, and no model name lives in app code for it.
- Which model is suggested stays a catalog decision on the Cloud side.
- The model is one click away in Settings and the status bar, so hidden is not secret.

### Negative

- A catalog without a recommended model in a served format leaves new chats refused until Cloud fixes it.
- The preset table's model preferences drift as vendors rename models.
- Per-turn routing and tiers wait for real usage and a catalog `tier` field.
