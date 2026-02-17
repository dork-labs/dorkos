# Animations Guide

## Overview

This project uses [Motion](https://motion.dev/) (version 12.x, formerly Framer Motion) for declarative animations. Motion provides React components that animate on mount, exit, and user interaction while maintaining accessibility and performance.

## Key Files

| Concept                      | Location                                              |
| ---------------------------- | ----------------------------------------------------- |
| Motion library import        | `motion/react` package                                |
| Animation utilities (CSS)    | `src/app/globals.css` (transition classes, keyframes) |
| Tailwind animation utilities | `tw-animate-css` (imported in globals.css)            |
| Accordion animations         | CSS keyframes in `globals.css`                        |
| Common UI patterns           | `src/components/ui/*` (dropdowns, tooltips, etc.)     |

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
'use client'

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
'use client'

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
'use client'

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
'use client'

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
'use client'

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
'use client'

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
// ❌ Don't ignore accessibility (prefers-reduced-motion)
export function AnimatedCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    />  // Always animates, even if user prefers reduced motion
  )
}

// ✅ Respect user preferences with CSS or useReducedMotion
import { useReducedMotion } from 'motion/react'

export function AnimatedCard() {
  const shouldReduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    />
  )
}
```

## Troubleshooting

### Animation doesn't play on mount

**Cause**: Component is server-rendered and needs `'use client'` directive.

**Fix**: Add `'use client'` at the top of the file:

```typescript
'use client'

import { motion } from 'motion/react'

export function AnimatedComponent() {
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
}
```

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

### "Warning: useLayoutEffect does nothing on the server"

**Cause**: Motion component rendered on server without `'use client'`.

**Fix**: Add `'use client'` directive to the file using Motion components.

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

Respect user preferences with CSS or `useReducedMotion`:

```typescript
// CSS approach in globals.css (already included)
@media (prefers-reduced-motion: no-preference) {
  html {
    scroll-behavior: smooth;
  }
}

// React hook approach
import { useReducedMotion } from 'motion/react'

const shouldReduceMotion = useReducedMotion()

<motion.div
  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
/>
```

### 4. Animation Duration Guidelines

Follow the Calm Tech design system:

| Animation Type     | Duration  | Example                       |
| ------------------ | --------- | ----------------------------- |
| Micro-interactions | 100-150ms | Button hover, checkbox toggle |
| Component entrance | 200-300ms | Modal open, card fade in      |
| Page transitions   | 300-500ms | Route change, drawer slide    |

Faster animations feel more responsive; slower animations can feel laggy.

## References

- [Motion Documentation](https://motion.dev/) - Official API reference
- [Calm Tech Design System](./design-system.md) - Animation philosophy and duration standards
- [Styling and Theming Guide](./08-styling-theming.md) - CSS transitions and Tailwind utilities
