# Shared UI Package

## Overview

`@dork-labs/ui` owns the portable controls and palette used across DorkOS surfaces. Applications keep their state, validation, requests and navigation; the package owns how its controls render and respond to ordinary DOM events.

## Key Files

| Concept                                       | Location                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Public exports and release metadata           | `packages/ui/package.json`, `packages/ui/src/index.ts`                                                  |
| Theme values and Tailwind source registration | `packages/ui/tokens.css`, `packages/ui/tailwind.css`                                                    |
| Behavior tests                                | `packages/ui/src/__tests__/`                                                                            |
| Client FSD facade                             | `apps/client/src/layers/shared/ui/index.ts`                                                             |
| Standalone examples                           | `apps/design-system/`                                                                                   |
| Client feature simulations                    | `apps/client/src/dev/`                                                                                  |
| Community adoption and browser proof          | `apps/community/src/browser/components/Admission.tsx`, `apps/community/browser-tests/shared-ui.spec.ts` |

## When to Use What

| Scenario                                                               | Approach                                     | Why                                                |
| ---------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Change a package-owned primitive (ownership table below)               | Edit `packages/ui`                           | All consumers receive the same implementation      |
| Use those controls inside the client                                   | Import from `@/layers/shared/ui`             | Preserves the FSD boundary                         |
| Use them in another application                                        | Import from `@dork-labs/ui`                  | No client application initialization               |
| Compose password visibility, validation or server errors               | Keep the composition in the application      | Application behavior has its own release and tests |
| Change a shared palette color                                          | Edit the namespaced package token            | Existing consumer color names remain compatible    |
| Change sidebar geometry, editor styles, font scaling or feature colors | Edit the owning application's stylesheet     | These are not portable foundations                 |
| Preview generic shared controls                                        | Run `@dorkos/design-system` on a chosen port | Examples import production package exports         |
| Preview rooms, settings or other feature behavior                      | Use the client playground                    | Those examples need application contexts           |

## Core Patterns

### Import styles once

The package targets React 19 and Tailwind 4. It distributes ESM JavaScript, declarations and CSS source; it does not bundle React, fonts or a second reset.

```css
@import 'tailwindcss';
@import '@dork-labs/ui/tailwind.css';
```

`tailwind.css` imports the tokens and registers the installed `dist/**/*.js` as a Tailwind source and imports `tw-animate-css`. Do not import that animation stylesheet a second time in a consumer. Do not point production configuration at a sibling repository or the package's TypeScript source. Build the workspace package before building a local consumer.

Use `.light` or `.dark` on the document root to choose a theme; without an explicit choice, the system preference applies. The package uses HSL-channel `--dui-*` values and `dui-*` utilities, keeping application tokens with other formats separate. A single opposing theme region is covered by browser proof in both directions. Arbitrarily alternating nested themes are outside the tested contract.

The client retains its existing semantic color names through a palette bridge. Its font-scale and editor/layer rules remain local. Embedded builds must explicitly bridge shared colors to host colors and preserve their stylesheet boundary; a successful CSS build is not a claim of runtime platform verification.

### Ownership and contribution

The package maintains the existing customized shadcn/Radix implementations. It does not regenerate components from upstream or switch primitive libraries.

| Owner                | Modules and responsibility                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui`        | Button, Input, Field, Label, Separator, Notice, touch-target constants                                                                                      |
| `packages/ui`        | Textarea, Checkbox, RadioGroup, Switch, Slider, Tabs, Collapsible, Progress, ScrollArea                                                                     |
| `packages/ui`        | Dialog, AlertDialog, Sheet, Popover, HoverCard, Tooltip, Select, DropdownMenu, ContextMenu, UiProvider                                                      |
| Client shared layer  | Card, Skeleton, Badge, Drawer, responsive app wrappers, routing controls, identity/domain components, notifications, Markdown, data tables and form engines |
| Applications         | State, auth, validation, requests, navigation, theme choice and portal-host lifetime                                                                        |
| `apps/design-system` | Generic examples of package exports, independent of application providers                                                                                   |
| Client playground    | Feature simulations and application-specific compositions                                                                                                   |

Client code keeps importing its FSD facade. The selected leaf files explicitly re-export the package implementations; they must not grow a second implementation. Package users can import the root or matching kebab-case subpaths, such as `@dork-labs/ui/dialog` and `@dork-labs/ui/ui-provider`. Existing source-only exports, including Switch track tables and ContextMenuPortal/ContextMenuShortcut, remain available from their leaves and the package.

For a component change, edit its package source and add a behavior regression test. Preserve public props, refs, events, data slots and accessible semantics. Show the change in the catalog and run consumer tests for the affected composition. Add a subpath when adding a module; keep React and ReactDOM as peers, never runtime bundles. Only public dependencies belong in the package.

Package semantic colors use `dui-*`; built-in icon sizes use `--dui-size-icon-xs/sm/md`. Animated primitives own their reduced-motion classes. Give borders an explicit semantic color rather than relying on an application reset. Client font-scale bridges and fixed embedded dimensions stay in the owning application stylesheet.

### Scope portal themes explicitly

A default overlay still portals to `document.body`. A theme on a nested trigger does not follow it there. Use a stable mounted host inside the intended theme region:

```tsx
import { useState } from 'react';
import { UiProvider, Button, Popover, PopoverTrigger, PopoverContent } from '@dork-labs/ui';

export function DarkPanel() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <section className="dark">
      <UiProvider portalContainer={host}>
        <Popover>
          <PopoverTrigger asChild>
            <Button>Show details</Button>
          </PopoverTrigger>
          <PopoverContent>Details inherit this dark region.</PopoverContent>
        </Popover>
        <div ref={setHost} />
      </UiProvider>
    </section>
  );
}
```

`UiProvider` renders no DOM and never changes document classes. Nested providers override their parent; sibling providers are independent. Omitted/null provider containers keep Radix's body default. An explicit exported Portal `container` prop wins, including explicit `null` (body) and a `DocumentFragment`. Keep the host mounted for the entire open lifetime. Choose a host without clipping or unintended stacking contexts; the package does not silently move portals under their triggers.

Self-portalling content and nested dropdown portals use the nearest provider. Existing non-portalled subcomponents keep that behavior. The catalog's **Portal themes** section demonstrates opposing hosts, nested menus/dialogs and an explicit return to body behavior.

### Keep the form behavior local

```tsx
import type { FormEventHandler } from 'react';
import { Button, Field, FieldLabel, Input, Notice } from '@dork-labs/ui';

export function EmailForm({
  error,
  pending,
  onSubmit,
}: {
  error: string | null;
  pending: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <form onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
```

Native Buttons default to `type="button"`. A submit action must opt in. `asChild` preserves the child's element and composes its events/ref through Radix Slot. Pass icons as children; no application icon package is part of the shared dependency graph.

An error Notice defaults to `role="alert"`; info and success tones are silent unless the caller explicitly chooses a live role. Render empty errors as nothing. Keep field IDs and error associations in the application, and avoid announcing one failure from both a field alert and a summary alert.

Responsive controls retain their existing dimensions: default Button/Input are 44px below `md`, 36px above. `icon-sm` remains a deliberate 40px exception; `xs` and `icon-xs` remain compact. `responsive={false}` opts out. Reduced-motion preferences suppress the Button press scale.

### Run the catalog and feature playground

Build the package, then start the standalone catalog on a free port:

```sh
pnpm --filter @dork-labs/ui build
pnpm --filter @dorkos/design-system dev --port 6250 --strictPort
```

The root development command leaves the catalog stopped. Its link to the client playground defaults to `http://localhost:6241/dev`; set `VITE_DORKOS_PLAYGROUND_URL` when the client uses another address. The client playground links to `http://localhost:6250` by default; set `VITE_DORKOS_CATALOG_URL` when choosing another catalog port. Both settings belong to the application whose link they change.

## Anti-Patterns

- ❌ Copy a shared primitive back into an application to change a class. ✅ Change the package or pass an intentional variant/className.
- ❌ Import client stores, transport, private code or router state from the package. ✅ Pass ordinary React props and callbacks.
- ❌ Load package CSS before Tailwind or leave legacy unlayered element rules overriding it. ✅ Follow import order and exclude migrated controls from legacy selectors.
- ❌ Commit a local archive dependency or a registry version that does not exist. ✅ Keep local validation temporary, then pin a real authorized release.
- ❌ Treat a source import or DOM class assertion as distribution proof. ✅ Install the packed archive independently and inspect computed browser styles.

## Verification and Release

The first candidate was tested with React 19.3.0, Tailwind 4.3.3, Vite 6.4.3 and Node 24.14.1. Version ranges still need fresh verification when dependencies change.

1. Run package build, typecheck, lint and behavior tests:

   ```sh
   pnpm --filter @dork-labs/ui build
   pnpm --filter @dork-labs/ui typecheck
   pnpm --filter @dork-labs/ui lint
   pnpm vitest run packages/ui/src/__tests__
   ```

2. Pack into an ignored directory in the worktree. Inspect the file list: only selected built modules/declarations, CSS, README, license and metadata belong in it. Confirm React is a peer, CSS is retained as a side effect, and no runtime dependency uses `workspace:`.
3. Install that archive into an independent React 19/Tailwind 4 fixture without source aliases or workspace resolution. Typecheck every export, build, inspect the React dependency graph and record the archive hash. Browser proof must cover explicit/system themes, dark opacity, source detection, focus, reduced motion and narrow-screen sizes.
4. Run affected consumer suites, including parent compositions. A client facade change reaches the whole client suite. Run real built forms with mocked requests and inspect errors, pending state, Enter submission, labels, focus and overflow. Build and inspect embedded CSS separately.
5. Finish independent review. A package owner must authorize the concrete name, version and release; permission for another package does not apply. The `prepublishOnly` script builds the package before a directory publication.
6. Only after authorization, confirm organization authority and version availability, and create the final release archive. Repeat distribution checks on those exact bytes before publishing them. A metadata change produces a new archive and a new hash.
7. Consumers outside this workspace install the actual registry version and regenerate their lockfiles. Repeat their checks before landing adoption. Archive-only validation does not establish registry adoption.

No CI release pipeline, deployment or package publication is implied by the local verification commands.

## Upgrading an independent consumer from 0.1 to 0.2

1. Confirm `0.2.0` is actually published before changing the dependency. Install the exact registry version and regenerate the consumer lockfile. Never commit the candidate archive path.
2. Keep the existing CSS import order. Remove a separate `tw-animate-css` import when the package entry now provides it. Build with Tailwind 4 scanning the installed JavaScript.
3. Existing 0.1 imports remain compatible. Adopt new primitives only where they fit the consumer; an intentional native select need not change.
4. For nested themes or embedded hosts, configure `UiProvider` before opening an overlay. Default body portals are unchanged.
5. Verify the consumer's adopted forms, focus, disabled/pending states, light/dark/system themes and phone layout. Re-run normal build/typecheck/lint/tests and browser checks before its adoption PR lands.

The public package owner reviews compatibility and authorizes each concrete release. Consumers own their upgrade timing and release process. Additive primitives use a minor version; compatible fixes use a patch; a breaking public API or visual contract needs an explicit migration plan and version decision. Record the exact archive hash, verification evidence and registry version with the release. Keep private consumer implementation and business details out of public evidence.

## Troubleshooting

### Controls render but have no styles

Check the CSS import order and that the package was built. Inspect generated CSS for a `dui-*` class and verify the installed package's source registration resolves to its emitted JavaScript. Do not fix this with a workspace-only alias.

### Explicit light mode still uses dark controls

Apply `.light` for an explicit light choice. Removing `.dark` alone returns the package to system preference. Keep theme selection in the application; the package never writes document classes.

### A migrated control still looks like the old one

Unlayered application selectors outrank Tailwind's utility layer. Remove obsolete local classes from migrated controls and constrain legacy element selectors without changing unconverted screens.

See [visual design rules](design-system.md) and [application styling](styling-theming.md) for the broader design system.
