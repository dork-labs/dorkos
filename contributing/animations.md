# Animations Guide

## Overview

This project uses [Motion](https://motion.dev/) (version 12.x, formerly Framer Motion) for declarative animations. Motion provides React components that animate on mount, exit, and user interaction while maintaining accessibility and performance.

## Key Files

| Concept                      | Location                                              |
| ---------------------------- | ----------------------------------------------------- |
| Motion library import        | `motion/react` package                                |
| Animation utilities (CSS)    | `apps/client/src/index.css` (transition classes, keyframes) |
| Tailwind animation utilities | `tw-animate-css` (imported in index.css)                    |
| Accordion animations         | CSS keyframes in `index.css`                                |
| Common UI patterns           | `apps/client/src/layers/shared/ui/` (dropdowns, tooltips)   |

## When to Use What

| Scenario                                   | Approach                                   | Why                                         |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------- |
| Simple transitions (fade, slide)           | CSS transitions with Tailwind              | Performant, no JS overhead                  |
| Complex multi-property animations          | Motion with `motion.div`                   | Declarative, supports spring physics        |
| Conditional rendering with exit animations | `<AnimatePresence>` wrapper                | Waits for exit animation before unmounting  |
| List items appearing sequentially          | Motion variants with `staggerChildren`     | Coordinated animations with one declaration |
| Interactive hover/tap effects              | `whileHover` / `whileTap` props            | Built-in gesture handling                   |
| Layout animations (reordering, resizing)   | `layout` prop                              | Automatically animates layout changes       |
| Accessibility concerns                     | `useReducedMotion` hook or CSS media query | Respects user preferences                   |

## Core Patterns

### Basic Fade In

Use for simple entrance animations when components mount.

```typescript
import { motion } from 'motion/react'

export function FadeIn({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  )
}
```

### Fade and Slide (Most Common Pattern)

Combines opacity and vertical translation for polished entrance effects.

```typescript
import { motion } from 'motion/react'

export function FadeInUp({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}
```

### Interactive Button Effects

Add hover and tap feedback for better user experience.

```typescript
import { motion } from 'motion/react'

export function AnimatedButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <motion.button
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      {...props}
    >
      {children}
    </motion.button>
  )
}
```

### Staggered List Animation

Items appear sequentially with a delay between each.

```typescript
import { motion } from 'motion/react'

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1, // 100ms delay between children
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
}

export function StaggeredList({ items }: { items: { id: string; name: string }[] }) {
  return (
    <motion.ul
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      {items.map((item) => (
        <motion.li key={item.id} variants={itemVariants}>
          {item.name}
        </motion.li>
      ))}
    </motion.ul>
  )
}
```

### Exit Animations (Modal/Overlay)

Use `AnimatePresence` to animate components when they unmount.

```typescript
import { AnimatePresence, motion } from 'motion/react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
}

export function Modal({ isOpen, onClose, children }: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 z-40"
          />

          {/* Modal content */}
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            onClick={(e) => e.stopPropagation()} // Prevent backdrop click
            className="fixed inset-0 flex items-center justify-center z-50"
          >
            <div className="bg-card rounded-xl p-6 shadow-modal max-w-md w-full">
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
```

### Reusable Animation Variants

Define variants once, reuse across components.

```typescript
import { motion } from 'motion/react'

// Define once, use anywhere
const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <motion.div {...fadeInUp} transition={{ duration: 0.3 }}>
      {children}
    </motion.div>
  )
}
```

### Spring vs Ease Transitions

Choose the right transition type for the animation feel.

```typescript
// Spring (bouncy, natural physics)
<motion.div
  animate={{ x: 100 }}
  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
/>

// Ease (smooth, controlled)
<motion.div
  animate={{ x: 100 }}
  transition={{ ease: 'easeOut', duration: 0.3 }}
/>

// With delay
<motion.div
  animate={{ x: 100 }}
  transition={{ delay: 0.2, duration: 0.3 }}
/>
```

### Chat Microinteraction Spring Presets

DorkOS uses a small set of named spring presets for chat interactions. Prefer these over ad-hoc values for consistency:

| Use case | Preset | Character |
|---|---|---|
| Message entry (new messages) | `{ type: 'spring', stiffness: 320, damping: 28 }` | Snappy, no bounce, settles ~250ms |
| Sidebar active indicator slide | `{ type: 'spring', stiffness: 280, damping: 32 }` | Smooth, deliberate navigation feel |
| Tap feedback (buttons, session rows) | `{ type: 'spring', stiffness: 400, damping: 30 }` | Quick response, already used in ToolCallCard chevron |
| Session crossfade | `{ duration: 0.15, ease: 'easeInOut' }` | Linear opacity — intentional, not spring |

Session crossfade uses duration-based easing rather than spring physics because opacity fades are perceptually linear and a spring would add unnecessary overshoot to a simple visibility transition.

### LayoutId Selection Indicator

Use for a sliding pill/highlight effect as keyboard focus moves between items in a list. The indicator animates its position between items using Motion's `layoutId` feature.

```typescript
import { motion, LayoutGroup } from 'motion/react'

// Wrap the list in LayoutGroup to scope the layoutId
<LayoutGroup>
  <ul>
    {items.map((item) => (
      <li key={item.id} className="relative">
        {/* Sliding selection background - renders behind content */}
        {isSelected(item.id) && (
          <motion.div
            layoutId="my-selection-indicator"
            className="bg-accent absolute inset-0 rounded-sm"
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          />
        )}
        {/* Content must sit above the indicator */}
        <div className="relative z-10">
          {item.name}
        </div>
      </li>
    ))}
  </ul>
</LayoutGroup>
```

Key details:

- The `motion.div` with `layoutId` must be `position: absolute` with `inset-0` inside each selectable item
- Item content must be `position: relative` with `z-10` to render above the indicator
- Wrap the list in `<LayoutGroup>` to scope the `layoutId` and prevent conflicts with other layout animations
- Spring config: `stiffness: 500`, `damping: 40` for a snappy feel

**Session sidebar usage**: The `SessionItem` component uses `layoutId="active-session-bg"` for the active session background. The `SidebarContent` ancestor carries the `layout` prop to enable correct position measurement during list scroll. The spring preset for this indicator is `{ type: 'spring', stiffness: 280, damping: 32 }` (smooth slide, not the snappier button preset).
- Respects `prefers-reduced-motion` via the existing `<MotionConfig reducedMotion="user">` wrapper in `App.tsx`

### Stagger on Open (Not on Every Keystroke)

Use for items that stagger-animate when a dialog or page opens, but should not re-stagger on every search keystroke. The trick is a `staggerKey` state that only changes on open or page transition events.

```typescript
import { motion } from 'motion/react'

const listVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1, y: 0,
    transition: { type: 'spring', stiffness: 400, damping: 30 },
  },
}

// staggerKey changes only on dialog open and page transitions, NOT on search input
const [staggerKey, setStaggerKey] = useState(0)

<motion.div
  key={staggerKey}
  variants={listVariants}
  initial="hidden"
  animate="visible"
>
  {items.map((item, index) => (
    <motion.div
      key={item.id}
      // Limit stagger to first 8 items for performance
      variants={index < 8 ? itemVariants : undefined}
    >
      {item.name}
    </motion.div>
  ))}
</motion.div>
```

Key details:

- `staggerChildren: 0.04` (40ms per item), `delayChildren: 0.05` (50ms initial delay)
- The `key={staggerKey}` on the container forces a remount (and thus re-stagger) only when `staggerKey` changes
- Limit stagger to the first 8 visible items -- items beyond index 7 render immediately without animation to avoid excessive delay
- Update `staggerKey` on dialog open and page transitions, never on search input changes

### Dialog Entrance (Spring Scale + Fade)

Use for modals, command palettes, and overlays that open with a spring-based scale and fade effect.

```typescript
const dialogVariants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 500, damping: 35 },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -8,
    transition: { duration: 0.12 },
  },
}

<AnimatePresence>
  {isOpen && (
    <motion.div
      variants={dialogVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {children}
    </motion.div>
  )}
</AnimatePresence>
```

Key details:

- Initial state: `scale: 0.96` (slightly smaller) and `y: -8` (slightly above) create anticipatory positioning
- Spring transition: `stiffness: 500` (snappy), `damping: 35` (controlled)
- Exit: short `duration: 0.12` for quick dismissal
- Used in: command palette dialog, confirmation modals

### Directional Page Transitions

Animate between pages in a multi-level navigation (e.g., cmdk sub-menu stack). Items slide horizontally based on navigation direction.

```typescript
<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={currentPage ?? 'root'}
    initial={{ opacity: 0, x: isForward ? 16 : -16 }}
    animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: isForward ? -16 : 16 }}
    transition={{ duration: 0.15, ease: 'easeOut' }}
  >
    {children}
  </motion.div>
</AnimatePresence>
```

Key details:

- `mode="wait"` ensures exit animation completes before enter starts
- Forward navigation starts at `x: 16` (off-right), backward at `x: -16` (off-left)
- Duration: 150ms with `easeOut` for natural deceleration
- Used in: command palette sub-menus, breadcrumb navigation

### Item Hover Nudge

A subtle rightward nudge on hover for list items, menu entries, and command palette selections (Linear pattern).

```typescript
<motion.div
  whileHover={{ x: 2 }}
  transition={{ type: 'spring', stiffness: 600, damping: 40 }}
>
  {children}
</motion.div>
```

Key details:

- Distance: `x: 2` (2px rightward) — subtle, non-intrusive
- Spring: `stiffness: 600`, `damping: 40` for snappy, responsive feel (~50-80ms)
- Respects `prefers-reduced-motion` via global `<MotionConfig reducedMotion="user">`

### Height Collapse Animation (Overflow Items)

Reveal or hide a section by animating `height: 0 ↔ 'auto'` with `opacity`. Use this for collapsible rows, overflow sections, or expandable list tails — cases where the item count is unknown and `height: 'auto'` is required.

```typescript
const collapseVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;
const collapseTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

<AnimatePresence>
  {isExpanded && (
    <motion.div
      variants={collapseVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={collapseTransition}
      className="overflow-hidden"
    >
      {overflowItems}
    </motion.div>
  )}
</AnimatePresence>
```

Key details:

- `overflow: hidden` is **required** — clips content while the height collapses to zero
- Motion handles the `height: 'auto'` special case natively — no JS measurement needed
- Use ease-out (e.g., cubic-bezier `[0, 0, 0.2, 1]`) rather than spring for height — spring physics on height produce overshooting artifacts
- Define variants at **module scope** (not inline) to avoid object recreation on every render
- This is an acceptable exception to the "don't animate height directly" anti-pattern: `height: 0 ↔ 'auto'` collapse is Motion's dedicated mechanism for variable-height reveals

**Used in:** ConnectionsView overflow rows (agents list, MCP servers list)

### Width Spring Animation (Expanding Panel)

Animate a panel sliding in from the edge by animating `width` and `opacity` together. While animating layout dimensions is generally discouraged (see Anti-Patterns), width spring animations on fixed-width containers are acceptable when used sparingly for reveal panels.

```typescript
<AnimatePresence>
  {isVisible && (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: '60%' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className="border-l overflow-hidden"
    >
      {children}
    </motion.div>
  )}
</AnimatePresence>
```

Key details:

- Animate both `opacity` and `width` for a smooth reveal
- Set `overflow: hidden` to clip content while collapsing
- Spring: `stiffness: 400`, `damping: 35` (slightly softer than dialog entrance)
- Pair with a container size transition (e.g., `maxWidth: 480px → 720px`) for the parent
- Used in: command palette preview panel, sidebars, detail views

## Anti-Patterns

```typescript
// ❌ NEVER animate layout properties without will-change or transform
<motion.div
  animate={{ width: 300, height: 200 }}  // Causes layout thrashing, poor performance
/>

// ✅ Use transform properties (scale, translate) instead
<motion.div
  animate={{ scale: 1.5 }}  // GPU-accelerated, smooth
  style={{ willChange: 'transform' }}
/>
```

```typescript
// ❌ Don't use inline variants for every element
<motion.div
  variants={{
    hidden: { opacity: 0 },
    show: { opacity: 1 }
  }}
  initial="hidden"
  animate="show"
/>

// ✅ Define variants once at module level
const fadeIn = {
  hidden: { opacity: 0 },
  show: { opacity: 1 }
}

<motion.div variants={fadeIn} initial="hidden" animate="show" />
```

```typescript
// ❌ Don't forget AnimatePresence for exit animations
{isOpen && (
  <motion.div exit={{ opacity: 0 }}>  // Exit animation won't work!
    Modal content
  </motion.div>
)}

// ✅ Wrap with AnimatePresence
<AnimatePresence>
  {isOpen && (
    <motion.div exit={{ opacity: 0 }}>  // Exit animation works
      Modal content
    </motion.div>
  )}
</AnimatePresence>
```

```typescript
// ❌ Don't animate width/height/top/left directly
<motion.div
  animate={{
    width: '100%',
    height: '50px',
    top: '100px',
    left: '200px'
  }}  // Forces layout recalculation, janky
/>

// ✅ Use transform and opacity for best performance
<motion.div
  animate={{
    scale: 1.2,
    x: 100,
    y: 50,
    opacity: 1
  }}  // GPU-accelerated, 60fps
/>
```

```typescript
// ❌ Don't over-animate (too many simultaneous animations)
<motion.div
  animate={{
    scale: [1, 1.2, 1],
    rotate: [0, 360],
    borderRadius: ['20%', '50%', '20%'],
    opacity: [1, 0.5, 1]
  }}
  transition={{ duration: 0.5, repeat: Infinity }}
/>  // Distracting, poor UX

// ✅ Keep animations subtle and purposeful
<motion.div
  whileHover={{ scale: 1.05 }}
  transition={{ duration: 0.2 }}
/>  // Provides feedback without distraction
```

```typescript
// ✅ Reduced motion is handled globally — no per-component work required
// App.tsx wraps everything in:
// <MotionConfig reducedMotion="user">
// This automatically disables transform/layout animations when the user has
// prefers-reduced-motion: reduce set in their OS settings.
// You do not need to call useReducedMotion() in individual components.

// If you need to conditionally adjust non-motion behavior based on the setting:
import { useReducedMotion } from 'motion/react'

export function AnimatedCard() {
  const shouldReduceMotion = useReducedMotion()
  // Use only when you need to customize non-Motion behavior (e.g., skip a delay)
}
```

## Troubleshooting

### Animation doesn't play on mount

**Cause**: The component might not have mounted yet, or `initial` and `animate` are identical.

**Fix**: Ensure `initial` and `animate` have different values. DorkOS is a Vite SPA — there is no server rendering, so `'use client'` directives and SSR-related fixes do not apply here.

### Exit animation doesn't work

**Cause**: Missing `AnimatePresence` wrapper or element key.

**Fix**: Wrap conditional renders with `AnimatePresence` and ensure stable keys:

```typescript
import { AnimatePresence, motion } from 'motion/react'

<AnimatePresence>
  {isVisible && (
    <motion.div
      key="modal"  // Required for AnimatePresence to track
      exit={{ opacity: 0 }}
    >
      Content
    </motion.div>
  )}
</AnimatePresence>
```

### Animation feels janky or slow

**Cause**: Animating layout properties (width, height, top, left, margin, padding) instead of transform properties.

**Fix**: Use `transform` properties (scale, x, y, rotate) and `opacity`:

```typescript
// Instead of animating width/height
<motion.div animate={{ width: 300, height: 200 }} />

// Use scale
<motion.div animate={{ scale: 1.5 }} />
```

**Additional fix**: Add `will-change` for frequently animated elements:

```typescript
<motion.div
  animate={{ x: 100 }}
  style={{ willChange: 'transform' }}
/>
```

### Stagger animation doesn't work

**Cause**: Child elements missing `variants` prop or parent missing orchestration props.

**Fix**: Ensure parent has `initial` and `animate`, children have `variants`:

```typescript
const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.1 }
  }
}

const item = {
  hidden: { opacity: 0 },
  show: { opacity: 1 }
}

// Parent needs initial + animate
<motion.ul variants={container} initial="hidden" animate="show">
  {/* Children need variants */}
  {items.map(item => (
    <motion.li key={item.id} variants={item}>
      {item.name}
    </motion.li>
  ))}
</motion.ul>
```

### Layout animation causes content jump

**Cause**: Using `layout` prop without proper key management or shared layout IDs.

**Fix**: Ensure stable keys and consider using `layoutId` for shared element transitions:

```typescript
<motion.div layout layoutId="unique-id" />
```

### `willChange` usage warnings in console

**Cause**: `will-change: transform` set on too many elements simultaneously.

**Fix**: Only add `will-change` to elements that are actively animating on a timer or user interaction loop. Remove it after the animation completes when possible.

## Performance Best Practices

### 1. Prefer Transform and Opacity

Only these properties are GPU-accelerated for 60fps animations:

| GPU-Accelerated | Triggers Layout Recalc |
| --------------- | ---------------------- |
| `opacity`       | `width`, `height`      |
| `scale`         | `top`, `left`          |
| `x`, `y`        | `margin`, `padding`    |
| `rotate`        | `border-width`         |

### 2. Use will-change Sparingly

Add `will-change` to elements that animate frequently:

```typescript
<motion.div
  animate={{ x: 100 }}
  style={{ willChange: 'transform' }}
/>
```

**Warning**: Don't add `will-change` to everything—it consumes memory. Only use for actively animating elements.

### 3. Reduce Motion for Accessibility

`<MotionConfig reducedMotion="user">` in `App.tsx` handles this globally for all Motion animations. Additionally, `index.css` collapses all CSS `animation-duration` and `transition-duration` to `0.01ms` under `@media (prefers-reduced-motion: reduce)`, covering any non-Motion CSS animations.

No per-component `useReducedMotion` calls are needed unless you need to gate non-animation behavior on that preference.

### 4. Animation Duration Guidelines

Follow the Calm Tech design system:

| Animation Type          | Duration  | Example                                   |
| ----------------------- | --------- | ----------------------------------------- |
| Micro-interactions      | 100-150ms | Button hover, checkbox toggle             |
| Component entrance      | 200-300ms | Modal open, card fade in                  |
| In-page page transitions | 150ms    | Command palette sub-menu x-axis slide     |
| Drawer/overlay slide    | 200ms     | Embedded sidebar, floating toggle button  |

Faster animations feel more responsive; slower animations can feel laggy. Prefer spring physics (`type: 'spring'`) over duration-based easing for interactive elements — the spring self-terminates based on stiffness/damping rather than a fixed time.

## References

- [Motion Documentation](https://motion.dev/) - Official API reference
- [Calm Tech Design System](./design-system.md) - Animation philosophy and duration standards
- [Styling and Theming Guide](./styling-theming.md) - CSS transitions and Tailwind utilities
