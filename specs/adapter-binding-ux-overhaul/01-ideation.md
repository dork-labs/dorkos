---
slug: adapter-binding-ux-overhaul
number: 120
created: 2026-03-11
status: ideation
---

# Adapter & Binding UX Overhaul

**Slug:** adapter-binding-ux-overhaul
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/adapter-binding-ux-overhaul

---

## 1) Intent & Assumptions

- **Task brief:** Overhaul the adapter and binding system to be more robust, flexible, powerful, and easier to use. Multi-instance adapter support (multiple Telegram bots), adapter naming/labeling, first-class binding management (create from Bindings tab, chatId/channelType from live data, duplicate bindings), post-adapter-setup binding flow (wizard step + amber badge), sidebar Connections view filtering, and a bug fix for the missing PATCH /bindings/:id route.

- **Assumptions:**
  - The underlying relay architecture (AdapterRegistry, BindingRouter, BindingStore, subject-based routing, most-specific-first scoring) is sound and unchanged
  - The `RelayAdapter` interface and `AdapterManifest` schema are stable
  - Only the Telegram adapter needs `multiInstance: true` for now; Claude Code stays single-instance
  - The sidebar Connections view is part of the existing `NavigationLayout` component
  - The topology/React Flow view is NOT in scope — only list/dialog/card views
  - No changes to the relay publish pipeline or message routing logic

- **Out of scope:**
  - Adapter DX improvements (BaseRelayAdapter, compliance tests) — covered by spec 119
  - Topology/React Flow visual changes
  - Adapter marketplace or plugin ecosystem
  - Mobile-specific layout changes
  - Rate limiting or access control per binding
  - Temporal status escalation (amber → orange after N days)

## 2) Pre-reading Log

- `research/20260311_adapter_binding_configuration_ux_patterns.md`: Deep research on multi-instance (Zapier auto-label), routing UX (Gmail filter-from-message), progressive disclosure (Stripe/Home Assistant), chat pickers (live data), sidebar filtering (Linear). Primary design reference.
- `research/20260311_adapter_binding_ux_overhaul_gaps.md`: Gap research on post-setup nudges (Datadog three-tier), live data pickers (Slack/Discord), duplication patterns (Zapier/n8n), status indicators (Carbon five-state).
- `decisions/0044-configfield-descriptor-over-zod-serialization.md`: ConfigField descriptors drive the setup wizard form. Adapter naming would be a new ConfigField or a first-class manifest property.
- `decisions/0046-central-binding-router-for-adapter-agent-routing.md`: BindingRouter is the central routing layer. Adapters remain dumb protocol bridges. Bindings are the routing configuration.
- `decisions/0047-most-specific-first-binding-resolution.md`: Binding resolution scoring: adapterId+chatId+channelType (7) > adapterId+chatId (5) > adapterId+channelType (3) > adapterId-only (1). Only one binding wins per message.
- `specs/adapter-agent-routing/02-specification.md`: Full binding routing spec. BindingDialog specified as session strategy + label only. No chatId/channelType UI fields. Largely implemented.
- `specs/adapter-catalog-management/02-specification.md`: Adapter catalog, setup wizard, ConfigField rendering. Largely implemented.
- `specs/sidebar-tabbed-views/02-specification.md`: Sidebar tabs: Sessions, Schedules, Connections. Connections tab exists but may need filtering support.
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Main relay panel with 4 tabs (Activity, Endpoints, Bindings, Adapters). AdaptersTab renders catalog with wizard state. BindingsTab renders BindingList with no "create" button.
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`: Configured adapter card with toggle, kebab menu (Events, Configure, Remove), status display. No binding count or status badge.
- `apps/client/src/layers/features/relay/ui/CatalogCard.tsx`: Simple catalog card with icon, name, badge, description, Add button. No multi-instance "Add Another" flow.
- `apps/client/src/layers/features/relay/ui/BindingList.tsx`: Binding list with adapter/agent resolution, edit/delete via BindingDialog. No create button, no filtering, no duplicate action.
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`: Binding create/edit dialog. Only exposes session strategy selector and label input. No adapter/agent pickers, no chatId/channelType fields.
- `apps/server/src/routes/relay.ts`: Express routes for adapters and bindings. **Missing PATCH /bindings/:id** — client sends PATCH but no server route handles it. Binding edits are broken (404).
- `apps/server/src/services/relay/binding-store.ts`: JSON file-backed binding store. CRUD + resolve() with scoring. `update()` method exists but is not wired to an Express route.
- `apps/server/src/services/relay/adapter-manager.ts`: Adapter lifecycle manager. `multiInstance` check in `addAdapter()`. `getCatalog()` returns manifests + instances.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: TELEGRAM_MANIFEST has `multiInstance: false`. Needs to change to `true`.
- `packages/shared/src/relay-adapter-schemas.ts`: AdapterBinding schema has `chatId` (optional string) and `channelType` (optional enum: dm/group/channel/thread). These fields exist in the schema but are never exposed in the UI.
- `packages/shared/src/transport.ts`: Transport interface includes `updateBinding(id, updates)`. Already defined.
- `apps/client/src/layers/shared/lib/transport/relay-methods.ts`: HttpTransport implements `updateBinding` sending PATCH. Server route is missing.

## 3) Codebase Map

**Primary Components/Modules:**

| Path                                                              | Role                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`         | Main relay panel, tabs: Activity/Endpoints/Bindings/Adapters                            |
| `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`        | Configured adapter card with status, toggle, kebab menu                                 |
| `apps/client/src/layers/features/relay/ui/CatalogCard.tsx`        | Available adapter type card in catalog                                                  |
| `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` | Adapter setup/edit wizard dialog                                                        |
| `apps/client/src/layers/features/relay/ui/BindingList.tsx`        | Binding list with edit/delete actions                                                   |
| `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`       | Binding create/edit dialog (session strategy + label)                                   |
| `apps/client/src/layers/entities/binding/`                        | Binding entity hooks: useBindings, useCreateBinding, useDeleteBinding, useUpdateBinding |
| `apps/client/src/layers/entities/relay/`                          | Relay entity hooks: useAdapterCatalog, useAddAdapter, useRemoveAdapter, etc.            |
| `apps/server/src/services/relay/adapter-manager.ts`               | Server-side adapter lifecycle (multiInstance check, CRUD, catalog)                      |
| `apps/server/src/services/relay/binding-store.ts`                 | Server-side binding CRUD + resolve() scoring                                            |
| `apps/server/src/services/relay/binding-router.ts`                | Inbound routing: relay.human._ → binding lookup → relay.agent._                         |
| `apps/server/src/routes/relay.ts`                                 | Express routes for relay (adapters, bindings, messages)                                 |
| `packages/relay/src/adapters/telegram/telegram-adapter.ts`        | Telegram adapter + manifest (multiInstance: false)                                      |
| `packages/shared/src/relay-adapter-schemas.ts`                    | All adapter/binding/catalog Zod schemas                                                 |
| `packages/shared/src/transport.ts`                                | Transport interface including binding methods                                           |
| `apps/client/src/layers/shared/lib/transport/relay-methods.ts`    | HttpTransport binding implementations                                                   |
| `apps/client/src/layers/shared/ui/navigation-layout.tsx`          | Sidebar navigation layout for dialogs                                                   |

**Shared Dependencies:**

- `@dorkos/shared/relay-schemas` — AdapterBinding, CreateBindingRequest, AdapterManifest, CatalogEntry, SessionStrategy
- `@dorkos/shared/transport` — Transport interface (hexagonal port)
- `@dorkos/test-utils/mock-factories` — Mock transport with binding stubs
- `@/layers/entities/binding` — useBindings, useCreateBinding, useDeleteBinding, useUpdateBinding
- `@/layers/entities/relay` — useAdapterCatalog, useAddAdapter, useRelayEnabled
- `@/layers/entities/mesh` — useRegisteredAgents (agent name resolution)

**Data Flow:**

1. Adapter Catalog: Server `getCatalog()` → GET `/api/relay/adapters/catalog` → `useAdapterCatalog()` → RelayPanel renders AdapterCard + CatalogCard
2. Binding CRUD: Client hooks → Transport methods → Express routes → BindingStore → `~/.dork/relay/bindings.json`
3. Inbound routing: TelegramAdapter publishes `relay.human.*` → BindingRouter → `BindingStore.resolve()` → republish to `relay.agent.*`
4. Adapter add: CatalogCard "Add" → AdapterSetupWizard → `useAddAdapter()` → `AdapterManager.addAdapter()` (validates multiInstance)

**Potential Blast Radius:**

- Direct: ~12 files (RelayPanel, AdapterCard, CatalogCard, AdapterSetupWizard, BindingList, BindingDialog, relay routes, binding-store, adapter-manager, telegram manifest, relay-adapter-schemas, transport)
- Indirect: ~8 files (relay-methods, direct-transport, mock-factories, navigation-layout, test files)
- Tests: ~6 test files (BindingList, AdapterCard, binding-store, adapter-manager, manifests, transport)

## 4) Root Cause Analysis

Not applicable — this is a UX overhaul, not a bug fix. (The missing PATCH route is a bug discovered during exploration and will be fixed as part of this work.)

## 5) Research

Two research reports were produced:

### `research/20260311_adapter_binding_configuration_ux_patterns.md`

- **Multi-instance adapters**: Zapier auto-label-from-API is the gold standard. Auto-generate labels (e.g., "Telegram (@bot_username)"), allow user override, fall back to "#2, #3" numbering.
- **Routing/binding UX**: Gmail "filter from message" pattern — create specific bindings from the message log, not proactively from a form.
- **Progressive disclosure**: Stripe checklist + Home Assistant config flow hybrid. 3-step wizard, then non-blocking inline status nudge. Binding is NOT part of the setup wizard in that recommendation.
- **Chat/channel selection**: Live-data pickers populated from message history, not manual ID entry. "Route this chat" action on conversation rows.
- **Sidebar filtering**: Linear-style contextual filtering — when an agent is selected, show only that agent's adapters/bindings.

### `research/20260311_adapter_binding_ux_overhaul_gaps.md`

- **Post-setup nudges**: Three-tier system: (1) persistent amber badge on adapter card ("No agent bound"), (2) contextual banner in adapter detail, (3) one-time toast after creation. Never block.
- **Live data pickers**: Slack `default_to_current_conversation` pattern — pre-fill context from where the user already is. Discord auto-populated selectors from server state.
- **Binding duplication**: Rename to "Add similar binding." Pre-fill creation dialog with all fields except chatId. Reset unique identifiers. Never copy tokens silently.
- **Status indicators**: Carbon Design System five-state model: green (connected + bound + flowing), blue (connected + bound + quiet), amber (connected + unbound), orange (bound + errors), red (connection failed). Dot + text label always.

### Recommendation Summary

1. **Multi-instance**: Flip Telegram `multiInstance: true`. Add `label` field to AdapterConfig schema. Auto-generate from Telegram `getMe()` API. User can override.
2. **Binding creation**: Full dialog with adapter picker, agent picker, session strategy, label. Available from Bindings tab.
3. **ChatId/channelType**: Both entry points — picker in binding dialog (from observed chats) AND "Route to Agent" on conversation rows.
4. **Post-setup**: Optional "Bind to Agent" step in setup wizard + persistent amber badge on adapter card showing binding count/status.
5. **Duplication**: "Add similar binding" action pre-fills the creation dialog.
6. **Sidebar**: Filter Connections view to show only adapters/agents relevant to the current agent.
7. **Bug fix**: Add missing PATCH /bindings/:id route.

## 6) Decisions

| #   | Decision                           | Choice                                                                  | Rationale                                                                                                                                                                                                                   |
| --- | ---------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Binding creation from Bindings tab | Full dialog with adapter + agent pickers                                | Makes bindings a first-class object. User picks adapter (dropdown), agent (dropdown), session strategy, and optional label. Matches how "New Binding" should work.                                                          |
| 2   | ChatId/channelType selection       | Both: picker in dialog + route from message log                         | Two entry points for the same action covers both workflows. Dialog picker populated from observed chats (live data). "Route to Agent" action on conversation rows auto-fills chatId.                                        |
| 3   | Post-adapter-setup nudge           | Wizard binding step + amber badge + binding visibility on adapter cards | After adapter test succeeds, offer an optional "Bind to Agent" step in the wizard. User can skip. Amber badge persists on adapter card showing "No agent bound" until resolved. Adapter cards also show their bound agents. |
| 4   | Sidebar Connections filtering      | Include in this spec                                                    | Tightly related to binding improvements. Show only bound adapters/agents for the current agent. Ensures consistency.                                                                                                        |
| 5   | Binding duplication UX             | "Add similar binding" with pre-filled dialog                            | Opens the binding creation dialog pre-filled with all fields from the source binding except chatId (must pick a different target). More transparent than silent cloning.                                                    |
| 6   | Adapter naming/labeling            | Label field on adapter config + auto-generate from API                  | Add `label` as a first-class field on AdapterConfig. Telegram auto-generates via `getMe()` (e.g., "@my_project_bot"). Display both custom label and adapter type name everywhere. User can override.                        |
| 7   | Multi-instance scope               | Telegram only for now                                                   | Flip `multiInstance: true` on Telegram manifest. Claude Code stays single-instance. Webhook already supports multi-instance.                                                                                                |
