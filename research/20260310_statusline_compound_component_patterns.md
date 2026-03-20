---
title: 'StatusLine Compound Component Patterns'
date: 2026-03-10
type: implementation
status: active
tags:
  [
    react,
    compound-components,
    animation,
    framer-motion,
    motion,
    statusline,
    toolbar,
    separator,
    typescript,
  ]
feature_slug: statusline-compound-component
searches_performed: 10
sources_count: 18
---

# StatusLine Compound Component Patterns

## Research Summary

The React compound component pattern using Context API is the correct approach for refactoring StatusLine. The key challenges are: (1) how to handle animated separators between conditionally-visible items without the separator itself being an animated child, and (2) how to keep `AnimatePresence` working cleanly when children are defined declaratively. The solution is a thin context (animation config only), a `StatusLine.Item` that registers itself via `useLayoutEffect`, and separators rendered by the root based on the registry — not by inspecting opaque `children`.

---

## Key Findings

### 1. Context Is the Right Primitive (Not React.Children)

**React.Children APIs are in maintenance mode** and have two critical limitations for this use case:

- `React.Children.toArray` cannot detect components that _return_ null — it only filters JSX `null`/`undefined`/`Boolean` literals. A `<StatusLine.Item visible={false}>` that internally returns null is invisible to the array.
- `React.Children.map` does not traverse Fragments, so wrapping items in a Fragment for grouping breaks the pattern.
- Neither approach works with `AnimatePresence` because `AnimatePresence` needs items to actually _unmount_ from the tree to fire exit animations, but `React.Children` inspection happens at the JSX level before rendering.

**The Context API approach is universally recommended** by the React team and community for compound components. It avoids these limitations by letting each child register itself.

### 2. Two Valid Context Architectures

**Architecture A — Visibility via `visible` prop + imperative registration (recommended)**

Each `StatusLine.Item` calls `useLayoutEffect` to register/unregister itself with the root context. The root maintains an ordered registry `Map<key, boolean>` and uses it to render separators between _visible_ items. Items themselves render unconditionally (always mounted), and a `visible` prop controls whether the item fires an exit animation or renders nothing.

```tsx
// Root holds the registry
interface StatusLineContextValue {
  registerItem: (key: string, order: number) => void;
  unregisterItem: (key: string) => void;
  visibleKeys: string[]; // ordered list of currently-visible item keys
}

// Item self-registers and signals visibility to context
function Item({ itemKey, visible, children }: StatusLineItemProps) {
  const { registerItem, unregisterItem } = useStatusLineContext();
  useLayoutEffect(() => {
    registerItem(itemKey, order);
    return () => unregisterItem(itemKey);
  }, [itemKey]);
  // ... AnimatePresence wrapping visible ? children : null
}
```

**Architecture B — Imperative entries array, declarative wrapper (simplest)**

The root receives children as before but exposes a `<StatusLine.Item>` wrapper that is syntactic sugar — under the hood it's still building an entries array from `React.Children.toArray`. This is the weakest approach because of the `React.Children` limitations above.

**Verdict: Architecture A** is the correct choice. It avoids all `React.Children` pitfalls and works naturally with AnimatePresence.

### 3. AnimatePresence + Compound Components

**Critical requirement:** `AnimatePresence` only animates items that _unmount from the React tree_. If an item is always mounted (even when invisible), AnimatePresence cannot fire exit animations for it.

**Two placement strategies for `AnimatePresence`:**

**Strategy 1 — AnimatePresence in the root, items always mounted (registration pattern):**
Items are always rendered. The `visible` prop causes the item to render a `motion.div` that animates in/out. The root `AnimatePresence` wraps the container and each rendered item uses `AnimatePresence` locally to animate its content. This works but requires nested `AnimatePresence` boundaries.

**Strategy 2 — AnimatePresence in the root, items conditionally rendered (unmounting pattern):**
Items render `null` when `visible={false}`, so they actually unmount. The root's `AnimatePresence` detects these unmounts and fires exit animations. **This is the canonical pattern and what the current StatusLine already uses.** The compound component API should preserve this.

```tsx
// Root: single AnimatePresence boundary for all items
<AnimatePresence initial={false} mode="popLayout">
  {visibleEntries.map((entry, i) => (
    <motion.div key={entry.key} layout initial={...} animate={...} exit={...}>
      {i > 0 && <Separator />}
      {entry.node}
    </motion.div>
  ))}
</AnimatePresence>
```

**The winner is Strategy 2** — items unmount when invisible. The `Item` component simply renders `null` when `visible={false}`, and the root `AnimatePresence` handles the animation. This is exactly how the current code works; the refactor just moves the `if (show) entries.push(...)` logic into each `Item` component.

**`mode="popLayout"` requirements:**

- The exiting element is removed from document flow immediately while its exit animation plays
- Surrounding items animate smoothly to their new positions via `layout` prop
- **Requirement:** Custom components that are direct children of `AnimatePresence` with `mode="popLayout"` must forward refs to a DOM element. If `StatusLine.Item` renders a `motion.div` directly, this is handled automatically. If it renders a custom component, `forwardRef` is needed.
- **Requirement:** The animating parent must have `position` other than `static` (use `relative`).

### 4. The Separator Problem

This is the trickiest part of the refactor. The current code uses index position (`i > 0`) to insert separators. With a compound component pattern and animated items, there are three approaches:

**Approach A — CSS-only separator (simplest, recommended for most cases):**

```css
/* Between visible items using CSS */
.status-item + .status-item::before {
  content: '·';
  /* or use gap + border-left */
}
```

```tsx
<div className="flex items-center [&>*+*]:before:content-['·'] [&>*+*]:before:mx-2 [&>*+*]:before:text-muted-foreground/30">
```

This approach has a critical advantage: **separators are not animated items themselves**, so AnimatePresence doesn't need to manage them. When an item exits, the CSS `:before` pseudo-element disappears with the item. **No separator orphans during animation.**

The limitation: CSS pseudo-elements cannot be animated independently. If you want the separator itself to animate (fade in/out), you need a different approach.

**Approach B — Separator included inside the `motion.div` wrapper:**

The separator is a sibling inside the same animated wrapper as the item content:

```tsx
// Inside the motion.div that wraps each item
<motion.div key={itemKey} layout ...>
  {showSeparator && <Separator />}  {/* separator travels with its item */}
  {children}
</motion.div>
```

The separator attaches to the _left_ of each item (except the first). When an item exits, its separator exits with it. The root needs to know which items are visible to compute `showSeparator = index > 0`. This is the registration pattern's payoff — the root knows the ordered visible list.

**Approach C — Separator as a separate animated child (current pattern, problematic with compound components):**

The current code interleaves separator elements between `entries.map()` items. The separator is inside the same `motion.div` as the item, so it animates with it — this works fine. The issue with compound components is that the root no longer builds the `entries[]` array imperatively, so it doesn't know the index.

**Recommended separator strategy: Approach B** — separator lives inside the `motion.div` wrapper, and the root computes which items should show a separator based on their position in the visible items list. The registration context provides this ordered list.

### 5. Context Shape — Keep It Minimal

For a StatusLine, the context should contain **only what child items need to coordinate**. The current StatusLine has no inter-item communication — each item is independent. The refactored context should be minimal:

```typescript
interface StatusLineContextValue {
  /** Animation transition config shared across all items */
  itemTransition: Transition;
}
```

Each `StatusLine.Item` accepts its own `visible` prop. The root does not need to know about individual item states — items self-manage by unmounting when `visible={false}`.

The _separator computation_ happens at the root level via the registration pattern. A lightweight secondary mechanism:

```typescript
// Registration context (separate from animation context for performance)
interface StatusLineRegistryValue {
  notifyVisibility: (key: string, visible: boolean, order: number) => void;
}
```

**Context splitting:** Only split context if expensive re-renders are observed. For a status bar with ~9 items, a single context is fine. The items are small and re-renders are cheap.

### 6. Plugin Extensibility

The compound component API **naturally supports plugin items** because consumers control the children:

```tsx
// Core items built-in
<StatusLine sessionId={id}>
  <StatusLine.Item itemKey="cwd" visible={showCwd} order={0}>
    <CwdItem cwd={cwd} />
  </StatusLine.Item>
  {/* Plugin-injected item */}
  <StatusLine.Item itemKey="my-plugin" visible={true} order={99}>
    <MyPluginItem />
  </StatusLine.Item>
</StatusLine>
```

**Priority/ordering:** The `order` prop on each `Item` determines separator position. The root sorts the registered visible items by `order` before rendering. This gives plugins a stable insertion point without modifying core code.

**Registration vs composition:** Composition (just pass children) is simpler and more idiomatic React. Registration (items call an API to insert themselves) is necessary only when:

- Items need to be inserted from _outside_ the render tree (e.g., portals, separate React roots)
- Items need to appear in a different DOM position than they're declared

For DorkOS's StatusLine, **composition is correct**. Plugin items are simply declared as siblings in JSX. No registration API needed at the app level.

---

## Detailed Analysis

### Chosen Pattern: Declarative Composition with Unmount-Based AnimatePresence

The cleanest implementation for StatusLine's specific requirements:

```tsx
// StatusLine.tsx
const StatusLineContext = createContext<StatusLineContextValue | null>(null);

function StatusLineRoot({ sessionId, children }: StatusLineRootProps) {
  // Root computes visible children to derive separator positions
  // Children are rendered; invisible ones unmount (return null)
  // AnimatePresence detects unmounts and fires exit animations

  return (
    <StatusLineContext.Provider value={contextValue}>
      <AnimatePresence initial={false}>
        {hasVisibleChildren && (
          <motion.div
            role="toolbar"
            aria-label="Session status"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={containerTransition}
            className="overflow-hidden"
          >
            <div className="text-muted-foreground flex flex-wrap items-center ...">
              <AnimatePresence initial={false} mode="popLayout">
                {children}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </StatusLineContext.Provider>
  );
}
```

**Problem:** When using this fully declarative pattern, the root cannot know if any children are visible (to hide the outer container) without inspecting children — which requires `React.Children` or a registration context.

**Solution — Registration for `hasVisibleChildren` only:**

```tsx
function StatusLineRoot({ children }: StatusLineRootProps) {
  const [visibleCount, setVisibleCount] = useState(0);

  const contextValue = useMemo(() => ({
    notifyVisible: (key: string, isVisible: boolean) => {
      setVisibleCount(prev => isVisible ? prev + 1 : prev - 1);
    },
    itemTransition,
  }), []);

  return (
    <StatusLineContext.Provider value={contextValue}>
      <AnimatePresence initial={false}>
        {visibleCount > 0 && (
          <motion.div role="toolbar" ...>
            <AnimatePresence initial={false} mode="popLayout">
              {children}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </StatusLineContext.Provider>
  );
}
```

Each `StatusLine.Item` calls `notifyVisible(key, visible)` in a `useEffect` whenever its `visible` prop changes. This is the minimal registration needed.

**The separator solution** with this pattern: use CSS `gap` on the flex container plus a `·` separator rendered via a utility class or CSS `::before` on items after the first. This avoids needing index information entirely.

Alternatively, each `Item` renders its separator internally:

```tsx
function Item({ itemKey, visible, showSeparator, children }) {
  // showSeparator is passed by the parent caller (knows the order)
  return visible ? (
    <motion.div key={itemKey} layout ...>
      {showSeparator && <Separator />}
      {children}
    </motion.div>
  ) : null;
}
```

### The Honest Trade-Off

The current imperative `entries[]` approach has a genuine advantage: it knows the index of every visible item at render time, making separator injection trivial. The compound component pattern trades this simplicity for better declarative API ergonomics, but requires either:

1. A registration context that tracks visible items and their order (adds complexity)
2. A CSS-based separator (simpler, no animation on separator itself)
3. Requiring callers to pass `showSeparator` per item (defeats the purpose of compound components)

**The best trade-off:** CSS-based separator with `gap` + `::before` pseudo-element via Tailwind. This gives clean compound component API with zero overhead. The `·` separator already has no enter/exit animation in the current code, so losing per-separator animation is not a regression.

### TypeScript: Attaching Item to StatusLine

The canonical pattern for TypeScript compound components:

```typescript
// Method 1: Type assertion (most common)
const StatusLine = Object.assign(StatusLineRoot, {
  Item: StatusLineItem,
});

// Method 2: Explicit typing (cleaner)
interface StatusLineComponent {
  (props: StatusLineRootProps): React.ReactElement | null;
  Item: typeof StatusLineItem;
}

const StatusLine: StatusLineComponent = Object.assign(StatusLineRoot, {
  Item: StatusLineItem,
});
```

Method 1 is what Shadcn/ui uses internally and is the community standard.

### Keeping Items in the Same File or Splitting

Given the 184-line current `StatusLine.tsx`, a compound component refactor will add ~50-80 lines (context, Item component, registration logic). This pushes the file toward the 300-line caution threshold.

**Recommendation:** Split into:

- `StatusLine.tsx` — root component + compound API assembly + context
- `StatusLineItem.tsx` — `StatusLine.Item` implementation
- Keep all item components (`CwdItem`, `ModelItem`, etc.) in their own files as-is

---

## RESEARCH FINDINGS

### Potential Solutions

**1. Declarative Composition + CSS Separator (Recommended)**

- `StatusLine` provides `AnimatePresence` context and a lightweight registration for `hasVisibleChildren`
- `StatusLine.Item` accepts `visible` prop; when `false`, returns `null` (unmounts for AnimatePresence)
- Separator is a CSS `::before` pseudo-element on `[data-separator]` items after index 0
- Items are assigned their `order` implicitly by their JSX position (first-child, etc.)
- Pros: Minimal context, zero separator animation complexity, fully declarative, plugin-friendly
- Cons: Cannot animate separators independently; CSS `::before` doesn't work with `gap` in some Tailwind configurations without a wrapper
- Complexity: Low
- Maintenance: Very low

**2. Declarative Composition + Registration Context + Separator in Item**

- Full registration context: each Item registers key + order + visibility
- Root derives ordered visible list and passes `showSeparator` via context (keyed by item key)
- Item reads `showSeparator` from context and renders `<Separator />` if true
- Pros: Full control over separator appearance and animation; plugin ordering by `order` prop
- Cons: More complex context; registration effects can cause a render cycle; ordering by `order` number requires callers to declare explicit order values
- Complexity: Medium
- Maintenance: Medium

**3. Keep Entries Array, Wrap in StatusLine.Item (Facade Pattern)**

- `StatusLine.Item` is a pure marker component that renders its children
- `StatusLine` root walks `React.Children.toArray(children)`, finds all `StatusLine.Item` elements, checks their `visible` prop, and builds the entries array
- Preserves the current imperative logic behind a declarative API
- Pros: Minimal code change; separator logic unchanged; AnimatePresence unchanged
- Cons: `React.Children.toArray` cannot detect components returning null (workaround: use the explicit `visible` prop on the Item JSX element, not the child's render output); items cannot be nested inside wrappers (Fragment breaks it); brittle to composition changes
- Complexity: Low initially, high as complexity grows
- Maintenance: High (fights React's model)

### Separator Strategy

**Recommendation: Approach B (separator inside the `motion.div` wrapper)** combined with registration context visibility tracking.

Each `StatusLine.Item` renders:

```tsx
<motion.div key={itemKey} layout initial={...} animate={...} exit={...} transition={itemTransition}>
  {!isFirstVisible && <Separator />}
  {children}
</motion.div>
```

The root context exposes the ordered list of currently-visible item keys. Each `Item` can derive `isFirstVisible` by checking if its key is first in that list. This avoids CSS pseudo-elements and preserves the ability to animate separators in the future.

**Simpler alternative for immediate implementation:** Use CSS `gap-2` on the flex container and `·` separators via Tailwind's `[&>*:not(:first-child)]:before:content-['·']` utility, or just a static separator character inside each item's `motion.div` (visible only when the item is visible). Trade-off: separator does not animate independently.

### AnimatePresence Integration

**Recommendation:** Preserve the current two-boundary pattern exactly:

1. Outer `AnimatePresence` — animates the entire status bar container in/out when `hasVisibleChildren` changes
2. Inner `AnimatePresence mode="popLayout"` — animates individual items in/out

Each `StatusLine.Item` that is `visible` renders a `motion.div` with `layout` prop. When `visible` becomes `false`, the Item returns `null`, unmounting from the tree, and the inner `AnimatePresence` fires the exit animation.

**The `mode="popLayout"` is critical** to keep — it removes the exiting item from document flow immediately, letting remaining items animate to their new positions. Without it, there's a visual gap during exit animations.

**forwardRef note:** If `StatusLine.Item` renders a `motion.div` directly (not a custom component), forwardRef is not needed — `motion.div` handles it internally.

### Plugin Extensibility Approach

**Recommendation: Pure composition.** No registration API needed. Plugin items are `<StatusLine.Item>` children declared in the calling component's JSX. Order is determined by JSX declaration order, with an optional `order` number prop for sorting.

```tsx
// In a future plugin system:
<StatusLine sessionId={id}>
  <StatusLine.Item itemKey="cwd" visible={showCwd}>
    <CwdItem cwd={cwd} />
  </StatusLine.Item>
  {/* Plugin slot — just declare it */}
  <PluginStatusItems sessionId={id} /> {/* renders more StatusLine.Items */}
</StatusLine>
```

The composition model is flexible enough to support this without any registration infrastructure.

### Recommendation

**Recommended Approach: Solution 1 — Declarative Composition + CSS Separator**

**Rationale:**

- Preserves all existing animation behavior (`AnimatePresence`, `mode="popLayout"`, `layout` prop, item transition config)
- Declarative API is clearly better ergonomics than the current imperative array
- CSS separator eliminates the need for a full registration context, keeping the context minimal (just `itemTransition`)
- Plugin extensibility comes for free via JSX composition
- The only "registration" needed is a lightweight visible-count counter for `hasVisibleChildren` detection
- Matches what Radix UI, Headless UI, and Shadcn/ui all do: thin context, declarative children, CSS for visual separators

**Caveats:**

- The CSS separator `::before` approach requires care in Tailwind v4 — test that the arbitrary variant `[&>*:not(:first-child)]:before:content-['·']` works correctly with the flex layout. An alternative is a `data-separator` attribute on the `motion.div` inside each Item and a global CSS rule.
- `hasVisibleChildren` still requires a lightweight registration effect (one `useEffect` per Item). This is a minor render cycle but acceptable at ~9 items.
- If future requirements include animated separators (fade in/out), migration to Solution 2 is straightforward from Solution 1 — the context shape just needs `visibleKeys` added.
- The `mode="popLayout"` requirement for non-`static` parent position: add `relative` to the flex container if not already present.

---

## Sources & Evidence

- "Children utilities are in maintenance mode because they do not compose well." — [React Children Docs](https://react.dev/reference/react/Children)
- "React.Children.toArray doesn't traverse through React Fragments." — [Smashing Magazine: React Children Iteration](https://www.smashingmagazine.com/2021/08/react-children-iteration-methods/)
- "The mode="popLayout" mode removes the exiting element from document flow immediately, allowing surrounding elements to reflow while the exit animation plays." — [Motion AnimatePresence Modes Tutorial](https://motion.dev/tutorials/react-animate-presence-modes)
- "When using popLayout, any custom component that's an immediate child of AnimatePresence must be wrapped in React's forwardRef." — [Motion AnimatePresence Docs](https://motion.dev/docs/react-animate-presence)
- "Only direct children of the parent component will have access to the props, meaning we can't wrap any of these components in another component." — [Patterns.dev Compound Pattern](https://www.patterns.dev/react/compound-pattern/)
- Radix UI Toolbar anatomy (compound component model): `Toolbar.Root > Toolbar.Button | Toolbar.Separator | Toolbar.ToggleGroup` — [Radix UI Toolbar](https://www.radix-ui.com/primitives/docs/components/toolbar)
- "By using Children.toArray, we can remove null children. However, if one of the children is a component that returns null, we won't be able to recognize it." — [DEV: Inserting Separators Between Flexbox Items](https://dev.to/radzion/how-to-insert-separator-element-between-flexbox-items-in-react-5fk9)
- TypeScript compound component static property pattern: `const StatusLine = Object.assign(StatusLineRoot, { Item: StatusLineItem })` — [Medium: React Compound Component with TypeScript](https://medium.com/@win.le/react-compound-component-with-typescript-d7944ac0d1d6)
- "Avoid unnecessary re-renders by not re-creating context values each render. In complex scenarios, you might optimize by memoizing the context value or splitting context." — [FreeCodeCamp: Compound Components Pattern](https://www.freecodecamp.org/news/compound-components-pattern-in-react/)

## Research Gaps & Limitations

- No definitive benchmark on performance of `useEffect` registration vs `React.Children` for ~9 items at this scale (both are negligible)
- The motion.dev documentation site was not parseable by WebFetch (CSS-only response); popLayout specifics were sourced from search result summaries and community articles
- No existing DorkOS compound component example to reference as an internal pattern baseline

## Search Methodology

- Searches performed: 10
- Most productive terms: "React compound component AnimatePresence", "React.Children limitations maintenance mode", "separator between animated items flex row", "popLayout mode requirements forwardRef"
- Primary sources: motion.dev, patterns.dev, radix-ui.com, react.dev, Smashing Magazine
