---
slug: agents-as-operators
id: 260722-220011
created: 2026-07-22
status: specified
---

# Agents as First-Class Operators of DorkOS

**Status:** Approved
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-22
**Tracker:** DOR-428 - Agents as First-Class Operators — program umbrella

## Overview

Make DorkOS agents the best users of DorkOS: aware of everything about the system and able to do anything a user can do through the product, including acting on the user's behalf. The program has four phases; this specification freezes the target architecture for the whole program and specifies **Phase 1 (coherence)** in implementation-ready detail. Phases 2-4 (registry spine, governance, self-improving loop) are scoped here at milestone level and get their own specification rounds when phase 1 lands.

Ideation of record: `research/20260722_agents-as-first-class-operators.md`.

## Background / Problem Statement

The capability surface exists but is incoherent. Verified 2026-07-22:

- Four hand-maintained projections of "what DorkOS can do" have drifted: the in-session MCP server (~40 tools, claude-code only), the external `/mcp` server (adds 8 marketplace tools and 3 resources the in-session server lacks), the CLI (marketplace-heavy, no agent/task/activity verbs), and the OpenAPI registry (~13 of ~33 route domains).
- An external MCP client can install marketplace packages, but the user's own agent in a DorkOS session cannot: the 8 marketplace tools are external-only.
- Codex sessions get exactly one DorkOS tool (`control_ui` via a loopback server); OpenCode sessions get zero. Every runtime can exec shell commands, so the CLI is the only possible universal actuation surface, and it's missing the operator verbs.
- No first-party skills teach agents how to operate DorkOS. A fresh agent workspace gets an AGENTS.md stub; the system prompt's `<dorkos_context>` block (ADR-0185) is a two-URL pointer.
- Dead zones with no programmatic path at all: status-bar toggles (client `localStorage` only), smart-group membership evaluation (client-only function), marketplace publish (doesn't exist), version check (a config field + CLI startup side effect).
- Agents have no identity: they authenticate exactly like the human, so there is no attribution and no per-agent capping (accepted for phase 1; fixed in phase 3).

## Goals

- An agent in any DorkOS session (any runtime) can: create agents, edit its own personality, list/schedule/trigger tasks and read run history, read the activity feed, see recently active agents, browse and install marketplace packages, read and patch user config (including sidebar groups and status-bar prefs), and check for a DorkOS update.
- Agents know how: a first-party "Operating DorkOS" skill pack teaches procedure; live facts come from the API/CLI.
- Every new capability is covered by deterministic tests, and agent competence at operating DorkOS is measured by outcome-oracle evals in sandboxed `DORK_HOME`s.

## Non-Goals (phase 1)

- The Capability Registry itself and generated projections (phase 2 — phase-1 additions deliberately reuse existing hand patterns and will be subsumed).
- Agent identity, permission tiers, approval flows (phase 3). Phase 1 stays within today's trust model; destructive-tool descriptions instruct the model to confirm with the user first, which is guidance, not enforcement, and is an accepted interim.
- Marketplace publish-to-registry (phase 4; needs its own design).
- Codex/OpenCode MCP injection (structurally impossible today; the CLI + skills close the gap).
- Obsidian/DirectTransport parity for new tools.

## Technical Dependencies

All internal; no new external libraries. Key seams: `createDorkOsToolServer` (`apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`), `registerMarketplaceTools` (`services/marketplace-mcp/marketplace-mcp-tools.ts`), `ConfigManager` + Zod config schema (`packages/shared/src/config-schema.ts`, semver migrations per `contributing/configuration.md`), `ActivityService`, `update-checker.ts`, `@dorkos/skills` + Harness Sync scaffolding (`packages/harness`, `agent-creator.ts`), `packages/evals` (spec `eval-harness`, DOR-357), CLI arg parsing (`packages/cli/src/cli.ts`).

## Detailed Design (Phase 1)

### 1.1 Marketplace tools join the in-session server

Register the same 8 marketplace tools (search/get/list-marketplaces/list-installed/recommend/install/create-package + confirmation flow) into `createDorkOsToolServer`, sharing the handler layer with `marketplace-mcp-tools.ts` (extract shared handlers; do not duplicate logic). The install confirmation-token flow is preserved as-is. Wiring: `index.ts` passes `marketplaceDeps` into the tool-server factory.

### 1.2 Self-service and observability tools (in-session + external, hand-registered)

New tools, mirrored to both MCP servers, thin wrappers over existing service logic (never duplicating route validation):

- `update_agent` — PATCH semantics of `routes/agents.ts` self-edit: traits, conventions, displayName, SOUL.md/NOPE.md content; immutable/system-identity fields rejected server-side exactly as the route does. Description directs agents to confirm with the user before editing another agent's manifest.
- `activity_list` — `ListActivityQuerySchema` passthrough (actor/category/eventType/resource filters, pagination).
- `config_get` / `config_patch` — snapshot and deep-merge patch via ConfigManager (Zod-validated; same code path as `PATCH /api/config`). `config_patch` description flags it as a user-settings mutation requiring user intent.
- `check_update` — current version + `latestVersion` via `update-checker.ts`.
- `agents_recent_activity` — the `GET /api/sessions/recent` per-agent latest-activity map (closes "which agents were active lately").

### 1.3 Status-bar prefs move to server config

New `ui.statusBar` config object (Zod, all booleans defaulting to today's client defaults) with a semver-keyed migration. Client `app-store-preferences.ts` status-bar booleans switch to TanStack Query against `/api/config` (pattern: existing `ui.sidebar` usage; `['config']` query key per prior art), with a one-time client-side migration reading any existing `localStorage` values and PATCHing them up. Agents then toggle status-bar items via `config_patch`.

### 1.4 Smart-group evaluation moves to shared

`evaluateSmartGroup` + rule types relocate from `apps/client/.../evaluate-smart-group.ts` to `@dorkos/shared` (new subpath export, TSDoc'd, tests move along). Client imports from shared; behavior identical. This unblocks server/CLI membership computation later without committing to a server API now.

### 1.5 "Operating DorkOS" skill pack v1

New canonical skills authored in-repo (location: implementer's call between `packages/shared` assets or a dedicated `packages/operating-skills`; must be importable by `agent-creator.ts` and the CLI without a server): `operating-dorkos` (umbrella: what DorkOS is, the CLI, when to use tools vs CLI, where facts live), `managing-agents`, `scheduling-tasks`, `using-the-marketplace`, `reading-activity`. Each ≤150 lines, SKILL.md format (`@dorkos/skills` schemas), written for models per ACI principles (concise, imperative, no marketing prose). Seeding: `scaffoldInstructions()`/agent creation writes the pack into new agent workspaces' `.agents/skills/`; `ensureDorkBot()` upgrades DorkBot's home on boot. Seeding is idempotent and version-stamped: overwrite a seeded skill only when the pack version is newer AND the on-disk file still matches its stamped content hash (user-modified copies are never clobbered). Harness Sync then projects the pack to every harness, which is what gives Codex/OpenCode sessions the knowledge layer.

### 1.6 CLI operator verbs (hand-rolled v1)

New subcommands hitting the running server's HTTP API with the per-instance local token (reusing the CLI's existing server-discovery + auth pattern from the marketplace commands): `dorkos agent list|show|create|update`, `dorkos task list|create|trigger|runs`, `dorkos activity`, `dorkos version --check`. All accept `--json` (machine output, no spinner/prose). Command names and flags are the stable contract; phase 2 replaces their internals with registry-generated dispatch. Help text stays within the existing `cli.ts` conventions.

### 1.7 Operate-DorkOS evals

New eval cases in `packages/evals` (registered in `ALL_CASES`, tag `core`), `claude-code-cheap` tier, each an outcome oracle in a sandboxed `DORK_HOME`: agent-self-edit (prompt DorkBot to adjust its own persona → assert SOUL.md/agent.json changed), activity-read (seed events → prompt → assert the query tool fired and state unchanged), config-toggle (prompt to hide a status-bar item → assert the config.json field flipped), marketplace-search-and-install (local fixture source → assert installed tree). Deterministic Vitest covers every new tool handler and the config migration.

## User Experience

The user talks to any agent ("hide the git status bar item", "make me a code-review agent that runs nightly", "install the flow plugin") and it happens without the user opening the cockpit; the cockpit reflects changes live via existing SSE/config invalidation. Agents in Codex/OpenCode sessions accomplish the same through `dorkos ... --json`. Skills make the _how_ discoverable without bloating context. Errors surface as normal tool/CLI errors with the server's Zod messages.

## Testing Strategy

- **Unit/integration (per-PR):** each new MCP tool handler (happy + rejection paths, system-agent protection), config migration, shared smart-group evaluator (moved tests), CLI verbs against a booted test server, skill-pack seeding idempotence (fresh home, existing home, user-modified file).
- **Evals (scheduled, not per-PR):** §1.7 cases; sandboxed `DORK_HOME` per run (harness default); no production services touched (local marketplace fixture).
- **Mocking:** marketplace source fixtures on disk; `update-checker` stubbed at its fetch seam.

## Performance Considerations

Tool-count growth on the in-session server (~40 → ~55) raises per-turn schema tokens; acceptable for phase 1 (Claude Code's tool-search mitigates), and phase 2's registry + curation addresses it structurally. Config reads are cached (`conf`); activity queries are paginated.

## Security Considerations

`config_patch` and `update_agent` are mutation tools available without new gating — same trust model as every existing mutating tool (`tasks_create`, `marketplace_install`'s token flow, `create_agent`). System-agent protections stay enforced server-side. The CLI uses the per-instance local token; no new network exposure (external MCP keeps its 4-tier auth; new mutating tools are NOT added to `READ_ONLY_MCP_TOOL_NAMES`). Phase 3 introduces real tiers/identity; until then destructive ops rely on server-side invariants plus tool-description guidance.

## Documentation

- `contributing/` addition: agent-operator surface overview (which tools/CLI verbs exist, where handlers live, how to add one).
- `docs/` (site): "Agents can operate DorkOS" user guide + CLI reference additions (follows `writing-for-humans`).
- Changelog fragments per PR (timestamp-id convention).

## Implementation Phases

- **Phase 1 — coherence (this spec, decomposed now):** §1.1-§1.7.
- **Phase 2 — the registry spine:** Capability Registry; generated CLI/MCP/OpenAPI/self-description (`dorkos capabilities`, `GET /api/capabilities`); conformance suite; local docs serving. Own spec round.
- **Phase 3 — trust:** per-agent identity tokens, observe/act/destructive tiers, generalized confirmation-token approvals, Activity attribution, governance evals, Docker eval isolation tier + eval CI cadence. Own spec round.
- **Phase 4 — the loop:** marketplace publish flow, agent-authored skills feeding the pack, eval-gated skill/doc improvement. Own spec round.

## Open Questions

- ~~Should phase-1 tools wait for the registry?~~ **(RESOLVED)** No. Answer: hand-register following existing patterns; the registry subsumes them in phase 2. Rationale: the asymmetries are user-visible now, the surface is small, and registry design benefits from concrete cases.
- ~~Where does the skill pack live?~~ **(RESOLVED)** In-repo (importable without a server), seeded at agent creation and DorkBot boot, projected by Harness Sync. Rationale: marketplace distribution adds cross-repo coordination without phase-1 benefit; revisit in phase 4 when agents author skills.
- ~~Hand-rolled CLI verbs vs waiting for generation?~~ **(RESOLVED)** Hand-roll with stable names/flags; regenerate internals in phase 2. Rationale: Codex/OpenCode have zero actuation today; the CLI contract is the durable part.
- ~~Should `config_patch` ship before permission tiers?~~ **(RESOLVED)** Yes. Rationale: Zod-validated, versioned, reversible file writes; consistent with existing mutating tools; tiers arrive in phase 3.

## Related ADRs

ADR-0185 (two-layer DorkOS knowledge), ADR-0273 (runtime-neutral context injection), ADR-0255 (per-session runtime binding), ADR-0304 (marketplace install transaction), ADR-0301/0303 (harness sync projection), ADR 260722-111314 (onboarding is a scripted DorkBot conversation). New ADRs extracted at `/flow:done` per the significance rubric (expected: capability-surface strategy; status-bar prefs promotion to server config).

## References

- `research/20260722_agents-as-first-class-operators.md` (ideation of record; full audit + external sources)
- `specs/eval-harness/02-specification.md` (DOR-357)
- `specs/marketplace-05-agent-installer/02-specification.md`
- `contributing/configuration.md`, `contributing/adding-a-runtime.md`
- REVIEW.md (reviewer rubric for all PRs in this program)
