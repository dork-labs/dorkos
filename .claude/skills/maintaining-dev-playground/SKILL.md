---
name: maintaining-dev-playground
description: >-
  Keeps the Dev Playground current with the application. Use when editing UI
  components in apps/client/src/ — assesses playground candidacy, checks existing
  playground coverage, and guides adding or updating showcases. Also use when
  directly editing files in apps/client/src/dev/, building new widgets or features,
  or when the user mentions the dev playground, component showcase, or visual testing.
  Proactively evaluate whether edited components belong in the playground even if the
  user doesn't ask.
---

# Maintaining the Dev Playground

The Dev Playground (`apps/client/src/dev/`, accessible at `/dev` in development) is a living gallery of every visual component in DorkOS. It exists so that designers and developers can review components in isolation, catch regressions visually, and verify that the design system is coherent.

The playground is only useful if it stays in sync with the actual application. Stale or missing showcases erode trust and let regressions slip through. This skill exists to prevent that drift.

## When This Skill Applies

Assess playground impact whenever you edit files in:

- `apps/client/src/layers/widgets/**/ui/**` — widget UI components
- `apps/client/src/layers/features/**/ui/**` — feature UI components
- `apps/client/src/layers/entities/**/ui/**` — entity UI components
- `apps/client/src/layers/shared/ui/**` — shared UI primitives
- `apps/client/src/dev/**` — direct playground edits

After editing a UI component, ask yourself three questions:

1. **Is this component a good playground candidate?** (See candidacy criteria below)
2. **Is it already in the playground?** Check the section registries in `dev/sections/`.
3. **If it's already there, is the showcase still accurate?** Does it reflect the current props, states, and visual appearance?

## Candidacy Criteria

A component belongs in the playground if it meets **any** of these:

- **Visual and reusable** — renders UI that appears in more than one place, or could
- **Has multiple meaningful states** — loading, empty, error, active, disabled, etc.
- **Part of the design system** — buttons, inputs, cards, badges, overlays
- **A composed widget or panel** — TasksPanel, MessagingConnections, TunnelDialog, etc.
- **Complex enough to regress** — more than trivial markup; has conditional rendering, animations, or data-dependent layout

A component does NOT belong if it's:

- Pure logic (hooks, utilities, stores) with no visual output
- A one-line wrapper that adds a className
- A layout container with no meaningful visual states
- A page-level route component (the playground itself IS the page-level view)

## Placement Decision

### Which page?

Match to the existing page structure. The playground has **5** sidebar groups, each derived from `PageConfig.group` in `dev/playground-config.ts` — check there rather than trusting this table, which is a summary and can age:

| Group             | Pages                                                                                                                                                          | Use for                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Design System** | Design Tokens, Forms, Components, Tables                                                                                                                       | Shared primitives, design tokens, form elements               |
| **Generative UI** | Widgets                                                                                                                                                         | Agent-authored widgets rendered from UI fences                |
| **Session**       | Conversation, Entry Actions, Simulator                                                                                                                          | Chat UI, message rendering, streaming                          |
| **Agents**        | Identity, Agent & Relay, Home Inbox & Approvals, Topology, Rooms, Marketplace                                                                                    | Faces and handles, Relay, Mesh, Tasks, approvals & inbox, graph nodes |
| **App Shell**     | Tour Spotlight, Command Palette, Filter Bar, Onboarding, Error States, Feature Promos, Settings, Sidebar Model, Sidebar Boot & Motion, One Bar                 | App-wide chrome, navigation, onboarding flows                 |

### When to create a new page

Create a new page when a feature has **5+ sections** that don't fit naturally into an existing page, OR when the feature is a complex multi-component system that benefits from dedicated space (e.g., a full dialog with multiple sub-views like TunnelDialog).

**Soft cap: ~20 sections per page** (batch 20 audit finding 20.2, DOR-1766) — where the playground's own distribution already breaks: every page under that settles fine, and the pages that crossed 2.5-3× it (Conversation, the old combined "Subsystems", Components) are the ones a reader gets lost on. **When a page's section file needs the 500-line split, split the page along the same seam.** The Agent & Relay / Home, Inbox & Approvals split is the worked example: the section array had already been split into `features-agent-sections.ts` / `features-surface-sections.ts` for the file-size cap, and the page above it followed the same boundary rather than staying one list. `TocSidebar`'s category sub-headings (§ Grouping within a page) help every oversized page regardless, but they are a mitigation, not a substitute — a page that keeps growing past the cap still wants a split.

### Showing one component on two pages

A component can appear on **multiple pages** if it genuinely belongs in both contexts — a shared primitive on the Components page and again on the feature page that composes it.

**Do it by rendering, never by registering twice.** The registry forbids duplicate ids and pins `id === slugify(title)`, so one title holds exactly one entry, on one page, at one anchor. Add a second entry and the drift test goes red. Instead:

1. Export the showcase component for that one section (split it out of its file's `*Showcases` wrapper if it isn't already), and render it from both pages.
2. Leave the registry entry where it is, so the existing `/dev/<page>#<anchor>` keeps working.
3. Compose the borrowing page's TOC from both halves in its `PageConfig.sections` — `[...OWN_SECTIONS, ...borrowed]`. That is legal because `PLAYGROUND_REGISTRY` is the union of the per-page arrays, not of `PAGE_CONFIGS[].sections`.

The accepted cost: a borrowed section still groups under its owning page in Cmd+K. Say so on the borrowing page rather than letting the next person discover it. Worked example: `dev/pages/IdentityPage.tsx` and `IDENTITY_CROSS_LISTED` in `dev/playground-config.ts`.

### Grouping within a page

Group components that work together. The `category` field drives the TOC: `TocSidebar` renders a sub-heading over every run of CONSECUTIVE same-`category` sections (batch 20 audit finding 20.3, DOR-1766), so keep entries for one category adjacent in the section array — scattering the same category across non-consecutive positions draws it as two separate groups instead of one. Cmd+K still groups by `page` only (`PlaygroundSearch`); `category` has never been a search grouping. Use the feature/subsystem name — "Relay", "Mesh", "Tasks", "Identity" — the same words a reader would look for in the TOC.

## The Parity Problem

**The goal: render the SAME component in both the playground and the application.** Never rebuild a layout or composition in the playground — if the widget changes in the app, it should change in the playground automatically.

### Current state

Most showcases render only leaf components (individual cards, empty states, buttons). Full widget panels are usually NOT showcased — only their children are — which means the composed experience (how the parts work together) is invisible in the playground for most of them. `TasksPanel` and relay's `MessagingConnections` are the worked examples (DOR-1766): each is showcased with an isolated, pre-seeded `QueryClient` per the data-injection pattern below. Mesh's composed panels, `TopologyPanel` and `DiscoveryView`, are not showcased yet.

### The pattern to follow

When showcasing a composed widget (a dialog, panel, or multi-component feature):

**1. Separate content from chrome.** The dialog wrapper (e.g., `TasksDialogWrapper`) handles `ResponsiveDialog` chrome and open/close state. The content component (e.g., `TasksPanel`) handles the actual UI. The playground should render the _content component_, not the dialog wrapper.

```
App renders:                     Playground renders:
DialogWrapper                    PlaygroundSection
└─ ResponsiveDialog                └─ ShowcaseDemo
   └─ ContentPanel  ←──────────────── └─ ContentPanel (same component!)
```

**2. Support data injection via props.** Components that only get data from hooks (TanStack Query, Zustand) can't render with mock data in the playground. Refactor to accept data via props, with the hook as the default:

```tsx
// BEFORE: tightly coupled to hooks — can't showcase with mock data
function WidgetPanel() {
  const { data } = useWidgetData();
  return <ItemList items={data} />;
}

// AFTER: accepts props OR falls back to hook
interface WidgetPanelProps {
  items?: Item[];
}

function WidgetPanel({ items: itemsProp }: WidgetPanelProps) {
  const query = useWidgetData();
  const items = itemsProp ?? query.data;
  return <ItemList items={items} />;
}
```

This lets the playground pass mock data while the app continues using the hook. No duplication.

**2b. Or seed an isolated `QueryClient`, when the component is TanStack-Query-only and a props refactor isn't warranted.** A component whose only obstacle is `useQuery` — no Zustand, no other outside state — can be shown as-is: wrap it in its own `QueryClient` (`retry: false, staleTime: Infinity` so nothing refetches against a server that isn't running) and `setQueryData` the exact keys it reads, then render the REAL component inside a `<QueryClientProvider client={...}>`. `MarketplaceShowcases.tsx`, `SidebarShowcases.tsx` and (DOR-1766) `TasksShowcases.tsx`/`RelayShowcases.tsx`/`ConnectionsShowcases.tsx` all use this. Export the query key alongside its hook (`export const CATALOG_KEY = …`) so the showcase can import it rather than re-typing the array by hand. **Check every hook the component reaches for a `null`-vs-`undefined` landmine first**: the playground's ambient transport resolves every unseeded call to `null`, and a destructured default (`const { data = [] } = useX()`) only fires on `undefined` — so a hook whose consumer does `data.map(...)` with no optional chaining will crash on an unseeded query. Either seed that key too, or confirm the consumer already guards with `?.`/`??`/an explicit `if (!data)`.

**3. Support controlled state for state machines.** Components with internal state machines (like TunnelDialog's landing/setup/connecting/connected/error views) should accept an optional `initialState` or `state` prop so the playground can showcase each state independently:

```tsx
// Playground can now render each state:
<TunnelContent initialView="connecting" />
<TunnelContent initialView="connected" mockData={connectedData} />
<TunnelContent initialView="error" mockData={errorData} />
```

**4. Keep mock data alongside showcases.** Mock data factories live in `dev/mock-factories.ts` and `dev/mock-samples/` (split by domain — DOR-1766, finding 20.8 — and re-exported from its `index.ts`). When adding a new showcase that needs mock data, add the factories there rather than inline in the showcase file. This keeps mock data reusable and the showcases focused on layout.

### When to refactor

If a component can't be showcased without duplicating its layout, that's a signal to refactor. Common refactors:

- **Extract content from dialog/sheet wrapper** — make the content renderable standalone
- **Add optional prop overrides for hook data** — let props take precedence over hooks
- **Add initialState prop to state machines** — let the playground control which view renders
- **Extract sub-views into named components** — makes individual states showcaseable

These refactors improve the component's testability and composability beyond just playground support. They're worth doing.

## Implementation Checklist

When adding a component to the playground:

### 1. Add section metadata

Add entries to the appropriate section file in `dev/sections/`:

```ts
// dev/sections/features-sections.ts
{
  id: 'tunneldialog',           // anchor ID — lowercase, no spaces
  title: 'TunnelDialog',        // display name
  page: 'features',             // which page (must match Page type)
  category: 'Tunnel',           // groups the TOC — keep same-category entries adjacent
  keywords: ['tunnel', 'remote', 'ssh', 'connect', 'security'],
}
```

The `id` must be the slugified version of the title (the `PlaygroundSection` component auto-generates anchors from its `title` prop via `slugify()`).

### 2. Create the showcase file

Create `dev/showcases/TunnelShowcases.tsx`:

```tsx
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { TunnelContent } from '@/layers/features/settings';

export function TunnelShowcases() {
  return (
    <>
      <PlaygroundSection
        title="TunnelDialog"
        description="Tunnel connection manager with multi-step state machine."
      >
        <ShowcaseLabel>Landing</ShowcaseLabel>
        <ShowcaseDemo>
          <TunnelContent initialView="landing" />
        </ShowcaseDemo>

        <ShowcaseLabel>Connected</ShowcaseLabel>
        <ShowcaseDemo>
          <TunnelContent initialView="connected" mockData={connectedMock} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
```

Guidelines:

- One showcase file per feature/subsystem, not per component
- Use `ShowcaseLabel` to distinguish variants within a section
- Use `ShowcaseDemo` (with `responsive` prop when layout is width-sensitive) to wrap each demo
- Import the REAL component — never recreate its markup
- Pass mock data via props, using factories from `dev/mock-factories.ts`

### 3. Add to the page component

Import the showcase in the relevant page file (`dev/pages/FeaturesPage.tsx`):

```tsx
import { TunnelShowcases } from '../showcases/TunnelShowcases';

// Add inside the PlaygroundPageLayout:
<TunnelShowcases />;
```

### 4. Create a new page (if needed)

A new page is **seven** touch points, not six. The seventh is a test file, and missing it turns CI red rather than the browser:

1. Add the `Page` type union member in `dev/playground-registry.ts`
2. Create `dev/sections/new-page-sections.ts` exporting `NEW_PAGE_SECTIONS`
3. Export it from `dev/playground-registry.ts` — the named re-export **and** the aliased import spread into `PLAYGROUND_REGISTRY`
4. Add a `PageConfig` entry in `dev/playground-config.ts` (group, icon, description, path)
5. Create `dev/pages/NewPage.tsx` using `PlaygroundPageLayout`
6. Add the page component to `PAGE_COMPONENTS` in `dev/playground-pages.ts` (plus its import)
7. **Add the array to `dev/__tests__/playground-registry.test.ts`** — both its import and the hardcoded union in _"PLAYGROUND_REGISTRY equals the union of all page-level arrays"_. That assertion lists every section array by name, so a new one that is not there fails the test even though the page works.

Then run `pnpm vitest run apps/client/src/dev/__tests__/playground-registry.test.ts` — green there proves union membership, unique ids, `id === slugify(title)`, and that every rendered section is registered and every registered section is rendered.

## Quality Checks

When reviewing an existing playground showcase, verify:

- **Accuracy** — Does the showcase still match the component's current props interface? Are there new props or states not represented?
- **Completeness** — Are all meaningful states shown? (default, loading, empty, error, disabled, active)
- **Parity** — Is the showcase rendering the actual component, or a recreation? If it's a recreation, flag it for refactoring.
- **Mock data** — Is mock data realistic? Would a reviewer understand what this component looks like with real data?
- **Grouping** — Is this showcase on the right page and in the right category? Has the component's role changed since it was added?

## Files to Know

| File                                        | Purpose                                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `dev/playground-config.ts`                  | Page metadata — add new pages here                        |
| `dev/playground-registry.ts`                | Section type, Page type, full registry                    |
| `dev/sections/*.ts`                         | Section entries per page (drives TOC + search)            |
| `dev/showcases/*.tsx`                       | Showcase components (the actual demos)                    |
| `dev/pages/*.tsx`                           | Page components that compose showcases                    |
| `dev/PlaygroundSection.tsx`                 | Section card wrapper                                      |
| `dev/ShowcaseDemo.tsx`                      | Demo container with responsive viewport toggle            |
| `dev/ShowcaseLabel.tsx`                     | Label for distinguishing variants                         |
| `dev/mock-factories.ts`                     | Mock data factory functions                               |
| `dev/mock-samples/`                         | Sample data constants, split by domain, barrelled from `index.ts` |
| `dev/playground-pages.ts`                   | `PAGE_COMPONENTS` — maps page IDs to their page component |
| `dev/DevPlayground.tsx`                     | Root component with page routing                          |
| `dev/__tests__/playground-registry.test.ts` | The drift gate — lists every page-level array by name     |
