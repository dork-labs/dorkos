---
slug: relay-adapter-dx
number: 119
created: 2026-03-11
status: ideation
---

# Relay Adapter DX Improvements

**Slug:** relay-adapter-dx
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/relay-adapter-dx

---

## 1) Intent & Assumptions

- **Task brief:** Resolve the DX gaps discovered during an architecture review of the relay adapter system. The current adapter authoring experience requires every adapter to independently implement ~30+ lines of identical boilerplate (status tracking, error recording, idempotency guards, relay ref lifecycle). The plugin loader has a factory signature bug where the adapter `id` parameter is never passed. Test files are co-located inconsistently. There is no API versioning mechanism, no compliance test suite, and no standardized directory structure. These gaps create friction for both internal adapter development and future third-party adapter authors.

- **Assumptions:**
  - The `RelayAdapter` interface is stable and well-designed (Grade A from review) — we are not changing its shape
  - The `AdapterRegistry` and `AdapterManager` routing/lifecycle management is sound — no changes there
  - The `AdapterManifest` schema and catalog system are solid — no fundamental changes
  - Three built-in adapters (Telegram, Claude Code, Webhook) serve as the reference implementations
  - Future third-party adapter authors will install `@dorkos/relay` as a peer dependency
  - The base class is optional — adapters that implement `RelayAdapter` directly remain fully supported

- **Out of scope:**
  - CLI scaffold command (`dorkos adapter init`) — follow-up work
  - Adapter marketplace or registry — future roadmap
  - Changes to AdapterRegistry, AdapterManager, or routing logic
  - Changes to the relay publish pipeline
  - Breaking changes to the `RelayAdapter` interface
  - Adapter hot-reload mechanism changes

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: RelayAdapter interface (lines 262-313), AdapterStatus type (322-328), AdapterContext (336-359), DeliveryResult (367-377). Well-structured with clear TSDoc.
- `packages/relay/src/adapter-plugin-loader.ts`: Factory signature `(config) => RelayAdapter` at line 32 — **missing `id` parameter**. `validateAdapterShape()` (lines 182-201) duck-type validates all 7 required members.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: 226 lines. Has dedicated `recordError()` method (lines 216-225). Status init at 78-82. Idempotency guard at 105.
- `packages/relay/src/adapters/webhook-adapter.ts`: 437 lines (exceeds 300-line threshold). Monolithic file — not in a subdirectory. Status init at 121-125. Error recording inline at 260-266, 312-317, 331-337.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`: 256 lines. Status init at 114-118. Error recording inline at 240-246. Has custom `queuedMessages` field.
- `packages/relay/src/index.ts`: Public API exports (lines 106-118). No base class, no testing utilities, no version constant exported.
- `apps/server/src/services/relay/adapter-factory.ts`: Built-in adapter instantiation (lines 62-97). Has `defaultAdapterStatus()` at lines 42-48 — NOT shared with adapters.
- `packages/test-utils/src/mock-factories.ts`: `createMockAdapter()` at lines 286-303. No `createMockRelayPublisher()` or `createMockRelayEnvelope()`.
- `contributing/relay-adapters.md`: 1018-line comprehensive guide. Missing: base class guidance, factory pattern documentation, test compliance patterns.
- `decisions/0030-dynamic-import-for-adapter-plugins.md`: Covers factory export pattern. No mention of `id` parameter.
- `decisions/0045-adapter-manifest-self-declaration.md`: Deprecated, merged into ADR-0044.

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/relay/src/types.ts` — RelayAdapter interface, AdapterStatus, AdapterContext, DeliveryResult
- `packages/relay/src/adapter-plugin-loader.ts` — Dynamic import loader, factory validation, duck-type checking
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Telegram Bot API adapter (226 lines)
- `packages/relay/src/adapters/webhook-adapter.ts` — Generic webhook adapter (437 lines, monolithic)
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` — Claude Code session adapter (256 lines)
- `packages/relay/src/index.ts` — Package public API barrel exports
- `apps/server/src/services/relay/adapter-factory.ts` — Built-in adapter instantiation + `defaultAdapterStatus()`
- `apps/server/src/services/relay/adapter-manager.ts` — Runtime lifecycle management

**Shared Dependencies:**

- `@dorkos/shared/relay-schemas` — AdapterManifest, AdapterConfig, AdapterStatus schemas
- `@dorkos/shared/logger` — Logger interface used by plugin loader
- `packages/test-utils/src/mock-factories.ts` — `createMockAdapter()` for testing

**Data Flow:**
Config → `adapter-plugin-loader.ts` loads module → factory function called → `RelayAdapter` instance → `AdapterRegistry.register()` → `AdapterManager` manages lifecycle → `RelayCore.publish()` routes to adapter via `AdapterRegistry.deliver()`

**Feature Flags/Config:**

- `PluginAdapterConfig.enabled` — per-adapter enable/disable flag
- `PluginAdapterConfig.builtin` — distinguishes built-in from plugin adapters

**Potential Blast Radius:**

- Direct: 7 files (types.ts, plugin-loader, 3 adapters, index.ts, adapter-factory.ts)
- Indirect: 15+ files import from `@dorkos/relay`
- Tests: 5 test files across adapters + adapter-registry + relay roundtrip
- All existing imports must continue to work via re-exports (no breaking changes)

## 4) Root Cause Analysis

Not applicable — this is a DX improvement, not a bug fix.

## 5) Research

Research saved to: `research/20260311_relay_adapter_sdk_design.md`

18 web searches + 12 web fetches across VS Code, Obsidian, Rollup, Vite, Fastify, Elysia, unplugin, Socket.IO, Winston, abstract-blob-store, OpenTelemetry, tRPC, Figma, and Azure SDK.

### Potential Solutions

**1. BaseRelayAdapter Abstract Class (Optional)**

- Description: Add an optional abstract class that handles the 30+ lines of boilerplate every adapter reimplements: status tracking state machine, idempotency guards on start/stop, relay ref lifecycle, `_trackDelivery()` helper, and a complete `getStatus()` implementation. Subclasses implement `_start()`, `stop()`, and `deliver()`.
- Pros: Eliminates 24+ lines of duplicated status init, 15+ lines of error recording, 5+ idempotency guard clauses. Confirmed by Obsidian (Plugin extends Component), Winston (TransportStream extends Writable), and Socket.IO (Adapter extends EventEmitter) patterns.
- Cons: Adds inheritance to the stack. Some developers prefer composition. The base class must NOT wrap `deliver()` in try/catch (that's AdapterRegistry's job).
- Complexity: Medium
- Maintenance: Low — the base class changes rarely once stable

**2. Fix Plugin Factory Signature**

- Description: Update `AdapterPluginModule.default` from `(config) => RelayAdapter` to `(id: string, config: Record<string, unknown>) => RelayAdapter`. Update the plugin loader to pass `entry.id` to factory functions.
- Pros: Fixes a confirmed bug — adapter `id` is currently lost during plugin loading. Aligns with built-in adapter instantiation pattern.
- Cons: Breaking change for any existing third-party adapters (none known yet). Must update docs and template.
- Complexity: Low
- Maintenance: Low

**3. API Versioning**

- Description: Export `RELAY_ADAPTER_API_VERSION` from `@dorkos/relay`. Add optional `apiVersion` field to `AdapterManifest`. Plugin loader checks `semver.satisfies` at load time with warning-level log on mismatch (not hard block). Modeled on VS Code's `engines.vscode`, Figma's `"api"` field, Obsidian's `minAppVersion`.
- Pros: Enables safe evolution of the adapter API. Prevents cryptic runtime errors when an adapter was built against an incompatible API version.
- Cons: Adds a dependency on semver (already in use in the monorepo). Requires maintaining a version constant.
- Complexity: Low
- Maintenance: Low — bump version on interface changes

**4. Compliance Test Suite**

- Description: Export `runAdapterComplianceSuite(options)` from `@dorkos/relay/testing`. Tests shape compliance, start/stop idempotency, getStatus() shape, deliver() return shape, error tracking increments, and testConnection() if present. Also export `createMockRelayPublisher()` and `createMockRelayEnvelope()`. Modeled on `abstract-blob-store` and `abstract-winston-transport` patterns.
- Pros: "Does it pass the compliance suite?" becomes the definitive answer to "does my adapter work?" Eliminates the guesswork for third-party authors.
- Cons: Must be maintained as the interface evolves. Could give false confidence if tests don't cover all edge cases.
- Complexity: Medium
- Maintenance: Medium — update when RelayAdapter interface changes

**5. Standardize Directory Structure**

- Description: Move `webhook-adapter.ts` into a `webhook/` directory (matching telegram/ and claude-code/ patterns). Move telegram tests from `src/__tests__/adapters/` into `src/adapters/telegram/__tests__/`. Establish canonical per-adapter structure.
- Pros: Consistency. Makes the pattern obvious for new adapters. Test co-location follows project conventions.
- Cons: Requires updating import paths in consumers. Existing imports must continue working via re-exports.
- Complexity: Low
- Maintenance: None

**6. Adapter Template Repository**

- Description: Create a `templates/relay-adapter/` directory in the monorepo (or a separate `relay-adapter-template` repo) with a working no-op adapter, compliance tests pre-wired, correct package.json with keywords and peer deps, and a step-by-step README. Target: "working adapter in under 5 minutes."
- Pros: Highest-leverage investment for ecosystem growth. VS Code, Obsidian, and ESLint all cite their templates as the #1 driver of plugin adoption.
- Cons: Must be maintained in sync with API changes. Template rot is real.
- Complexity: Low
- Maintenance: Medium — update on API changes

### Recommendation

Implement all six. They are independent and can be developed in any order. The priority order based on impact:

1. **Fix plugin factory signature** (bug fix, blocks ecosystem)
2. **BaseRelayAdapter** (eliminates most boilerplate, improves DX)
3. **Standardize directory structure** (consistency, low effort)
4. **Compliance test suite** (quality gate for adapters)
5. **API versioning** (future-proofing)
6. **Adapter template** (ecosystem growth, depends on 1-5 being stable)

## 6) Decisions

| #   | Decision                      | Choice                                                     | Rationale                                                                                                                                                                                             |
| --- | ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Base class approach           | Optional abstract class (`BaseRelayAdapter`)               | Research confirms this pattern across Obsidian, Winston, Socket.IO. The interface remains the contract; the class is a convenience. Adapters that implement `RelayAdapter` directly continue to work. |
| 2   | Base class error handling     | Re-throw errors, don't silently catch                      | Per OpenTelemetry spec: the host (AdapterRegistry) handles isolation. The base class tracks state but lets errors propagate so plugin authors see failures during development.                        |
| 3   | Factory signature fix         | Add `id` parameter: `(id: string, config) => RelayAdapter` | The `id` is required by the RelayAdapter interface. Losing it during plugin loading is a bug, not a design choice.                                                                                    |
| 4   | API versioning strategy       | SemVer with warning-level log on mismatch                  | Hard-blocking on version mismatch would break adapters unnecessarily. Warnings give adapter authors time to update. Post-1.0 = SemVer guarantees; pre-1.0 = no guarantees.                            |
| 5   | Compliance suite location     | `packages/relay/src/testing/` sub-export                   | Adapter authors install `@dorkos/relay` as a peer dep anyway. Having the test utilities in the same package avoids version coordination issues.                                                       |
| 6   | Webhook adapter restructuring | Move into `webhook/` directory matching other adapters     | Consistency is a feature. Three adapters should follow the same directory convention.                                                                                                                 |
| 7   | Template location             | `templates/relay-adapter/` in monorepo initially           | Can be promoted to a standalone GitHub template repo later. Starting in-monorepo avoids maintenance overhead.                                                                                         |
