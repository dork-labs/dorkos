---
id: 260721-221810
title: The Shape is the fifth marketplace package type — a composition manifest that activates existing packages, holding agents by affinity, not ownership
status: accepted
created: 2026-07-21
spec: shapes
extractedFrom: shapes
specSlug: shapes
superseded-by: null
---

# 260721-221810. The Shape is the fifth marketplace package type — a composition manifest that activates existing packages, holding agents by affinity, not ownership

## Status

Accepted

## Context

The Shapes program (`plans/shapes-program.md` D2) needed to ratify what a Shape _is_ before Linear Ops (P1) and Flow Board (P2) could be described in a manifest. A Shape bundles extensions, a saved layout, suggested agents, skills, MCP connections, and schedules into one installable, forkable unit — a "place" you switch into. The open question was the disk model. A **monolithic bundle** would re-embed each part (core extensions, agent definitions, skills) inside the Shape package; a **composition manifest** would instead reference and activate already-installed packages and carry only the shape-specific glue. The harness-derived-shapes principle set the constraint: the first Shapes are an _assembly_ of already-shipped parts, so the format must compose existing pieces rather than require new greenfield primitives. A second, entangled question was ownership: does a Shape _own_ its agents (an agent belongs to one Shape) or merely _suggest_ them?

## Decision

We define **Shape as the fifth marketplace package type** (`type: 'shape'`, alongside `agent`, `plugin`, `skill-pack`, `adapter`; ADR-0230), realized as a **composition manifest** — `ShapeManifestSchema` references and `activates` existing packages/extensions and carries only shape-specific glue: `layout`, `agents[]` (with `affinity: 'suggested' | 'default'`), `schedules`, `connections`, `activates`, and `lineage`. No part is re-embedded that already ships elsewhere; Linear Ops validates the format end to end with zero escape hatches. A Shape **holds agents by affinity, not ownership**: applying a Shape _offers_ its default agent (an arrival experience) but never binds an agent to the Shape or auto-creates one. The forward affinity hint lives on the Shape's `agents[]`; the reverse agent→Shape hint and the active-Shape state live in `ui.shapes` user config, never on `.dork/agent.json` (ADR 260717-001409). `DependencyDeclarationSchema` is widened to allow `shape:<name>` so a Shape can compose another Shape.

## Consequences

### Positive

- Shapes compose the existing catalog instead of duplicating it: a Shape is a few kilobytes of references plus glue, so authoring, forking, and syncing stay cheap and the same extension shared by many Shapes is stored and versioned once.
- Install rides the existing file-scoped transaction (ADR-0304) and the §9 recipe with no new install machinery; the fifth type slots into the existing `dispatchFlow` switch (now with an exhaustiveness guard).
- Affinity-not-ownership keeps place and staff independent: an agent can serve several Shapes, switching Shapes never orphans or clobbers an agent, and the operator is never forced into a binding they did not choose — the control-panel stance, not a consumer app.
- Keeping active-Shape and reverse-affinity state in person-scoped `ui.shapes` config (not the agent file) means a synced or exported cockpit carries the preference without dragging per-Shape state onto shared agent records.
- `shape:` dependencies enable Shape sets (composing Shapes) without inventing a new mechanism.

### Negative

- A Shape is only as coherent as the packages it references: applying one degrades per-piece when a referenced extension or agent is missing (surfaced as `warnings[]`, ADR-0310), so a Shape can land "partially furnished" rather than all-or-nothing — an intentional trade for never presenting a locked door.
- Membership is not materialized anywhere: because affinity is a hint rather than ownership, no single query answers "which agents belong to this Shape," and any surface that wants that must resolve it from the manifest plus live agent state.
- The composition model splits a Shape's behavior across the manifest, the referenced packages, and `ui.shapes` config, so reasoning about a fully-applied Shape means reading three places rather than one self-contained bundle.
