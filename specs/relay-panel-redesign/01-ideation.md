---
slug: relay-panel-redesign
number: 132
created: 2026-03-15
status: ideation
---

# Relay Panel Redesign

**Slug:** relay-panel-redesign
**Author:** Claude Code
**Date:** 2026-03-15
**Branch:** preflight/relay-panel-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the Relay Panel from first principles based on a full Jobs/Ive design critique. The panel currently mirrors the system's internal architecture (Adapters, Bindings, Endpoints, Activity) rather than the user's mental model. Collapse four tabs to two, replace raw metrics with semantic status, aggregate dead letters into failure insights, fix data integrity bugs, and add binding-level permissions for overnight safety.

- **Assumptions:**
  - The Relay Panel's role has narrowed since ADR-0117: the web client no longer uses Relay for chat — it's solely for external adapters (Telegram, Slack, Webhook) and agent-to-agent messaging
  - The binding resolution algorithm (ADR-0047) and adapter manifest system (ADR-0044) are sound and should be preserved
  - The Adapter Setup Wizard is the strongest UX surface and needs refinement, not redesign
  - ADR-0038 (Progressive Disclosure Mode A/B) provides the architectural pattern for empty-state transitions
  - The sidebar "Connections" tab (ADR-0107/spec #117) is a related but separate surface showing per-agent adapter status — this spec addresses the full Relay Panel dialog
  - Existing spec #68 (relay-ux-elevation) and #120 (adapter-binding-ux-overhaul) overlap with this work and should be superseded

- **Out of scope:**
  - Relay core library changes (packages/relay)
  - Adapter protocol implementations (Telegram, Slack, Webhook adapters)
  - Topology graph / Mesh panel (separate feature)
  - Server-side binding resolution algorithm changes
  - Rate limiting / circuit breaker UI (reliability schemas exist but aren't wired)

---

## 2) Pre-reading Log

- `.temp/relay-design-critique.md`: Full Jobs/Ive screen-by-screen critique with specific issues, severity ratings, and a phased overhaul plan. Revised after code review, ADR review, and persona analysis.
- `.temp/relay-bindings-review.md`: Deep code review of the bindings system. Confirmed Bindings tab is redundant (bindings appear in 6 UI surfaces), session strategy is over-exposed, permissions are absent, orphan bindings accumulate silently.
- `meta/personas/the-autonomous-builder.md`: Kai — primary persona. Runs agents overnight. Core need: see system state at a glance, safety for autonomous runs. Binding permissions (`canInitiate: false`) is his #1 safety concern.
- `meta/personas/the-knowledge-architect.md`: Priya — secondary persona. Hates context-switching. The dialog-in-panel-in-tab nesting (Panel > Tab > List > Detail) is the exact flow interruption she dreads.
- `meta/personas/the-prompt-dabbler.md`: Jordan — anti-persona. Any feature that makes the Relay Panel feel like a consumer dashboard is out of scope.
- `decisions/0038-progressive-disclosure-mode-ab-for-feature-panels.md`: Mode A (empty) hides tabs/stats and shows single keystone action. Mode B (populated) shows full interface. Designed for Relay but not fully applied.
- `decisions/0046-central-binding-router-for-adapter-agent-routing.md`: Central BindingRouter architecture. Adapters are dumb protocol bridges. Routing logic is centralized.
- `decisions/0047-most-specific-first-binding-resolution.md`: 7/5/3/1 scoring algorithm for binding specificity. Elegant, extensible, correct.
- `decisions/0107-css-hidden-toggle-for-sidebar-view-persistence.md`: Sidebar gains Sessions/Schedules/Connections tabs. "Connections" name aligns with our recommendation.
- `decisions/0117-direct-sse-as-sole-web-client-transport.md`: Web client uses direct SSE, not Relay. Relay is now solely for external adapters and agent-to-agent. Changes the health bar's semantic context.
- `decisions/0044-configfield-descriptor-over-zod-serialization.md`: AdapterManifest with ConfigField descriptors. Manifests are self-describing — client renders forms without adapter-specific code.
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Four-tab panel, wizard state, SSE connection tracking. AdaptersTab is an inner function (~173 lines, should be extracted).
- `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx`: Shows `metrics.totalMessages` labeled "today" but query has no date filter. "Today" is a lie.
- `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx`: Ghost preview component with hardcoded example rows. Exists but is NOT imported anywhere. Dead code.
- `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx`: Flat list rendering. Has `REASON_CONFIG` with color-coded reason badges, but no aggregation. Each dead letter is an individual row.
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`: Uses `useRelayConversations` (polls every 5s). SSE stream updates a *different* query key — the two are disconnected.
- `apps/client/src/layers/features/relay/ui/ConversationRow.tsx`: 411 lines. Three levels of progressive disclosure. "Route" quick-action has a latent bug: `extractAdapterId` returns empty string for current subject formats.
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`: 477 lines. Manifest-driven form, auto-populates label from bot username on successful test. Best UX in the panel.
- `apps/client/src/layers/features/relay/ui/BindingList.tsx`: Standalone flat list. Imports from `entities/binding` (cross-entity coupling). Functionally redundant with AdapterCard inline bindings.
- `apps/client/src/layers/features/relay/ui/EndpointList.tsx`: Uses `as Record<string, unknown>` cast — insufficiently typed. Shows single system-generated endpoint.
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`: SSE injects into `['relay', 'messages', undefined]` but Activity Feed reads `['relay', 'conversations']`. Disconnected.
- `apps/client/src/layers/entities/relay/model/use-adapter-catalog.ts`: `useAddAdapter` fires toast on success — duplicates wizard's own toast. Double toast bug.
- `apps/client/src/layers/entities/relay/model/use-dead-letters.ts`: `DeadLetter` type defined locally, not from `@dorkos/shared`. No Zod validation on client.
- `apps/server/src/services/relay/trace-store.ts`: `getMetrics()` has no date filter — `totalMessages` is all-time, not "today". P95 latency hardcoded to `null`.
- `apps/server/src/services/relay/binding-store.ts`: Resolution algorithm is clean. Legacy field stripping (`projectPath`, `agentDir`) should be removed post-migration.
- `apps/server/src/services/relay/adapter-manager.ts`: 588 lines. Orphan bindings warned but not cleaned on adapter removal.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` — Tab container, wizard state, SSE tracking
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` — Conversation list with filters
- `apps/client/src/layers/features/relay/ui/BindingList.tsx` — Standalone binding CRUD (to be removed)
- `apps/client/src/layers/features/relay/ui/EndpointList.tsx` — Endpoint list + InboxView (to be removed)
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` — 4-step wizard
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` — Configured adapter with inline bindings
- `apps/client/src/layers/features/relay/ui/CatalogCard.tsx` — Available adapter card
- `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx` — Stats bar (to be redesigned)
- `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx` — Flat dead letter list (to be redesigned)
- `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx` — Ghost preview (unused, to be connected)
- `apps/client/src/layers/features/relay/ui/ConversationRow.tsx` — Progressive disclosure conversation card
- `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx` — SSE connection state banner
- `apps/client/src/layers/features/relay/ui/DeliveryMetrics.tsx` — Metrics dashboard dialog

**Shared Dependencies:**

- `apps/client/src/layers/entities/relay/model/` — All relay data hooks (TanStack Query)
- `apps/client/src/layers/entities/binding/` — Binding entity hooks (cross-entity)
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` — Shared binding form
- `packages/shared/src/relay-adapter-schemas.ts` — AdapterBinding, AdapterManifest, ConfigField schemas
- `packages/shared/src/relay-envelope-schemas.ts` — RelayConversation, StandardPayload
- `packages/shared/src/relay-trace-schemas.ts` — DeliveryMetrics, TraceSpan

**Data Flow:**

```
AdapterManager (server) → REST API → TanStack Query hooks → RelayPanel tabs
TraceStore (server) → REST API → useDeliveryMetrics/useDeadLetters → HealthBar/DeadLetterSection
RelayCore SSE → useRelayEventStream → ['relay','messages'] cache (DISCONNECTED from Activity Feed)
Polling → useRelayConversations (5s) → ActivityFeed (actual data source)
```

**Feature Flags/Config:**

- `relay` feature flag via `useFeatureEnabled('relay')` — gates entire panel
- `RELAY_ENABLED` env var server-side

**Potential Blast Radius:**

- Direct: ~15 files in `features/relay/ui/` and `entities/relay/model/`
- Indirect: `features/mesh/ui/BindingDialog.tsx` (shared binding form), sidebar `ConnectionsView`
- Tests: Relay feature tests, binding entity tests
- Server: `trace-store.ts` (date filter), `adapter-manager.ts` (orphan cleanup), `use-adapter-catalog.ts` (double toast)

---

## 4) Root Cause Analysis

N/A — this is a design overhaul, not a bug fix. However, several bugs were discovered during review:

| Bug | Location | Impact |
|-----|----------|--------|
| "Today" shows all-time count | `trace-store.ts` `getMetrics()` — no date filter | Misleading health bar data |
| SSE disconnected from Activity Feed | `use-relay-event-stream.ts` updates wrong query key | Activity Feed polls at 5s instead of real-time |
| Double toast on adapter add | `use-adapter-catalog.ts` + `AdapterSetupWizard.tsx` both fire toast | Duplicate notification |
| `extractAdapterId` returns empty | `ConversationRow.tsx` regex doesn't match current subjects | Quick-route creates broken bindings |
| `RelayEmptyState` unused | Component exists, not imported | Designed empty state wasted |
| P95 latency hardcoded null | `trace-store.ts` — "p95 via offset not ported" | Metrics dashboard always shows "—" |
| AdapterEventLog uncaught parse | `JSON.parse(metadata)` in render with no try/catch | Potential crash on malformed data |

---

## 5) Research

### Potential Solutions

**1. Incremental Fix — Patch bugs, keep 4-tab structure**

- Description: Fix the data bugs (today label, SSE disconnect, double toast), wire in RelayEmptyState, aggregate dead letters. Keep the 4-tab structure.
- Pros: Minimal code change, low risk, fast to ship
- Cons: Doesn't address the fundamental IA problem (4 system-concept tabs vs user-task tabs). Bindings remain in 6 places. Kai still navigates 4 tabs for one mental concept.
- Complexity: Low
- Maintenance: Low

**2. Full IA Restructure — Two tabs (Connections + Activity)**

- Description: Merge Adapters + Bindings into "Connections" tab. Remove Endpoints tab. Dead letters become a filter state on Activity, not a separate section. Semantic health status replaces raw stats. Empty states overhauled. Wizard refined.
- Pros: Matches user mental model. Eliminates redundancy. Aligns with ADR-0038 and ADR-0107 direction. Validated by Jobs/Ive critique and bindings review independently.
- Cons: Larger scope. Requires careful migration of the 6 binding surfaces. BindingList.tsx and EndpointList.tsx are removed entirely.
- Complexity: High
- Maintenance: Lower long-term (less surface area)

**3. Radical Simplification — Single view, no tabs**

- Description: Eliminate tabs entirely. Show a single view: connection cards at top, activity stream below, failures inline. Everything on one scrollable page.
- Pros: Zero navigation. Everything visible at once. Maximizes Priya's flow preservation.
- Cons: Doesn't scale well beyond ~5-6 adapters. Activity stream competes with connection cards for attention. No clear place for the adapter catalog.
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Recommended Approach: Full IA Restructure (Option 2)**

This is the clear winner. Both the Jobs/Ive critique and the independent bindings review converge on the same conclusion: merge Adapters + Bindings, remove Endpoints, collapse to two tabs. ADR-0038 provides the architectural pattern. ADR-0107 validates the "Connections" naming. The Adapters tab already shows bindings inline — the merge is 80% done.

The radical single-view option (3) was considered but rejected because it doesn't scale to Kai's use case (10-20 sessions across 5 projects with multiple adapters). Two tabs provide a clean separation between configuration (Connections) and monitoring (Activity) without the overhead of four.

### Caveats

- The wizard is already strong — resist the urge to redesign it. Light refinements only.
- Binding permissions (`canInitiate`) are a new schema field. This requires a shared schema update and server-side enforcement, not just UI.
- The "Connections" tab in the sidebar (spec #117) and the "Connections" tab in the Relay Panel are different surfaces. The sidebar shows per-agent adapter status; the panel shows the full adapter management view. The naming alignment is intentional but the relationship should be clear.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Tab structure | Two tabs: Connections + Activity | Both the design critique and bindings review independently concluded four tabs is too many. Adapters+Bindings are one concept to the user. Endpoints is an implementation detail. |
| 2 | Health bar design | Semantic status indicator (healthy/degraded/critical) | Raw numbers without context destroy trust. Jobs: "Lead with the story, not the data." The 90% failure rate should be impossible to miss, not hidden in four equal-weight stats. |
| 3 | Dead letter presentation | Aggregated failure insights grouped by source+error | 15,044 identical rows is hostile UX. Group by source+error+timewindow with counts. Provide actions (dismiss, configure, view sample). |
| 4 | Empty states | Connect existing `RelayEmptyState` ghost preview; overhaul all empty state copy | The component already exists and is unused. ADR-0038 Mode A/B provides the pattern. Each empty state must communicate what, why, and what-to-do-next. |
| 5 | Wizard changes | Light-touch: remove Adapter ID field, fix stepper, add Back/Cancel | The wizard is the strongest UX surface. The manifest-driven form system is excellent. Don't redesign — refine. |
| 6 | Binding permissions | Add `canInitiate` (default false), `canReply` (default true), `canReceive` (default true) to binding schema | Kai's #1 safety concern for overnight autonomous runs. Permissions belong on bindings (routing decision point), not adapters (dumb protocol bridges). Conservative defaults. |
| 7 | Session strategy visibility | Hide behind "Advanced" toggle, only show badge when non-default | Every binding shows "Per Chat" — if there's only one option in practice, it's noise. Default to per-chat and hide unless deviant. |
| 8 | Orphan binding cleanup | Auto-clean when adapter is removed | Currently logged as warning and left in place. Stale bindings confuse routing and clutter the UI. |
| 9 | Bug fixes (P0) | Fix "today" label, SSE→conversations wiring, double toast, extractAdapterId | These are data integrity and trust bugs that must ship before or alongside the redesign. |
