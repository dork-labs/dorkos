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
- **A composed widget or panel** — RelayPanel, MeshPanel, TunnelDialog, etc.
- **Complex enough to regress** — more than trivial markup; has conditional rendering, animations, or data-dependent layout

A component does NOT belong if it's:

- Pure logic (hooks, utilities, stores) with no visual output
- A one-line wrapper that adds a className
- A layout container with no meaningful visual states
- A page-level route component (the playground itself IS the page-level view)

## Placement Decision

### Which page?

Match to the existing page structure. The playground has 4 sidebar groups:

| Group             | Pages                                                                 | Use for                                         |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| **Design System** | Tokens, Forms, Components, Tables                                     | Shared primitives, design tokens, form elements |
| **Session**       | Chat Components, Simulator                                            | Chat UI, message rendering, streaming           |
| **Agents**        | Subsystems, Topology                                                  | Relay, Mesh, Tasks, agent identity, graph nodes |
| **App Shell**     | Command Palette, Filter Bar, Onboarding, Error States, Feature Promos | App-wide chrome, navigation, onboarding flows   |

### When to create a new page

Create a new page when a feature has **5+ sections** that don't fit naturally into an existing page, OR when the feature is a complex multi-component system that benefits from dedicated space (e.g., a full dialog with multiple sub-views like TunnelDialog).

A component can appear on **multiple pages** if it genuinely belongs in both contexts — for example, a shared primitive on the Components page AND as part of a composed widget showcase on its feature page.

### Grouping within a page

Group components that work together. The `category` field in section registries controls search grouping — components in the same category appear together in Cmd+K results. Use the feature/subsystem name as the category (e.g., "Relay", "Mesh", "Tasks", "Tunnel").

## The Parity Problem

**The goal: render the SAME component in both the playground and the application.** Never rebuild a layout or composition in the playground — if the widget changes in the app, it should change in the playground automatically.

### Current state

Today, showcases render only leaf components (individual cards, empty states, buttons). Full widget panels like `RelayPanel`, `MeshPanel`, and `TasksPanel` are NOT showcased — only their children are. This means the composed experience (how the parts work together) is invisible in the playground.

### The pattern to follow

When showcasing a composed widget (a dialog, panel, or multi-component feature):

**1. Separate content from chrome.** The dialog wrapper (e.g., `RelayDialogWrapper`) handles `ResponsiveDialog` chrome and open/close state. The content component (e.g., `RelayPanel`) handles the actual UI. The playground should render the _content component_, not the dialog wrapper.

```
App renders:                     Playground renders:
DialogWrapper                    PlaygroundSection
└─ ResponsiveDialog                └─ ShowcaseDemo
   └─ ContentPanel  ←──────────────── └─ ContentPanel (same component!)
```

**2. Support data injection via props.** Components that only get data from hooks (TanStack Query, Zustand) can't render with mock data in the playground. Refactor to accept data via props, with the hook as the default:

```tsx
// BEFORE: tightly coupled to hooks — can't showcase with mock data
function RelayPanel() {
  const { data } = useAdapters();
  return <AdapterList adapters={data} />;
}

// AFTER: accepts props OR falls back to hook
interface RelayPanelProps {
  adapters?: Adapter[];
}

function RelayPanel({ adapters: adaptersProp }: RelayPanelProps) {
  const query = useAdapters();
  const adapters = adaptersProp ?? query.data;
  return <AdapterList adapters={adapters} />;
}
```

This lets the playground pass mock data while the app continues using the hook. No duplication.

**3. Support controlled state for state machines.** Components with internal state machines (like TunnelDialog's landing/setup/connecting/connected/error views) should accept an optional `initialState` or `state` prop so the playground can showcase each state independently:

```tsx
// Playground can now render each state:
<TunnelContent initialView="connecting" />
<TunnelContent initialView="connected" mockData={connectedData} />
<TunnelContent initialView="error" mockData={errorData} />
```

**4. Keep mock data alongside showcases.** Mock data factories live in `dev/mock-factories.ts` and `dev/mock-samples.ts`. When adding a new showcase that needs mock data, add the factories there rather than inline in the showcase file. This keeps mock data reusable and the showcases focused on layout.

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
  category: 'Tunnel',           // search grouping
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

If creating a new page:

1. Create `dev/pages/NewPage.tsx` using `PlaygroundPageLayout`
2. Create `dev/sections/new-page-sections.ts` with section entries
3. Export from `dev/playground-registry.ts` (both named export and add to `PLAYGROUND_REGISTRY`)
4. Add the `Page` type union member in `playground-registry.ts`
5. Add a `PageConfig` entry in `dev/playground-config.ts` (pick appropriate group, icon, and description)
6. Add the page component to the route switch in `dev/DevPlayground.tsx`

## Quality Checks

When reviewing an existing playground showcase, verify:

- **Accuracy** — Does the showcase still match the component's current props interface? Are there new props or states not represented?
- **Completeness** — Are all meaningful states shown? (default, loading, empty, error, disabled, active)
- **Parity** — Is the showcase rendering the actual component, or a recreation? If it's a recreation, flag it for refactoring.
- **Mock data** — Is mock data realistic? Would a reviewer understand what this component looks like with real data?
- **Grouping** — Is this showcase on the right page and in the right category? Has the component's role changed since it was added?

## Files to Know

| File                         | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `dev/playground-config.ts`   | Page metadata — add new pages here             |
| `dev/playground-registry.ts` | Section type, Page type, full registry         |
| `dev/sections/*.ts`          | Section entries per page (drives TOC + search) |
| `dev/showcases/*.tsx`        | Showcase components (the actual demos)         |
| `dev/pages/*.tsx`            | Page components that compose showcases         |
| `dev/PlaygroundSection.tsx`  | Section card wrapper                           |
| `dev/ShowcaseDemo.tsx`       | Demo container with responsive viewport toggle |
| `dev/ShowcaseLabel.tsx`      | Label for distinguishing variants              |
| `dev/mock-factories.ts`      | Mock data factory functions                    |
| `dev/mock-samples.ts`        | Sample data constants                          |
| `dev/DevPlayground.tsx`      | Root component with page routing               |
