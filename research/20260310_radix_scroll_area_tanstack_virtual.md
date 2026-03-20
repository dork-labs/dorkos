---
title: 'Radix ScrollArea + TanStack Virtual Integration Patterns'
date: 2026-03-10
type: external-best-practices
status: active
tags: [radix-ui, scroll-area, tanstack-virtual, virtualization, react, shadcn]
searches_performed: 10
sources_count: 12
---

# Radix ScrollArea + TanStack Virtual Integration Patterns

## Research Summary

Radix ScrollArea's `Viewport` is the true scroll container, not the `Root`. The standard shadcn `ScrollArea` component only forward-refs to `Root`, so TanStack Virtual's `getScrollElement` cannot reach the Viewport by default. The fix is a one-line modification to the shadcn component: add a `viewportRef` prop and pass it to `ScrollAreaPrimitive.Viewport`. The Viewport is a standard `overflow: scroll` div that plays perfectly with TanStack Virtual's scroll observation — there are no compatibility conflicts.

---

## Key Findings

1. **The Viewport is the scroll container**: Radix ScrollArea hides native scrollbars by wrapping a Viewport (`overflow: scroll`) inside a Root (`overflow: hidden`). The Root clips the native scrollbar chrome; the Viewport is where actual scrolling happens. TanStack Virtual must measure and observe the Viewport, not the Root.

2. **The fix is a single prop addition**: The community-established pattern is to add a `viewportRef` prop to the shadcn `ScrollArea` component and forward it to `ScrollAreaPrimitive.Viewport`. The existing `ref` on `Root` can stay untouched.

3. **`ScrollAreaPrimitive.Viewport` accepts a `ref`**: Radix components are all built with `React.forwardRef`. The Viewport is a `div` under the hood and accepts a standard `React.RefObject<HTMLDivElement>`.

4. **No scroll behavior conflicts**: Radix ScrollArea uses native scroll mechanics — no CSS transforms or position manipulation. TanStack Virtual's `observeElementOffset` and `observeElementRect` work correctly on the Viewport element.

5. **React 19 + TanStack Virtual warning**: With React 19, you may see `flushSync was called from inside a lifecycle method` warnings. The fix is `useFlushSync: false` in the virtualizer config.

6. **`onScroll` must go on Viewport**: A related shadcn issue (#5623) confirms that `onScroll` props pass-through to Root is a bug — they should target `Viewport`. This is relevant if you ever use `onScroll` alongside virtualization.

---

## Detailed Analysis

### The DOM Structure of Radix ScrollArea

```
<Root>           ← overflow: hidden, position: relative — clips native scrollbar
  <Viewport>     ← overflow: scroll, width/height: 100% — actual scroll container
    {children}   ← your content
  </Viewport>
  <Scrollbar>    ← custom scrollbar overlay, positioned absolutely
    <Thumb />
  </Scrollbar>
  <Corner />
</Root>
```

The Root being `overflow: hidden` means attaching a virtualizer to it would produce zero scroll. The Viewport's native `overflow: scroll` is what TanStack Virtual needs to observe.

### The Modified shadcn ScrollArea Component

Modify `components/ui/scroll-area.tsx` to accept a `viewportRef` prop:

```typescript
import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '@/lib/utils'

interface ScrollAreaProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /** Ref forwarded to the inner Viewport element. Required for TanStack Virtual. */
  viewportRef?: React.RefObject<HTMLDivElement>
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, viewportRef, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      ref={viewportRef}
      className="h-full w-full rounded-[inherit]"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName
```

### Using with `useVirtualizer`

```typescript
import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ScrollArea } from '@/components/ui/scroll-area'

function VirtualList({ items }: { items: string[] }) {
  const viewportRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 48,       // estimated row height in px
    overscan: 5,
    // React 19: suppress flushSync lifecycle warning
    useFlushSync: false,
  })

  return (
    <ScrollArea
      style={{ height: '600px' }}
      viewportRef={viewportRef}
    >
      {/* The outer div must have the total virtual height */}
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}   // for dynamic heights
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {items[virtualRow.index]}
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
```

### Dynamic Heights (Variable Row Sizes)

When rows have variable heights, use `measureElement` ref on each item and remove `estimateSize` fixed value:

```typescript
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => viewportRef.current,
  estimateSize: () => 48,   // rough estimate only — actual measured after first render
  overscan: 5,
})

// On each virtual item, attach:
<div ref={virtualizer.measureElement} data-index={virtualRow.index}>
```

Radix ScrollArea's Viewport has no CSS that interferes with child measurement (`getBoundingClientRect` works normally on Viewport children).

### Alternative: Forward Ref Directly (Simpler Pattern)

If you only ever need the Viewport ref, the simplest approach replaces `viewportRef` with moving `ref` itself to Viewport. This breaks the `Root` ref but is fine when the consumer never needs the Root:

```typescript
const ScrollArea = React.forwardRef<
  HTMLDivElement,   // now typed as div (Viewport), not Root
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      ref={ref}
      className="h-full w-full rounded-[inherit]"
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
```

This is the pattern mentioned in radix-ui/primitives discussion #1078: "move `{ref}` from `<ScrollAreaPrimitive.Root>` to `ScrollAreaPrimitive.Viewport`."

**Trade-off**: The `viewportRef` prop approach is preferred because it doesn't change the semantics of `ref` on the component — callers expecting a Root ref won't get surprised.

### Scroll Behavior Notes

- Radix ScrollArea uses **native scroll** — no transforms, no artificial scroll positions. This is explicitly documented: "Scrolling is native with no underlying position movements via CSS transformations."
- `scrollTop` / `scrollLeft` on the Viewport element behave exactly as expected.
- TanStack Virtual's default `observeElementOffset` uses `element.scrollTop` / `element.scrollLeft` directly — no adaptation needed.
- The custom Radix scrollbar is positioned absolutely and does not affect layout or Viewport dimensions.

### React 19 Compatibility

TanStack Virtual uses `flushSync` internally to synchronize scroll updates. React 19 emits a warning when `flushSync` is called from lifecycle methods. Disable it:

```typescript
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => viewportRef.current,
  estimateSize: () => 48,
  useFlushSync: false, // suppress React 19 warning
});
```

This is a cosmetic change only — virtualization behavior is unaffected.

---

## Sources & Evidence

- Community-established viewport ref pattern: ["ScrollArea with Virtualized Lists" — radix-ui/primitives Discussion #1078](https://github.com/radix-ui/primitives/discussions/1078)
- Composability tracking issue: ["Improve composability with virtualized list libraries" — radix-ui/primitives Issue #1134](https://github.com/radix-ui/primitives/issues/1134)
- shadcn viewport access discussion: ["scroll-area viewport access" — shadcn-ui/ui Discussion #1734](https://github.com/shadcn-ui/ui/discussions/1734)
- `onScroll` should target Viewport: ["onScroll prop should be passed to ScrollAreaPrimitive.Viewport by default" — shadcn-ui/ui Issue #5623](https://github.com/shadcn-ui/ui/issues/5623)
- TanStack Virtual API docs: [Virtualizer — TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer)
- React Virtual adapter docs: [React Virtual — TanStack](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual)
- React 19 flushSync issue: ["flushSync was called from inside a lifecycle method" — TanStack/virtual Issue #1094](https://github.com/TanStack/virtual/issues/1094)
- Radix ScrollArea official docs: [Scroll Area — Radix Primitives](https://www.radix-ui.com/primitives/docs/components/scroll-area)
- Radix Themes ScrollArea source: [scroll-area.tsx — radix-ui/themes](https://github.com/radix-ui/themes/blob/main/packages/radix-ui-themes/src/components/scroll-area.tsx)

---

## Research Gaps & Limitations

- The Radix team has not published an official integration guide for virtualization libraries; all patterns are community-sourced from GitHub discussions.
- Issue #1134 ("Improve composability") is open as of this research — Radix has not made an architectural change to expose the Viewport more ergonomically.
- No official CodeSandbox/StackBlitz from TanStack or Radix teams specifically demonstrating this combo (only community examples exist).

---

## Contradictions & Disputes

- Some community members advocate moving `ref` to `Viewport` entirely (simpler), others advocate the dual `ref` + `viewportRef` prop approach (backward-compatible). Both work. The dual-prop approach is less surprising for consumers already using `ref` on the Root.
- There is no "official" recommendation from either Radix or TanStack; the community has converged on the `viewportRef` prop pattern.

---

## Search Methodology

- Searches performed: 10
- Most productive terms: `"ScrollAreaPrimitive.Viewport ref"`, `"viewportRef TanStack Virtual"`, `radix-ui/primitives discussion 1078`
- Primary sources: GitHub (radix-ui/primitives, shadcn-ui/ui, TanStack/virtual), TanStack official docs, Radix official docs
