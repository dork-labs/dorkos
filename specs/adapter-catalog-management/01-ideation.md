---
slug: adapter-catalog-management
number: 67
created: 2026-02-27
status: ideation
---

# Adapter Catalog & Management UI

**Slug:** adapter-catalog-management
**Author:** Claude Code
**Date:** 2026-02-27
**Related:** Spec 53 (relay-external-adapters), Spec 57 (relay-runtime-adapters)

---

## 1) Intent & Assumptions

- **Task brief:** Build a system where Relay adapters declare their own metadata (config schema, display info, setup instructions), the server aggregates this into a browsable catalog, and the UI provides setup wizards for adding, configuring, and removing adapters. Both built-in adapters and npm plugin adapters are supported. The goal is world-class developer experience for creating adapters and world-class user experience for managing them.
- **Assumptions:**
  - Relay is the prerequisite feature — adapters only exist within Relay
  - The existing `adapters.json` config file and chokidar hot-reload system remain the persistence layer
  - Built-in adapters (Telegram, Webhook, Claude Code) ship with DorkOS and are always available in the catalog
  - npm plugin adapters are loaded via the existing plugin loader (`adapter-plugin-loader.ts`)
  - The adapter catalog UI lives within the existing Relay panel's Adapters tab (not a new top-level panel)
- **Out of scope:**
  - Building the actual Slack adapter (separate effort)
  - CLI scaffolding tools for adapter developers (`create-dorkos-adapter`)
  - Marketplace/registry hosting for discovering remote npm packages
  - Secret storage hardening (OS keychain integration)

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: RelayAdapter interface, AdapterConfig, AdapterStatus, AdapterContext, DeliveryResult types. The adapter contract is well-defined but has no metadata/manifest concept.
- `packages/relay/src/adapter-registry.ts`: Lifecycle management (register/unregister/hot-reload), subject prefix routing, zero-downtime swaps. No catalog awareness.
- `packages/relay/src/adapter-plugin-loader.ts`: Three loading sources (built-in map, npm packages, local files). Duck-type validates adapter shape. Does not extract metadata from loaded modules.
- `packages/relay/src/adapters/telegram-adapter.ts`: Bidirectional adapter using grammy. Config needs: botToken (sensitive), mode (polling/webhook), webhookUrl (conditional on mode), webhookPort (conditional). Good test case for conditional fields.
- `packages/relay/src/adapters/webhook-adapter.ts`: HMAC-signed HTTP adapter. Config needs: inbound subject + secret, outbound URL + secret + headers. Dual-secret rotation support.
- `packages/relay/src/adapters/claude-code-adapter.ts`: Internal runtime adapter. Config needs: maxConcurrent, defaultTimeoutMs. No user-facing credentials.
- `apps/server/src/services/relay/adapter-manager.ts`: Server-side lifecycle. Loads from `~/.dork/relay/adapters.json`, hot-reloads via chokidar. Has `listAdapters()`, `enable()`, `disable()`. Missing: `addAdapter()`, `removeAdapter()`, catalog aggregation.
- `apps/server/src/routes/relay.ts`: Current endpoints: GET/POST adapters, enable/disable, webhooks. Missing: catalog endpoint, CRUD for adapter instances, connection test.
- `packages/shared/src/relay-schemas.ts`: Zod schemas for AdapterConfig, AdapterStatus, TelegramAdapterConfig, WebhookAdapterConfig. No manifest/metadata schemas.
- `packages/shared/src/transport.ts`: Transport interface has `listRelayAdapters()` and `toggleRelayAdapter()`. Missing: catalog fetch, adapter CRUD, connection test.
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Tab UI with Activity/Endpoints/Adapters. AdaptersTab is a simple list of configured adapters. Missing: catalog browsing, setup wizard, add/remove.
- `apps/client/src/layers/entities/relay/model/use-relay-adapters.ts`: TanStack Query hooks for list + toggle. Missing: catalog hook, CRUD mutations, test mutation.
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`: Displays name, type badge, status dot, message counts, toggle. Missing: configure/remove actions, icon display.
- `apps/client/src/layers/features/mesh/ui/CandidateCard.tsx`: Pattern reference — shows discovery candidates with approve/deny actions. Good model for "available adapter" cards.
- `apps/client/src/layers/features/mesh/ui/RegisterAgentDialog.tsx`: Multi-step registration wizard. Good model for adapter setup wizard.
- `contributing/relay-adapters.md`: Developer guide covering adapter interface, lifecycle, config format, security. Needs expansion for manifest/metadata declaration.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/types.ts` — adapter type definitions (needs AdapterManifest addition)
  - `packages/relay/src/adapter-plugin-loader.ts` — plugin loading (needs manifest extraction)
  - `apps/server/src/services/relay/adapter-manager.ts` — lifecycle (needs catalog + CRUD + test)
  - `apps/server/src/routes/relay.ts` — HTTP endpoints (needs catalog + CRUD + test routes)
  - `packages/shared/src/relay-schemas.ts` — Zod schemas (needs ConfigField + manifest schemas)
  - `packages/shared/src/transport.ts` — client-server contract (needs catalog + CRUD methods)
  - `apps/client/src/layers/features/relay/ui/` — Relay UI (needs catalog view + wizard)
  - `apps/client/src/layers/entities/relay/model/` — data hooks (needs catalog + CRUD hooks)
- **Shared dependencies:** shadcn/ui primitives (Dialog, Input, Select, Switch, Badge, Tabs), TanStack Query, Zustand, cn utility
- **Data flow:** AdapterManifest (declared in adapter code) -> AdapterManager aggregates -> GET /catalog -> useAdapterCatalog hook -> AdaptersTab renders catalog cards + setup wizard
- **Feature flags/config:** `DORKOS_RELAY_ENABLED` gates the entire Relay panel including adapters
- **Potential blast radius:**
  - Direct: ~10 new files (manifest types, config field types, catalog endpoint, CRUD endpoints, catalog hook, CRUD hooks, catalog UI, wizard UI, config form renderer)
  - Modified: ~8 existing files (adapter-manager.ts, relay routes, transport interface, relay-schemas, plugin loader, RelayPanel, AdapterCard, use-relay-adapters)
  - Tests: New test files for catalog endpoint, CRUD operations, config form rendering, wizard flow

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Cross-system analysis of VS Code, Grafana, n8n, Home Assistant, Raycast, Slack, and Backstage reveals a consistent pattern:

### Potential Solutions

**1. ConfigField[] Descriptor Array (n8n / Raycast pattern)**

- Description: Each adapter exports a plain `ConfigField[]` array declaring its config form fields (type, label, placeholder, sensitive flag, conditional visibility). A separate `AdapterManifest` object provides display metadata (name, description, icon, category). The client renders forms from the descriptor. The server validates with the Zod schema.
- Pros: Explicit, fully JSON-serializable, no Zod dependency on client, supports sensitive/placeholder/showWhen/section natively
- Cons: Slight duplication between ConfigField[] and Zod schema
- Complexity: Medium
- Maintenance: Low (descriptors are colocated with adapter code)

**2. Zod .meta() Serialization**

- Description: Enrich Zod schemas with `.meta()` annotations and serialize to JSON Schema via `z.toJSONSchema()`.
- Pros: Single source of truth
- Cons: JSON Schema lacks sensitive/placeholder/showWhen/section concepts, requires custom extensions anyway, couples client to Zod internals
- Complexity: High
- Maintenance: Medium

**3. Plugin-Owned UI (Grafana pattern)**

- Description: Each adapter ships its own React form component.
- Pros: Maximum flexibility per adapter
- Cons: Breaks generic UI, npm plugins would need to ship React components, massive complexity increase
- Complexity: Very High
- Maintenance: High

### Security Considerations

- Sensitive fields (tokens, secrets) must never be echoed back to clients in GET responses — replace with `"***"` or omit
- Password fields in edit mode should show "leave blank to keep current" rather than pre-filling
- adapters.json stores secrets in plaintext (acceptable for user-owned file with 600 permissions; OS keychain is a future enhancement)
- Connection test endpoint must clean up transient adapter instances to prevent resource leaks

### Recommendation

**ConfigField[] Descriptor Array** (Solution 1). It is the industry-proven pattern (n8n, Raycast, Home Assistant all use it), keeps the UI contract explicit, and avoids coupling the React client to server-side Zod schema internals. Full research at `research/20260227_adapter_catalog_patterns.md`.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Adapter install source | Built-in catalog + npm plugins | Ship built-in adapters; support npm packages for community/custom adapters |
| 2 | Config UX | Wizard preferred, file as escape hatch | UI wizard for common adapters; power users can edit adapters.json directly (hot-reload works) |
| 3 | Developer experience priority | Clear interface + docs | Well-documented RelayAdapter interface + AdapterManifest; no scaffolding CLI needed yet |
| 4 | Schema representation | ConfigField[] descriptor | Plain serializable array alongside Zod schema; n8n/Raycast pattern. UI renders from descriptor, server validates with Zod |
| 5 | UI placement | Inside Relay panel | Upgrade the Adapters tab within RelayPanel. Avoids new top-level nav item pre-launch |
| 6 | Catalog display | Show all available adapters | Two sections: "Configured" (installed instances) and "Available" (built-in types not yet added). Grafana/Home Assistant pattern |
| 7 | Connection test | Yes, with skip option | Wizard offers "Test Connection" that transiently starts the adapter. Users can skip. Requires new server endpoint |
