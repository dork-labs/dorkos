---
number: 303
title: Harness Sync is a multi-source projector — marketplace plugins project automatically, agent-native assets adopt explicitly
status: draft
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 303. Harness Sync is a multi-source projector — marketplace plugins project automatically, agent-native assets adopt explicitly

## Status

Draft (auto-extracted from spec: harness-sync)

## Context

Harness Sync as first specified projected only the repo's _authored_ canonical source (`.agents/`), but two other kinds of agent files exist on disk and a user wants them in every harness too. Marketplace plugins install to `<scope>/plugins/<name>` (`~/.dork/plugins` global or `<project>/.dork/plugins`) and today reach only the DorkOS-driven Claude runtime, via the SDK `plugins` array — there is **no** filesystem bridge to Codex/Cursor/OpenCode. Separately, users have assets installed natively by an agent (skills in `.claude/`, rules in `.cursor/`) that are stranded in that one harness. The vendored-maps decision (ADR-301) means we own the projector, so adding source roots is our choice, not a library constraint.

## Decision

We will make Harness Sync a **multi-source projector** over three source classes with one engine, one drop list, and a `provenance` tag on every projection action: (1) **authored** `.agents/` (committed); (2) **marketplace-installed** `.dork/plugins/*` — its **portable subset** (skills, hooks) projects **automatically on install** to every enabled harness, with projections **ephemeral/gitignored**, scope-matched (project↔project, global↔global), and DorkOS-only parts (extensions/adapters) dropped; (3) **agent-native** assets — promoted to canonical only via an **explicit, reviewable `dorkos harness adopt`** (skills + instructions in v1), never automatically. We do **not** change where the marketplace installs. Slash-command _triggers_ stay Claude-only while their _behavior_ travels everywhere as a skill; hooks project to every harness that has a hook system (Gemini is the lone drop).

## Consequences

### Positive

- "Install once, works in every harness" for marketplace plugins, reusing `@dorkos/marketplace`'s `installed-scanner` — no change to the install machinery.
- One engine + one honest drop list across authored, installed, and adopted sources; `provenance` cleanly separates committed from ephemeral projections.
- Adoption is explicit and reviewable, so the canonical source never silently absorbs a foreign asset (honors the conflict rule).

### Negative

- The projector must understand the plugin layout, a collision/namespacing policy, scope mapping, and ephemeral-vs-committed gitignore — more surface than single-source projection.
- `adopt` needs per-source importers and a review UX; hook/command adoption is lossy and deferred.
- Requires fixing the latent gap where project-local `.dork/plugins/` is not gitignored.
