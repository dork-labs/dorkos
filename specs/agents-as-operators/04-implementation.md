# Implementation: Agents as First-Class Operators (program phase 1)

- **Completed:** 2026-07-22
- **Tasks:** 8/8 (DOR-429..436), all merged
- **PRs:** #422 (in-session marketplace tools), #425 (self-service and observability tools), #428 (status-bar prefs in server config), #430 (CLI operator verbs), #432 (`evaluateSmartGroup` to `@dorkos/shared`), #433 (Operating DorkOS skill pack), #434 (operate-DorkOS eval cases), #435 (agent-operator docs)
- **ADRs:** 260723-013233 (CLI-first agent actuation, hand-registered tools until the Capability Registry), 260723-013234 (status-bar preferences live in server config, since superseded by 260725-004456), 260723-013235 (Operating DorkOS skills ship as an in-repo leaf package with hash-stamped seeding), 260723-013236 (sensitive config keys redacted from agent-facing tool results, since superseded by 260725-152018)

This record was written on 2026-07-26, after phases 2 and 3 had shipped. See "Why this record is late" below, which is the part of it most worth reading.

## What shipped

Phase 1 closed the coherence gap: the things a person can do in DorkOS became things an agent can do too, from inside a session and from a terminal.

- **The eight marketplace MCP tools reached the in-session server.** They had been external-only, so an outside MCP client could install a package but the user's own agent could not. Handlers were extracted into a transport-neutral layer consumed by both registrations rather than duplicated, and the install confirmation-token boundary was preserved unchanged.
- **Five self-service and observability tool families were added to both MCP servers** as thin wrappers over existing service logic: `update_agent` (an agent editing its own traits, conventions, display name, SOUL.md and NOPE.md), `activity_list`, `config_get`/`config_patch`, `check_update`, and `agents_recent_activity`. System agents still refuse identity edits, enforced at the tool as it already was at the route.
- **Status-bar preferences moved out of browser `localStorage` into Zod-validated server config** (`ui.statusBar`), reachable by an agent through `config_patch` and synced across devices. The shape this shipped with did not survive; see below.
- **`evaluateSmartGroup` moved to `@dorkos/shared`,** so smart-group membership stopped being a client-only function and the server and CLI evaluate groups the same way the sidebar does.
- **The CLI gained operator verbs:** `dorkos agent`, `dorkos task`, `dorkos activity`, and `dorkos version --check`, each with `--json`. This is the universal actuation surface: every runtime can exec a shell command, so the CLI is the one path that reaches Codex and OpenCode sessions, which have no DorkOS MCP server.
- **The Operating DorkOS skill pack v1** ships as an in-repo leaf package, seeded at agent creation and DorkBot boot and projected by Harness Sync, with hash-stamped seeding so an upgrade refreshes untouched skills and leaves hand-edited ones alone.
- **Outcome-oracle eval cases** for operating DorkOS, each asserting the real state change rather than the agent's narration.
- **Documentation:** `contributing/agent-operator-surface.md` and a user-facing guide.

## Deltas from the spec

- The spec's task text named seven marketplace tools plus the install confirmation flow. `marketplace.uninstall` rides alongside them, so the surface is eight tools (`apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts:108-259`, as the registry holds them today).
- Phase 1 deliberately used the existing hand-registration patterns for every new tool, per ADR 260723-013233, on the understanding that phase 2's Capability Registry would subsume them. It did. Nothing in phase 1's tool wiring survives as written.
- Agent identity was accepted as absent for phase 1 (no attribution, no per-agent capping) and deferred to phase 3, which delivered it.

## Verification

Each task shipped with unit tests alongside its source, and the full monorepo suite was green at each merge. The eval cases added in DOR-435 assert observable state changes rather than model output. Two caveats belong on the record rather than in a footnote: the eval suite of that period could not run credential-free, so the operate-DorkOS cases were not proven against a real model until the harness changes of 2026-07-25 (DOR-503) made a local signed-in run possible; and phase 1 shipped no enforcement of any kind on these new capabilities, by design, since the tier gate is phase 3's subject.

## Why this record is late, and what it cost

Phase 1 had no `04-implementation.md` until now. That gap is the reason two of its four ADRs drifted for three days while still reading as current, accepted decisions:

1. **ADR 260723-013234** described `ui.statusBar` as ten booleans and justified an optimistic single-key `PATCH` on the grounds that "the section holds no arrays". DOR-452 replaced the ten booleans with a single `pins` array (`packages/shared/src/config-schema.ts:334-337`), which inverted the stated safety property: a `config_patch` replaces arrays wholesale rather than merging key-wise (`packages/shared/src/config-schema.ts:331-332`). The ADR is now marked superseded by 260725-004456, with the three false claims listed in its erratum.
2. **ADR 260723-013236** claimed the redaction denylist made the invariant "drift-proof against new sensitive keys". It was drift-proof only against changes to its own list, and a real disclosure shipped through the gap. It is superseded by 260725-152018, which replaced the denylist with an allowlist over the whole schema.

Neither correction was hard to make once someone looked. The failure was that nothing prompted anyone to look: with no implementation record, a phase's decisions had no single place where "is this still true?" gets asked after the code moves. A spec left at `specified` in `specs/manifest.json` also does not read as finished work, so the phase never entered anyone's review surface. Writing this file at the end of a phase, and re-reading the phase's ADRs against source when writing it, is the cheap version of the check that did not happen here.

## Program status

- **Phase 1 (coherence)**: this record. Shipped 2026-07-22.
- **Phase 2 (registry spine)**: spec `capability-registry`, implemented. Subsumed phase 1's hand-registered tool tables.
- **Phase 3 (governance)**: spec `agent-trust`, implemented. Delivered agent identity, capability tiers, the approval primitive, and isolated evals.
- **Phase 4 (the loop)**: marketplace publish flow, agent-authored skills feeding the pack, eval-gated skill and doc improvement (`02-specification.md:122`). Not yet specified.
