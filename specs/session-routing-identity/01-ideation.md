---
slug: session-routing-identity
number: 261006-180000
created: 2026-10-06
status: ideation
---

# Private, consistent routes and native session identity

**Slug:** session-routing-identity
**Author:** Codex with Dorian Collier
**Date:** 2026-10-06

## 1) Intent & Assumptions

- **Task brief:** Complete the routing audit, centralize all internal links with enforcement, move to thin file-based TanStack route modules, remove filesystem paths from normal URLs, and reliably load existing sessions across Claude Code, Codex and OpenCode.
- **Assumptions:** Existing sessions require only an opaque session reference, not an agent registration. New conversations remain an explicit launch intent with an agent or opaque workspace reference. Native external sessions are supported where the local server can access their native store. Opening, discovering and testing a session does not authorize a billed turn. The user authorized all these changes on 2026-10-06.
- **Out of scope:** Importing ordinary ChatGPT conversations, cloud-only tasks without a supported native access API, discovery of arbitrary remote OpenCode stores, changing the product's route names, or launching paid evaluation turns.

## 2) Pre-reading Log

- `apps/client/src/router.tsx`: central code-based tree, pathless layouts, twelve static and two extension routes, custom search and redirects.
- `packages/shared/src/session-link.ts`, client `shared/lib/session-link.ts`: route builders already exist but cover only part of navigation.
- `scripts/__tests__/session-link-boundary.test.ts`: existing AST guard prevents several manual session links.
- `apps/server/src/services/session/resolve-read-cwd.ts`: read-directory resolution lacked durable metadata fallback.
- `apps/server/src/services/core/runtime-registry.ts`: durable runtime binding wins; unknown identities default to Claude Code rather than discovering their owner.
- Native runtime implementations: Claude Code reads JSONL; Codex originally lists DorkOS registry and projects DorkOS event history; OpenCode uses its managed native sidecar.
- ADR-0156: code-based routing deliberately selected when the tree had three routes; current tree and user request justify a new decision.

## 3) Codebase Map

- **Primary components:** `apps/client/src/router.tsx`, route schemas and loader; `apps/client/src/layers/entities/session/`; native runtime implementations under `apps/server/src/services/runtimes/`; `runtime-registry.ts`; session read and streaming routes.
- **Shared dependencies:** Transport, AgentRuntime, session metadata, alias mapping, session URL builders, query keys, selected-directory state.
- **Data flow:** URL reference → server identity lookup → runtime/native store → session metadata/history → client directory and runtime state. New-session selection → explicit launch context → optimistic session ID → first message → durable runtime and native binding.
- **Feature flags/config:** Production and desktop share client sources. `/dev/*` remains outside the router and is DEV-only. No new spending flag or implicit credential selection.
- **Blast radius:** All navigation entry points, server detail/history/tasks/SSE/WebSocket, desktop deep links and both builds, session creation and settings, runtime listing/discovery, extension routes, browser tests and developer documentation.

## 4) Root Cause Analysis

1. Load `/session?session=d95cd27a-608d-49f5-9f56-54c6019a7821` on the user's running server: detail returns 404.
2. Supply `dir=/Users/doriancollier/Keep/tangerines`: the same session loads.
3. Durable metadata already records that directory, but the read resolver only consulted live runtime state and the default directory.

**Observed vs expected:** A known existing session needs an extra private filesystem location to open; its ID should identify the stored session independently of the selected directory.

**Evidence:** Real read-only reproduction, durable database row and native transcript. Local preliminary fix adds persisted directory fallback and repairs settings-before-first-message directory binding, with 165 focused passing tests and both scoped typechecks.

**Decision:** Resolve identity server-side and separate existing-session navigation from draft launch context. The preliminary client redirect back to a directory-bearing URL is transitional and must be removed in this implementation.

## 5) Research

1. Keep code-based routes and add more helpers: supported by TanStack Router but leaves a growing orchestration file and manual splitting.
2. Thin app-root file routes: generated type tree and route splitting while preserving FSD feature implementation below the routes. Preferred.
3. Require agent and session everywhere: rejected because external sessions may have no registered agent and worktree directories differ from agent directories.
4. Session ID plus server-owned runtime/native identity mapping: preferred; native discovery must avoid assuming Claude Code for every unknown ID.

**Sources:** TanStack Router file-based routing, link options and Vite plugin documentation; OpenAI Codex app-server native `thread/list` and `thread/read` protocol. Research precision: code-based routing remains valid; file-based is an organizational and tooling choice. Modern referrer policy usually omits query on cross-origin navigation, but same-origin referrers, browser history and copied URLs still disclose paths.

## 6) Decisions

| #   | Decision              | Choice                                                | Rationale                                                                          |
| --- | --------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Existing URL identity | Session reference only                                | Server owns runtime and directory; external sessions need no agent registration.   |
| 2   | Launch identity       | Agent ID or opaque workspace ID                       | New conversations do need a selected runtime/directory before a transcript exists. |
| 3   | Native discovery      | Read-only, runtime-specific, accessible native stores | External sessions must load without sending a first message or billing.            |
| 4   | Routing structure     | Thin file-based modules at app root                   | Preserves FSD and DEV bypass while scaling the route tree.                         |
| 5   | Internal links        | Typed factories with AST lint enforcement             | A route change should have one canonical link-construction location.               |
