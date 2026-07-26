---
id: 260723-013234
title: Status-bar preferences live in server config, not client localStorage
status: superseded
created: 2026-07-23
spec: agents-as-operators
superseded-by: 260725-004456
---

# 260723-013234. Status-bar preferences live in server config, not client localStorage

## Status

Superseded by ADR 260725-004456 on 2026-07-25.

> **Erratum (2026-07-26).** Three claims below are false as written, one of them safety-flavoured, so read them as a record of what was believed, not as guidance.
>
> 1. **"`ui.statusBar`, ten booleans"** no longer describes the section. `StatusBarPrefsSchema` is a single `pins` array and nothing else (`packages/shared/src/config-schema.ts:334-337`); the ten subtractive visibility booleans were replaced by one additive pin list.
> 2. **"The optimistic single-key PATCH composes safely under concurrent toggles because the section holds no arrays"** inverts the actual situation. The section is now nothing _but_ an array, and a `config_patch` replaces arrays wholesale rather than merging them key-wise (`packages/shared/src/config-schema.ts:331-332`; `apps/client/src/layers/entities/config/model/use-status-bar-prefs.ts:8`). Two concurrent pin writes do not compose: the later one replaces the earlier. This is the intended semantics for a list of "keep these", but it is the opposite of the safety property claimed here, and anyone reasoning about concurrency from this sentence would reason wrongly.
> 3. **"A one-time client migration lifts legacy `localStorage` values (removing keys only after a confirmed PATCH)"** describes a mechanism that does not exist. The ten `dorkos-show-status-bar-*` keys are purged unconditionally and nothing is lifted into config (`apps/client/src/layers/shared/model/app-store/app-store-helpers.ts:69-83` and `:90`), because the preferences they held no longer have anywhere to go.
>
> ADR 260725-004456 replaces visibility toggles with registry-declared promotion plus pins. What survives from here: the outcome that status-bar preferences live in Zod-validated server config rather than browser storage, reachable by an agent through `config_patch` and synced across devices, and the precedent that a client UI preference a user could reasonably ask an agent to change belongs in server config.

## Context

Status-bar visibility booleans lived only in client Zustand persisted to `localStorage`, making them invisible to agents, other devices, and the server. The agents-as-operators program requires every user-reachable setting to be reachable programmatically; settings trapped in a single browser's storage cannot be.

## Decision

We will store status-bar preferences in the Zod-validated server config (`ui.statusBar`, ten booleans defaulting to the old client defaults) with a semver-keyed conf migration, read via TanStack Query on the `['config']` key and written via `PATCH /api/config`. A one-time client migration lifts legacy `localStorage` values (removing keys only after a confirmed PATCH). This sets the precedent: client UI preferences that a user could reasonably ask an agent (or a second device) to change belong in server config, not browser storage.

## Consequences

### Positive

- Agents toggle status-bar items through the existing `config_patch` tool with zero additional server work; settings sync across devices for free.
- The optimistic single-key PATCH composes safely under concurrent toggles because the section holds no arrays (deep-merge is key-wise).

### Negative

- Reads now depend on the server being reachable; embedded/degraded paths must fall back to schema defaults.
- Each future pref promoted out of `localStorage` needs its own migration and query wiring; the pattern is more ceremony than a Zustand boolean.
