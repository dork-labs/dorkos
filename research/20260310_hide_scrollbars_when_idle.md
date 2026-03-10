---
title: "Hide Scrollbars When Idle — CSS, shadcn ScrollArea, and TanStack Virtual Compatibility"
date: 2026-03-10
type: external-best-practices
status: active
tags: [scrollbars, tanstack-virtual, shadcn, radix, css, tailwind, overlayscrollbars, ux]
feature_slug: hide-scrollbars-when-idle
searches_performed: 14
sources_count: 28
---

## Research Summary

macOS scrollbars become permanently visible on the web primarily because of `overflow: scroll` (vs `overflow: auto`) or because CSS styling with `::-webkit-scrollbar` pseudo-elements forces them into always-on mode. The cleanest cross-browser solution for a React/Tailwind app with both simple lists and TanStack Virtual is a **pure CSS `@utility scrollbar-hide` approach** for the simple sidebar, combined with **OverlayScrollbars** for the TanStack Virtual message list — because Radix ScrollArea has a documented, unresolved composability issue with virtualized list libraries.

---

## Key Findings

1. **Root cause of always-visible scrollbars**: `overflow: scroll` is the most likely culprit. On macOS, `overflow: scroll` forces scrollbar space to be reserved and the handle to be rendered even when the system is set to "Automatic." Using `overflow: auto` respects the OS preference and only shows a scrollbar when content overflows.

2. **CSS scrollbar hiding is straightforward and zero-dependency**: Modern CSS supports `scrollbar-width: none` (Firefox, Chrome 121+) and `::-webkit-scrollbar { display: none }` (all WebKit/Blink). Combined in a Tailwind v4 `@utility`, this is production-ready with no extra packages.

3. **shadcn ScrollArea has a documented hard compatibility problem with TanStack Virtual**: The Radix team labeled the issue "Difficulty: Hard" and it remains open. Community workarounds exist (forwarding the viewport ref) but require modifying the shadcn component and introduce fragility.

4. **OverlayScrollbars has first-class TanStack Virtual integration**: Multiple working StackBlitz examples exist, the `getScrollElement` pattern is documented in TanStack discussions, and OverlayScrollbars provides `autoHide: 'scroll'` out of the box with a configurable delay.

5. **Tailwind v4 does not have built-in scrollbar utilities**: The `tailwind-scrollbar-hide` plugin has Tailwind v4 compatibility issues. The recommended approach is a native `@utility` directive in your CSS file — no plugin needed.

---

## Detailed Analysis

### Why macOS Scrollbars Show Even With "Automatic" System Setting

macOS System Preferences → General → "Show scroll bars" set to "Automatic" means the OS shows scrollbars only when a mouse with a scroll wheel is connected, or only during active scrolling on a trackpad. This behavior should auto-hide scrollbars in browsers by default.

**However, two CSS patterns override this:**

**Pattern 1 — `overflow: scroll`:**
`overflow: scroll` is an unconditional declaration that always shows scrollbars, regardless of the OS preference. On macOS, this results in a visible scrollbar track (the gutter) with the thumb appearing during scroll. On Windows/Linux, both track and thumb are always visible. Kilian Valkhof documents this clearly: "overflow: scroll says 'always show a scroll bar' while overflow: auto says 'show a scroll bar when needed.'"

**Pattern 2 — `::-webkit-scrollbar` pseudo-element styling:**
Any CSS that sets `::-webkit-scrollbar { width: Xpx }` with a non-zero width forces the scrollbar track to be rendered and visible. This is a common side-effect of Tailwind plugins or CSS resets that include scrollbar styling rules. If a global stylesheet defines `::-webkit-scrollbar { width: 6px; background: transparent; }`, Chrome on macOS will show the track permanently.

**What to check in the DorkOS codebase:**
- Search for `overflow-y: scroll` or `overflow: scroll` in component styles
- Search for `::-webkit-scrollbar` in global CSS files
- Check if shadcn/ui's CSS includes any scrollbar pseudo-element rules
- Check if any Tailwind plugin (e.g., `tailwind-scrollbar`) adds global scrollbar styles

### CSS Scrollbar Hiding Approaches

#### Option A: Complete Hide (No Scrollbar Handle, Scrolling Still Works)

```css
/* Modern standard — Chrome 121+, Firefox */
scrollbar-width: none;

/* Legacy WebKit fallback — Safari, older Chrome */
&::-webkit-scrollbar {
  display: none;
}
```

**Tailwind v4 implementation (no plugin needed):**
```css
/* In your global CSS file (e.g., index.css) */
@utility scrollbar-hide {
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

Then apply: `<div className="overflow-y-auto scrollbar-hide">`. This creates a utility class that works with all of Tailwind's variants. The `tailwind-scrollbar-hide` npm plugin also works but requires a special v4 import (`@import 'tailwind-scrollbar-hide/v4'`) and is unnecessary overhead when the `@utility` directive exists natively.

#### Option B: `scrollbar-width: thin` (Show Thin Bar, Respect OS Behavior)

```css
scrollbar-width: thin;
scrollbar-color: transparent transparent; /* hides thumb + track when not scrolling */
```

This is Firefox-only in terms of the `scrollbar-color` auto-hide behavior. Chrome does not auto-fade scrollbar thumbs to transparent via CSS alone.

#### Option C: Hover-Only Reveal (CSS + Transitions)

```css
.container::-webkit-scrollbar-thumb {
  background-color: transparent;
  transition: background-color 0.3s;
}
.container:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0,0,0,0.3);
}
```

This makes the scrollbar thumb invisible until the user hovers the container. Note: CSS transitions on `::-webkit-scrollbar-thumb` have limited browser support and the behavior is not smooth in all cases. The W3C has an open issue about this limitation.

#### Option D: `overflow: overlay` (Deprecated)

`overflow: overlay` used to overlay the scrollbar on top of content (so it took no layout space). It was removed from Chrome 108+ and is no longer a viable approach.

#### Option E: `scrollbar-gutter: stable` (Layout Reservation)

`scrollbar-gutter: stable` reserves space for the scrollbar gutter even when content doesn't overflow, preventing layout shift. It does not hide the scrollbar — it's for preventing layout jank, not for visual hiding.

### shadcn ScrollArea Component Analysis

shadcn ScrollArea wraps Radix UI ScrollArea primitive. Technically it:
- Renders a `Root` container with `overflow: hidden`
- Renders a `Viewport` div that has the actual native scroll behavior
- Renders custom scrollbar elements positioned as overlays on top of content (they sit above content, take no layout space)
- Has a `scrollHideDelay` prop (default 600ms) that controls auto-hide after scroll stops
- Has a `type` prop: `"hover"` | `"scroll"` | `"auto"` | `"always"` controlling when the custom scrollbar is visible

**The auto-hide behavior works well for simple lists.** Setting `type="scroll"` with the default `scrollHideDelay={600}` gives a nice fade-out after scrolling stops.

**However, TanStack Virtual compatibility is broken by design:**

The virtualized list needs to attach its own scroll listener and measure the scroll container. The standard pattern is:
```tsx
const parentRef = useRef<HTMLDivElement>(null);
const virtualizer = useVirtualizer({
  getScrollElement: () => parentRef.current,
  // ...
});
return <div ref={parentRef} style={{ overflow: 'auto', height: '600px' }}>
```

With Radix ScrollArea, `parentRef` must point to the `Viewport` element, not the `Root`. The shadcn `ScrollArea` component as shipped does not forward a ref to the viewport — it forwards to the root. This means `getScrollElement` returns the wrong element, and the virtualizer cannot correctly measure scroll position.

**The workaround** is to create a custom `ScrollArea` variant that accepts a `viewPortRef` prop:
```tsx
const ScrollArea = React.forwardRef<...>(({ viewPortRef, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} {...props}>
    <ScrollAreaPrimitive.Viewport ref={viewPortRef}>
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
```

This works but creates a diverged component that needs to be maintained separately from shadcn updates. It is also listed as "Difficulty: Hard" by the Radix team and the underlying issue remains open.

**Additional risk**: Radix ScrollArea injects its own scroll event listeners and may conflict with TanStack Virtual's own scroll observation. The community has reported cases where scroll calculations desync between the two systems.

### OverlayScrollbars + TanStack Virtual

OverlayScrollbars is a dependency-free library (~15.2 kB minified+gzipped for the core, with the React wrapper adding a few KB) that replaces native scrollbars with custom overlay scrollbars while preserving all native scroll behavior. Key properties:

- Overlay scrollbars float on top of content — no layout shift
- `scrollbars.autoHide: 'scroll'` hides the handle after scrolling stops (configurable delay, default 1300ms)
- `scrollbars.autoHide: 'leave'` hides when the pointer leaves the container
- High browser compatibility: Firefox 59+, Chrome 55+, Safari 10+
- SSR-compatible
- TypeScript-first

**TanStack Virtual integration:**

The `overlayscrollbars-react` package provides a `useOverlayScrollbars` hook. The key is that OverlayScrollbars keeps the native scroll element as the actual scroll container — it doesn't replace it, it wraps it. So `getScrollElement` can reference the underlying viewport:

```tsx
import { useOverlayScrollbars } from 'overlayscrollbars-react';
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualMessageList({ messages }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const [initialize] = useOverlayScrollbars({
    options: {
      scrollbars: {
        autoHide: 'scroll',
        autoHideDelay: 800,
      },
    },
    defer: true,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (el) initialize(el);
  }, [initialize]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  return (
    <div ref={parentRef} style={{ overflow: 'auto', height: '100%' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => (
          <div key={item.key} style={{
            position: 'absolute',
            top: item.start,
            height: item.size,
            width: '100%',
          }}>
            {messages[item.index]}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Multiple working examples exist on StackBlitz demonstrating this exact pattern. OverlayScrollbars works because it does not replace the DOM scroll element — it only overlays the visual scrollbar. TanStack Virtual's `getScrollElement` still points to the real scrollable div.

**Alternative: `OverlayScrollbarsComponent` wrapper approach:**

```tsx
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';

const osRef = useRef<OverlayScrollbarsComponentRef>(null);

const virtualizer = useVirtualizer({
  getScrollElement: () => {
    return osRef.current?.osInstance()?.elements().viewport ?? null;
  },
  // ...
});

return (
  <OverlayScrollbarsComponent
    ref={osRef}
    options={{ scrollbars: { autoHide: 'scroll' } }}
    style={{ height: '100%' }}
  >
    {/* virtual content */}
  </OverlayScrollbarsComponent>
);
```

This pattern uses the `.elements().viewport` accessor to get the underlying scroll element for TanStack Virtual.

### Tailwind v4 Scrollbar Utility Status

Tailwind CSS v4 does not ship native `scrollbar-hide`, `scrollbar-thin`, or any `scrollbar-*` utility classes. The `tailwind-scrollbar-hide` npm plugin has compatibility issues with v4 (the `@config` directive pattern no longer works).

**The correct Tailwind v4 approach** uses the native `@utility` directive, which is built into the v4 engine:

```css
/* apps/client/src/index.css or global stylesheet */
@utility scrollbar-hide {
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

This creates a `scrollbar-hide` class that:
- Works with all Tailwind variants (responsive, dark mode, hover, etc.)
- Is tree-shaken — only included if used
- Requires no additional npm dependencies
- Is the official pattern recommended by Tailwind v4 docs

---

## Approach Comparison

| Approach | TanStack Virtual | Cross-Browser | Auto-Hide | Performance | Complexity | Dep Size |
|---|---|---|---|---|---|---|
| **Pure CSS `scrollbar-hide`** | Works | Excellent | No (always hidden) | Zero overhead | Trivial | None |
| **CSS hover-reveal** | Works | Good (Chrome/Firefox) | Hover-based | Minimal JS | Low | None |
| **shadcn ScrollArea (simple lists)** | Not needed | Excellent | Yes (built-in) | Minimal | None (already used) | Already present |
| **shadcn ScrollArea + viewPortRef (virtualized)** | Fragile workaround | Excellent | Yes | Moderate risk | Medium + maintenance | Already present |
| **OverlayScrollbars** | First-class | Excellent | Yes (multiple modes) | Low (~15KB) | Low-Medium | ~15KB gzip |
| **JS scroll event + timeout + CSS class** | Works | Excellent | Yes | Low, but DIY | Medium | None |

---

## Recommendation

### For the sidebar session list (simple, non-virtualized)

**Use pure CSS with a Tailwind v4 `@utility scrollbar-hide`.** This is zero-dependency, zero-overhead, and fully handles the problem. The sidebar doesn't need a visible scrollbar handle — the list is short enough that users can see content overflowing, and macOS/mobile users expect scrollbars to be hidden.

```css
/* In index.css */
@utility scrollbar-hide {
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

```tsx
<div className="overflow-y-auto scrollbar-hide h-full">
  {sessions.map(/* ... */)}
</div>
```

First, audit whether `overflow: scroll` or a `::-webkit-scrollbar` global style is the root cause and fix that at the source. This may make the scrollbar auto-hide on macOS without any additional work.

### For the TanStack Virtual message list

**Use OverlayScrollbars.** It is the only approach with documented, working, first-class compatibility with TanStack Virtual. The `autoHide: 'scroll'` option gives exactly the behavior requested — the scrollbar handle fades out after the user stops scrolling. It overlays the content (no layout shift), is accessibility-safe (native scroll behavior is preserved), and the ~15KB bundle cost is justified by the quality of the experience.

Install:
```bash
pnpm add overlayscrollbars overlayscrollbars-react
```

Use `useOverlayScrollbars` (not `OverlayScrollbarsComponent`) when you need to pass the raw DOM element ref to `getScrollElement` in TanStack Virtual, as it gives you direct access to the scroll element without needing to call `.elements().viewport`.

**Do not use shadcn ScrollArea for the virtualized list.** The Radix team's own issue tracker labels this as "Difficulty: Hard" and the issue is unresolved. Community workarounds work today but are fragile and require maintaining a diverged shadcn component.

### Root-cause first approach (audit before adding dependencies)

Before adding OverlayScrollbars, do this audit:
1. Search for `overflow.*scroll` in component TSX/CSS files — change any `overflow-y: scroll` to `overflow-y: auto`
2. Search for `::-webkit-scrollbar` in global styles — remove any non-zero `width` or `height` declarations
3. If the macOS scrollbars auto-hide after this fix, the sidebar may need nothing more than `overflow-y: auto`
4. The virtualized list will still benefit from OverlayScrollbars for the auto-hide-on-scroll UX, but the root cause fix eliminates the "always visible" regression

---

## Research Gaps and Limitations

- Did not test OverlayScrollbars v2 + TanStack Virtual v3 in an actual DorkOS environment — bundle compatibility with React 19 should be verified
- Could not access the full StackBlitz source code for the OverlayScrollbars + TanStack Virtual example (403 on one fetch)
- The exact OverlayScrollbars gzip size for the React wrapper (`overlayscrollbars-react`) was not confirmed — estimate is ~3-5KB on top of the core ~15KB

---

## Contradictions and Disputes

- Some community sources suggest shadcn ScrollArea + TanStack Virtual works fine with the viewPortRef workaround. While technically true, the Radix team classifies this as an unsupported composability scenario. The workaround is brittle against shadcn upstream updates.
- `overflow: overlay` is mentioned in some blog posts as a valid technique — it is deprecated and removed in Chrome 108+. Do not use it.

---

## Sources and Evidence

- "overflow: scroll says 'always show a scroll bar' while overflow: auto says 'show a scroll bar when needed'" — [You want overflow: auto, not overflow: scroll](https://kilianvalkhof.com/2021/css-html/you-want-overflow-auto-not-overflow-scroll/)
- Radix ScrollArea + virtualized lists: "Difficulty: Hard" — [Radix UI Issue #1134](https://github.com/radix-ui/primitives/issues/1134)
- Community workaround for Radix ScrollArea + TanStack Virtual (viewPortRef pattern) — [Radix UI Discussion #1078](https://github.com/radix-ui/primitives/discussions/1078)
- TanStack Virtual custom scrollbar library integration — [TanStack Virtual Discussion #504](https://github.com/TanStack/virtual/discussions/504)
- OverlayScrollbars + TanStack Virtual StackBlitz demo — [StackBlitz Example](https://stackblitz.com/edit/vitejs-vite-2v2x4a?file=src/Virtualized.jsx)
- OverlayScrollbars autoHide options (`'never'`, `'scroll'`, `'move'`, `'leave'`) — [OverlayScrollbars Docs](https://kingsora.github.io/OverlayScrollbars/)
- Radix ScrollArea `scrollHideDelay` and `type` prop — [Radix Primitives Docs](https://www.radix-ui.com/primitives/docs/components/scroll-area)
- Tailwind v4 `@utility` directive for scrollbar-hide — [GitHub Discussion #16744](https://github.com/tailwindlabs/tailwindcss/discussions/16744)
- tailwind-scrollbar-hide v4 compatibility fix — [GitHub Issue #31](https://github.com/reslear/tailwind-scrollbar-hide/issues/31)
- tailwind-scrollbar-utilities plugin for v4 — [GitHub: lukewarlow/tailwind-scrollbar-utilities](https://github.com/lukewarlow/tailwind-scrollbar-utilities)
- OverlayScrollbars bundle size ~15.2KB gzip — [Best of JS](https://bestofjs.org/projects/overlayscrollbars)
- OverlayScrollbars React package — [npm: overlayscrollbars-react](https://www.npmjs.com/package/overlayscrollbars-react)
- TanStack Virtual API: `getScrollElement` — [TanStack Virtual Docs](https://tanstack.com/virtual/latest/docs/api/virtualizer)

## Search Methodology

- Searches performed: 14
- Most productive search terms: "overflow scroll vs auto macOS", "shadcn ScrollArea TanStack Virtual compatibility", "OverlayScrollbars TanStack Virtual getScrollElement", "Tailwind v4 scrollbar utility"
- Primary information sources: GitHub (Radix, TanStack, KingSora repos), Radix/TanStack official docs, kilianvalkhof.com, StackBlitz examples
