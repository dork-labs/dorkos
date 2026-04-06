---
slug: marketplace-03-extension
number: 226
created: 2026-04-06
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 3
depends-on: [marketplace-01-foundation, marketplace-02-install]
depended-on-by: []
linear-issue: null
---

# Marketplace 03: Marketplace Extension (Browse UI) — Technical Specification

**Slug:** marketplace-03-extension
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 3 of 5

---

## Overview

This spec ships **Dork Hub** — the in-app marketplace browse experience. It's implemented as a built-in DorkOS extension (`@dorkos-builtin/marketplace`) that registers a `sidebar.tabs` entry, fetches data from the marketplace HTTP API (spec 02), and presents a browse/search/install UI leading with the Agent App Store framing.

After this spec ships, users can discover and install packages without leaving DorkOS. The CLI from spec 02 still works; the built-in extension is the visual layer on top.

### Why

A marketplace nobody can browse is a marketplace nobody uses. The CLI install flow from spec 02 works, but the flywheel needs visual discovery. A built-in extension also dogfoods the extension system from spec 173 and proves that Dork Hub itself could be replaced or extended by the community.

### Source Documents

- `specs/marketplace-03-extension/01-ideation.md` — This spec's ideation
- `specs/dorkos-marketplace/01-ideation.md` — Parent project ideation
- `specs/marketplace-02-install/02-specification.md` — HTTP API consumed by this UI
- `specs/plugin-extension-system/` — Extension system (spec 173)
- `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx` — Existing template picker (extended)
- `contributing/design-system.md` — Calm Tech design language
- `contributing/animations.md` — Motion library patterns

---

## Goals

- Ship `@dorkos-builtin/marketplace` as a built-in extension auto-installed on first run
- Implement Dork Hub browse UI with featured rail, filters, search, detail sheet
- Implement install/uninstall/update flows with permission preview confirmation
- Implement marketplace source management UI
- Integrate marketplace into existing TemplatePicker (additive — doesn't replace built-ins)
- Cover empty/loading/error/offline states
- Comprehensive Vitest + React Testing Library coverage
- Adhere to Calm Tech design system

## Non-Goals

- Backend install API (spec 02)
- Web marketplace page (spec 04)
- Registry content (spec 04)
- MCP server (spec 05)
- Reviews / ratings (deferred)
- Live preview / try-before-install (deferred)
- Personal marketplace publishing UI (spec 05)

---

## Technical Dependencies

| Dependency              | Version       | Purpose                             |
| ----------------------- | ------------- | ----------------------------------- |
| `@dorkos/marketplace`   | `workspace:*` | Schemas + types from spec 01        |
| `@dorkos/extension-api` | `workspace:*` | Extension API for slot registration |
| `@dorkos/shared`        | `workspace:*` | Transport interface                 |
| React 19                | (existing)    | UI framework                        |
| TanStack Query          | (existing)    | Server state management             |
| Zustand                 | (existing)    | UI state                            |
| shadcn/ui               | (existing)    | UI primitives                       |
| motion                  | (existing)    | Animations                          |
| streamdown              | (existing)    | Markdown rendering for READMEs      |

No new external dependencies.

---

## Detailed Design

### Built-in Extension Structure

Dork Hub ships as a built-in extension under `apps/server/src/builtin-extensions/marketplace/`. On server startup, an `ensureBuiltinMarketplaceExtension()` helper (mirrors `ensureDorkBot()` pattern) installs/updates it.

```
apps/server/src/builtin-extensions/marketplace/
├── extension.json                 # Manifest
├── index.ts                       # Client entry point (registers slot)
└── server.ts                      # Server entry point (proxies marketplace API)

apps/server/src/services/builtin-extensions/
└── ensure-marketplace.ts          # Installs the built-in on startup
```

The extension itself uses the standard extension API but the UI components live in the client codebase under FSD layers (since they're rich React components, not bundled into the extension itself).

### Client Module Layout (FSD)

```
apps/client/src/layers/
├── entities/marketplace/
│   ├── model/
│   │   ├── use-marketplace-sources.ts        # TanStack Query: list sources
│   │   ├── use-add-marketplace-source.ts     # Mutation
│   │   ├── use-remove-marketplace-source.ts  # Mutation
│   │   ├── use-marketplace-packages.ts       # Query: list packages
│   │   ├── use-marketplace-package.ts        # Query: package detail
│   │   ├── use-permission-preview.ts         # Query: build preview
│   │   ├── use-install-package.ts            # Mutation
│   │   ├── use-uninstall-package.ts          # Mutation
│   │   ├── use-update-package.ts             # Mutation
│   │   └── use-installed-packages.ts         # Query
│   └── index.ts
├── features/marketplace/
│   ├── ui/
│   │   ├── DorkHub.tsx                       # Main page component
│   │   ├── DorkHubHeader.tsx                 # Search + filters
│   │   ├── FeaturedAgentsRail.tsx            # Hero rail
│   │   ├── PackageGrid.tsx                   # Browse grid
│   │   ├── PackageCard.tsx                   # Card in grid
│   │   ├── PackageDetailSheet.tsx            # Slide-in detail
│   │   ├── PermissionPreviewSection.tsx      # Permission display
│   │   ├── InstallConfirmationDialog.tsx     # Modal
│   │   ├── InstallProgressToast.tsx          # Toast with progress
│   │   ├── InstalledPackagesView.tsx         # Manage installed
│   │   ├── MarketplaceSourcesView.tsx        # Source management
│   │   ├── PackageTypeBadge.tsx              # Visual type indicator
│   │   ├── PackageEmptyState.tsx
│   │   ├── PackageErrorState.tsx
│   │   └── PackageLoadingSkeleton.tsx
│   ├── lib/
│   │   ├── package-filter.ts                 # Filter logic
│   │   ├── package-sort.ts                   # Sort logic
│   │   └── format-permissions.ts             # Permission preview formatting
│   ├── __tests__/
│   │   ├── DorkHub.test.tsx
│   │   ├── PackageCard.test.tsx
│   │   ├── PackageDetailSheet.test.tsx
│   │   ├── InstallConfirmationDialog.test.tsx
│   │   ├── package-filter.test.ts
│   │   └── package-sort.test.ts
│   └── index.ts
├── widgets/marketplace/
│   ├── DorkHubPage.tsx                       # Top-level widget
│   └── index.ts
└── shared/lib/transport/
    └── marketplace-methods.ts                # Transport methods for marketplace API
```

### Routing

Dork Hub gets its own route via TanStack Router:

```typescript
// apps/client/src/router.tsx (modified)
const dorkHubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/marketplace',
  component: DorkHubPage,
});
```

The built-in extension also registers a `sidebar.tabs` entry pointing at `/marketplace` so it shows up in navigation.

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  Sidebar              │  Dork Hub                                 │
│  ─────────            │  ─────────                                │
│  Dashboard            │  ┌────────────────────────────────────┐  │
│  Agents               │  │  🔍 Search packages...             │  │
│  Tasks                │  └────────────────────────────────────┘  │
│  ▶ Dork Hub  ◀ active │  [All] [Agents] [Plugins] [Skills] [Adapters] │
│  Settings             │                                           │
│                       │  ┌─ Featured Agents ─────────────────┐  │
│                       │  │  🌐 Next.js  📦 Express  🔍 Code  │  │
│                       │  │     Agent      Agent      Reviewer│  │
│                       │  └────────────────────────────────────┘  │
│                       │                                           │
│                       │  All Packages                             │
│                       │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│                       │  │ Pkg1 │ │ Pkg2 │ │ Pkg3 │ │ Pkg4 │    │
│                       │  └──────┘ └──────┘ └──────┘ └──────┘    │
│                       │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│                       │  │ Pkg5 │ │ Pkg6 │ │ Pkg7 │ │ Pkg8 │    │
│                       │  └──────┘ └──────┘ └──────┘ └──────┘    │
└──────────────────────────────────────────────────────────────────┘
```

When a card is clicked, a sheet slides in from the right with the package detail view (does NOT navigate away from the browse list).

### Package Card Component

```typescript
interface PackageCardProps {
  package: MarketplacePackageEntry;
  installed?: boolean;
  onClick: () => void;
}

// Visual structure:
// ┌────────────────────┐
// │ 🔍                 │  ← icon + featured badge if applicable
// │ Code Reviewer      │  ← display name
// │ AGENT              │  ← type badge
// │                    │
// │ Reviews your PRs   │  ← truncated description
// │ every weekday      │
// │                    │
// │ ★ 1,247 installs   │  ← install count (from telemetry, spec 04)
// │ [Install →]        │  ← action button
// └────────────────────┘
```

### Permission Preview Section

When the user clicks Install (or opens the detail sheet), the permission preview is fetched and rendered:

```typescript
// PermissionPreviewSection.tsx
function PermissionPreviewSection({ preview }: { preview: PermissionPreview }) {
  return (
    <div className="space-y-4">
      <Section title="What this package will do">
        {preview.fileChanges.length > 0 && (
          <Item icon="file" label={`${preview.fileChanges.length} files will be created`} />
        )}
        {preview.extensions.map(ext => (
          <Item icon="puzzle" label={`Register UI extension: ${ext.id}`} />
        ))}
        {preview.tasks.map(task => (
          <Item icon="clock" label={`Schedule task: ${task.name}${task.cron ? ` (${task.cron})` : ''}`} />
        ))}
      </Section>

      {preview.secrets.length > 0 && (
        <Section title="Secrets required">
          {preview.secrets.map(secret => (
            <Item icon="key" label={secret.key} required={secret.required} description={secret.description} />
          ))}
        </Section>
      )}

      {preview.externalHosts.length > 0 && (
        <Section title="External hosts">
          {preview.externalHosts.map(host => (
            <Item icon="globe" label={host} />
          ))}
        </Section>
      )}

      {preview.requires.length > 0 && (
        <Section title="Dependencies">
          {preview.requires.map(dep => (
            <Item
              icon={dep.satisfied ? 'check' : 'alert'}
              label={`${dep.type}:${dep.name}${dep.version ? `@${dep.version}` : ''}`}
              warning={!dep.satisfied}
            />
          ))}
        </Section>
      )}

      {preview.conflicts.length > 0 && (
        <Section title="Conflicts" tone="warning">
          {preview.conflicts.map(conflict => (
            <Item icon="alert" label={conflict.description} severity={conflict.level} />
          ))}
        </Section>
      )}
    </div>
  );
}
```

### Install Confirmation Dialog

```
┌──────────────────────────────────────────────────────┐
│  Install Code Reviewer?                              │
│  ────────────────────                                │
│                                                      │
│  This package will:                                  │
│   • Create 12 files in ~/.dork/agents/code-reviewer/ │
│   • Register UI extension: review-dashboard          │
│   • Schedule task: weekly-review (0 8 * * 5)         │
│                                                      │
│  Secrets required:                                   │
│   • LINEAR_API_KEY (required)                        │
│   • SLACK_WEBHOOK_URL (optional)                     │
│                                                      │
│  External hosts:                                     │
│   • api.linear.app                                   │
│   • hooks.slack.com                                  │
│                                                      │
│  Dependencies:                                       │
│   ✓ adapter:webhook (installed)                      │
│                                                      │
│  ⚠ Conflicts:                                        │
│   • Slot 'dashboard.sections' priority 5 already    │
│     used by 'analytics-dashboard'                    │
│                                                      │
│              [ Cancel ]   [ Install ]                │
└──────────────────────────────────────────────────────┘
```

### Install Progress Toast

After confirming, a toast appears with progress:

```
┌─────────────────────────────────────┐
│  ⟳ Installing Code Reviewer...      │
│  ▓▓▓▓▓▓▓▓░░░░░░░░  45%              │
│  Compiling extensions               │
└─────────────────────────────────────┘
```

On completion:

```
┌─────────────────────────────────────┐
│  ✓ Installed Code Reviewer          │
│  [ Configure secrets ]  [ Dismiss ] │
└─────────────────────────────────────┘
```

The "Configure secrets" action opens the existing secret settings UI for the newly-installed extension/adapter.

### TemplatePicker Integration

The existing `TemplatePicker.tsx` (used in CreateAgentDialog onboarding) gets a new section "From Dork Hub":

```typescript
// Existing TemplatePicker.tsx — modified to include marketplace agents
function TemplatePicker({ onSelect }: TemplatePickerProps) {
  const { data: builtins } = useTemplateCatalog();
  const { data: marketplaceAgents } = useMarketplacePackages({ type: 'agent' });

  return (
    <Tabs defaultValue="builtin">
      <TabsList>
        <TabsTrigger value="builtin">Built-in</TabsTrigger>
        <TabsTrigger value="marketplace">From Dork Hub</TabsTrigger>
        <TabsTrigger value="custom">Custom URL</TabsTrigger>
      </TabsList>
      <TabsContent value="builtin">{/* existing 7 templates */}</TabsContent>
      <TabsContent value="marketplace">
        <MarketplaceAgentGrid agents={marketplaceAgents} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="custom">{/* existing custom URL input */}</TabsContent>
    </Tabs>
  );
}
```

When a marketplace agent is selected, the existing CreateAgentDialog flow proceeds — it just uses the marketplace package's git source as the template URL, which the existing template-downloader.ts handles natively.

### Marketplace Source Management

A separate route `/marketplace/sources` shows configured marketplaces:

```
┌──────────────────────────────────────────────────────┐
│  Marketplace Sources                                 │
│                                                      │
│  ┌────────────────────────────────────────────────┐ │
│  │ ✓ dorkos-community                             │ │
│  │   github.com/dorkos/marketplace                 │ │
│  │   42 packages • Last refreshed 12 minutes ago   │ │
│  │   [ Refresh ]  [ Remove ]                       │ │
│  └────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────┐ │
│  │ ✓ claude-plugins-official                      │ │
│  │   github.com/anthropics/claude-plugins-official │ │
│  │   18 packages • Last refreshed 1 hour ago       │ │
│  │   [ Refresh ]  [ Remove ]                       │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  [ + Add Marketplace ]                               │
└──────────────────────────────────────────────────────┘
```

Adding a marketplace prompts for git URL + optional name, then calls `POST /api/marketplace/sources`.

### State Management

- **Server state** — TanStack Query (matches existing DorkOS pattern):
  - `marketplace-packages` — list of all packages from all sources
  - `marketplace-package-${name}` — individual package detail
  - `marketplace-permission-preview-${name}` — permission preview
  - `marketplace-installed` — list of installed packages
  - `marketplace-sources` — list of marketplace sources
- **UI state** — Zustand (matches existing pattern):
  - `dorkHubFilters` — current type filter, category filter, search query
  - `dorkHubDetailPackage` — currently-open detail sheet (or null)
  - `dorkHubInstallConfirmPackage` — package pending install confirmation

### Transport Methods

Add `marketplace-methods.ts` to the transport layer:

```typescript
// apps/client/src/layers/shared/lib/transport/marketplace-methods.ts
export const marketplaceMethods = {
  listPackages: (filter?: PackageFilter): Promise<MarketplacePackageEntry[]> =>
    fetchJson('/api/marketplace/packages', { params: filter }),
  getPackage: (name: string): Promise<MarketplacePackageDetail> =>
    fetchJson(`/api/marketplace/packages/${name}`),
  getPermissionPreview: (name: string): Promise<PermissionPreview> =>
    fetchJson(`/api/marketplace/packages/${name}/preview`, { method: 'POST' }),
  install: (name: string, opts?: InstallOptions): Promise<InstallResult> =>
    fetchJson(`/api/marketplace/packages/${name}/install`, { method: 'POST', body: opts }),
  uninstall: (name: string, purge?: boolean): Promise<void> =>
    fetchJson(`/api/marketplace/packages/${name}/uninstall`, { method: 'POST', body: { purge } }),
  listInstalled: (): Promise<InstalledPackage[]> => fetchJson('/api/marketplace/installed'),
  listSources: (): Promise<MarketplaceSource[]> => fetchJson('/api/marketplace/sources'),
  addSource: (source: AddSourceInput): Promise<void> =>
    fetchJson('/api/marketplace/sources', { method: 'POST', body: source }),
  removeSource: (name: string): Promise<void> =>
    fetchJson(`/api/marketplace/sources/${name}`, { method: 'DELETE' }),
};
```

### Dev Playground Showcase

A `MarketplaceShowcases.tsx` is added under `apps/client/src/dev/showcases/` with sample data for visual testing of:

- Browse grid (empty / loaded / error)
- Package detail sheet
- Install confirmation dialog
- Featured rail
- Marketplace source management

Mirrors existing playground showcase patterns.

---

## Implementation Phases

### Phase 1 — Transport & Hooks

- `marketplace-methods.ts`
- `entities/marketplace/model/*` hooks
- Tests with mock transport

### Phase 2 — Browse UI Core

- `DorkHub.tsx`, `PackageGrid.tsx`, `PackageCard.tsx`
- `DorkHubHeader.tsx` with search + tabs
- `FeaturedAgentsRail.tsx`
- Empty/loading/error states
- Visual playground showcase

### Phase 3 — Package Detail & Install

- `PackageDetailSheet.tsx`
- `PermissionPreviewSection.tsx`
- `InstallConfirmationDialog.tsx`
- `InstallProgressToast.tsx`
- Install/uninstall mutations wired

### Phase 4 — Installed Management

- `InstalledPackagesView.tsx`
- Update notifications
- Uninstall flow with --purge option

### Phase 5 — Sources Management

- `MarketplaceSourcesView.tsx`
- Add/remove source UI

### Phase 6 — TemplatePicker Integration

- Modify existing `TemplatePicker.tsx` to add "From Dork Hub" tab
- Filter marketplace by `type: agent`

### Phase 7 — Built-in Extension Wiring

- `apps/server/src/builtin-extensions/marketplace/`
- `ensure-marketplace.ts` startup helper
- Sidebar tab registration

### Phase 8 — Polish & Tests

- Animations (motion patterns from contributing/animations.md)
- Accessibility (keyboard nav, screen reader labels)
- Cross-browser testing
- Documentation updates

---

## Testing Strategy

### Unit Tests

Each component has React Testing Library tests covering:

- Renders with various props
- Empty / loading / error states
- User interactions (clicks, search input, filter changes)
- Mocked TanStack Query data

### Integration Tests

- End-to-end browse → detail → install flow with mock transport
- TemplatePicker with marketplace data integration

### Visual Tests (Playground)

- Showcase entries for each major component
- Hot reload during development

---

## File Structure

### New files

```
apps/client/src/layers/entities/marketplace/         (model hooks + index.ts)
apps/client/src/layers/features/marketplace/         (UI components, lib, tests)
apps/client/src/layers/widgets/marketplace/          (top-level widget)
apps/client/src/layers/shared/lib/transport/marketplace-methods.ts
apps/client/src/dev/showcases/MarketplaceShowcases.tsx
apps/server/src/builtin-extensions/marketplace/
apps/server/src/services/builtin-extensions/ensure-marketplace.ts
```

### Modified files

```
apps/client/src/router.tsx                                       # Add /marketplace route
apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx  # Add Dork Hub tab
apps/server/src/index.ts                                          # Wire ensureMarketplaceExtension
apps/client/src/layers/shared/lib/transport/index.ts              # Export marketplace methods
CLAUDE.md                                                          # Document Dork Hub
CHANGELOG.md                                                       # Unreleased entry
```

### Unchanged

- Backend marketplace services (consumed via HTTP API)
- Foundation package
- Database schemas

---

## Acceptance Criteria

- [ ] Dork Hub appears in sidebar after install
- [ ] Browse view loads packages from spec 02 API
- [ ] Featured Agents rail displays correctly
- [ ] All filter types work (type, category, layers, search)
- [ ] Detail sheet shows package metadata + README + permission preview
- [ ] Install button triggers confirmation modal
- [ ] Install progress toast updates in real-time
- [ ] Uninstall works from "Manage Installed" view
- [ ] Update notifications appear when applicable
- [ ] Marketplace source management UI works
- [ ] TemplatePicker shows marketplace agents alongside built-ins
- [ ] All 12+ playground showcases render correctly
- [ ] Empty / loading / error / offline states all handled
- [ ] Vitest + RTL coverage > 80% for features/marketplace
- [ ] Accessibility checks pass
- [ ] Built-in extension installs on first server startup
- [ ] No FSD layer violations

---

## Risks & Mitigations

| Risk                                                            | Severity | Mitigation                                                                  |
| --------------------------------------------------------------- | :------: | --------------------------------------------------------------------------- |
| Permission preview UX is overwhelming for users                 |  Medium  | Group by category, collapse advanced sections, prioritize critical info     |
| Browse performance with many packages                           |  Medium  | Virtual scrolling, server-side pagination if > 200 packages                 |
| Marketplace API not yet available during dev                    |   Low    | Mock data via TanStack Query mocks; spec 02 ships first                     |
| Built-in extension update conflicts with user customizations    |   Low    | Built-in extension is system-level, can't be uninstalled, like DorkBot      |
| Confusing two "extensions" concepts (Dork Hub vs user installs) |  Medium  | Clear language: "Dork Hub" for the marketplace, "Plugins" for user installs |
| TemplatePicker regressions break onboarding                     |   High   | Comprehensive snapshot tests, opt-in feature flag during development        |

---

## Out of Scope (Deferred)

| Item                                 | Spec |
| ------------------------------------ | ---- |
| Web marketplace page                 | 04   |
| Public registry repo + seed packages | 04   |
| Telemetry display (install counts)   | 04   |
| MCP server                           | 05   |
| Personal marketplace publishing UI   | 05   |
| Reviews / ratings UI                 | v2   |
| Live preview / sandboxed try         | v2   |

---

## Changelog

### 2026-04-06 — Initial specification

Created from `/ideate-to-spec specs/dorkos-marketplace/01-ideation.md` (batched generation).

This is spec 3 of 5 for the DorkOS Marketplace project.
