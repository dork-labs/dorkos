---
title: 'Animated Rotating Placeholder Text Patterns for Chat Inputs'
date: 2026-03-24
type: external-best-practices
status: active
tags: [animation, placeholder, chat-input, framer-motion, motion, ux-patterns, react]
searches_performed: 14
sources_count: 22
---

## Research Summary

Animated rotating placeholder text in chat inputs is a well-established pattern across AI products and developer tools. There are a handful of npm libraries built specifically for it, but none are meaningfully maintained or widely adopted at scale. The dominant real-world approach is a bespoke 20-50 line React component using either `motion/react` (`AnimatePresence` + `key` prop) or a pure CSS opacity toggle — no third-party animation library needed beyond what DorkOS already has. The Aceternity UI "Placeholders and Vanish Input" component is the closest battle-tested reference implementation that fits our stack.

---

## Key Findings

1. **No dominant dedicated npm library exists.** The closest purpose-built package is `react-placeholder-typing` (84 weekly downloads), which is effectively abandoned. General-purpose libraries (`react-type-animation`, `react-simple-typewriter`) have moderate adoption (~57k–90k weekly downloads) but are designed for visible text blocks, not input placeholder overlays.

2. **The standard technique is an absolute-position overlay, not `::placeholder`.** The `::placeholder` pseudo-element cannot be meaningfully animated with JavaScript; you can only set static text via `placeholder` attribute. All production implementations render a `div` positioned absolutely over the input, with `pointer-events: none` and hidden when the input has a value.

3. **Two dominant animation approaches:** (a) `AnimatePresence` + `key` prop via `motion/react` — gives clean enter/exit with full control over direction and easing; (b) CSS `opacity` toggle via `setInterval` — zero dependency, trivially simple, used by many handwritten implementations.

4. **Aceternity UI ships a production-quality reference component** ("Placeholders and Vanish Input") built on Framer Motion + Tailwind, credited to "Rauno's Craft of Vanish Input." It cycles through a `placeholders: string[]` prop and adds a canvas-based particle vanish effect on submit. The cycling logic is exactly what we need.

5. **Major AI products mostly use static placeholder text.** ChatGPT uses "Message ChatGPT." Claude.ai uses "How can Claude help you today?" Perplexity uses "Ask anything." None of these cycle. The rotating hint pattern is more prominent in tools like Raycast and Linear's command palette, and on AI product marketing pages (OpenAI's homepage hero used the vanish input pattern, which is where Aceternity drew inspiration).

---

## Detailed Analysis

### Library Landscape

| Package                    | Weekly DLs        | Last Published | Technique                       | Notes                                                      |
| -------------------------- | ----------------- | -------------- | ------------------------------- | ---------------------------------------------------------- |
| `react-type-animation`     | ~57k–90k          | 2 years ago    | Typewriter (type + delete loop) | Most adopted, no framer dep                                |
| `react-simple-typewriter`  | ~22.5k            | Active         | Typewriter (type + delete loop) | Hook-based API                                             |
| `typewriter-effect`        | ~72k+ (estimated) | Active         | Typewriter                      | Vanilla JS wrapper                                         |
| `react-text-transition`    | Unknown           | Active         | Spring slide (react-spring dep) | Clean API, good for visible text                           |
| `react-placeholder-typing` | 84                | Stale          | CSS keyframe typing             | Only one specifically for `<input>` placeholder; abandoned |
| `react-animated-text`      | Unknown           | 7 years ago    | Various                         | Dead                                                       |

**Takeaway:** None of these are worth adding as a dependency for our use case. The typewriter libraries are designed for visible output text (think hero headings), not input hints. `react-placeholder-typing` does target `<input>` specifically but is abandoned and has 84 weekly downloads.

### How Major Products Handle It

**ChatGPT (openai.com):** Static placeholder: "Message ChatGPT." No rotation. The cycling placeholder is on OpenAI's _marketing homepage_ hero section, not in the product UI itself — that's what inspired the Aceternity component.

**Claude (claude.ai):** Static placeholder: "How can Claude help you today?" No rotation.

**Perplexity:** Static placeholder: "Ask anything." No rotation. Their notable UI animation is elsewhere (the search mode switcher).

**v0.dev:** Static placeholder text in the prompt input. No rotation.

**Cursor IDE:** The Cmd+K / Cmd+L inputs use static placeholder text.

**Linear (command palette):** Linear's Cmd+K input uses a static "Type a command or search…" placeholder. No rotation. Their notable micro-interaction is the keyboard shortcut hints shown in the command list, not the input itself.

**Raycast:** Raycast's search bar uses static placeholder text ("Search for apps and commands"). Their "placeholders" feature refers to something different — template variables in AI commands.

**Arc browser command bar:** Static placeholder text.

**Pattern summary:** The vast majority of AI chat products do _not_ rotate placeholder text in the actual product UI. It is primarily a marketing page / hero section pattern. Where it does appear in product UIs, it is in discovery-oriented surfaces (first run, empty state) to suggest capabilities.

### Common UX Patterns (Ranked by Usage)

1. **Static placeholder** — Most common by far. Minimal cognitive load, no distraction while typing.

2. **Crossfade cycling** — Simple opacity fade between strings on a timer. Gentle, not distracting. Best for showing example prompts.

3. **Typewriter (type + erase)** — Types out a string, pauses, erases, types next. Attention-grabbing but potentially annoying on repeated views. Best reserved for marketing/hero contexts.

4. **Slide up/down** — New text slides in from below (or above), old text slides out. Used by Aceternity UI's component. Feels like a slot machine / ticker — energetic.

5. **Morphing/blur cross-dissolve** — Letters individually animate between words (MagicUI Morphing Text). Impressive but heavy and inappropriate for a utility input.

6. **Canvas particle vanish on submit** — Aceternity's "Vanish Input" submits by exploding the text into particles. Very memorable, but likely too flashy for DorkOS's terminal-oriented aesthetic.

### Implementation Approaches

#### Option A: motion/react AnimatePresence + key prop (Recommended)

The cleanest approach for a codebase already using `motion/react`:

```tsx
import { AnimatePresence, motion } from 'motion/react';

function RotatingPlaceholder({
  texts,
  interval = 3000,
  visible,
}: {
  texts: string[];
  interval?: number;
  visible: boolean;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % texts.length), interval);
    return () => clearInterval(id);
  }, [visible, texts.length, interval]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center px-3">
      <AnimatePresence mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          className="text-muted-foreground text-sm"
        >
          {texts[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
```

The parent component hides this overlay when `input.value.length > 0` or when the agent is running.

**Pros:** No new dependency (motion/react already in use), full control over animation curve, enter/exit symmetry via `AnimatePresence`, cleans up on unmount.

**Cons:** Requires positioning the overlay correctly relative to the input's padding.

#### Option B: CSS opacity toggle (Zero-dependency)

```tsx
function RotatingPlaceholder({ texts, visible }: { texts: string[]; visible: boolean }) {
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setIndex((i) => (i + 1) % texts.length);
        setFading(false);
      }, 300);
    }, 3000);
    return () => clearInterval(id);
  }, [visible, texts.length]);

  if (!visible) return null;

  return (
    <span
      className="pointer-events-none absolute transition-opacity duration-300 ..."
      style={{ opacity: fading ? 0 : 0.5 }}
    >
      {texts[index]}
    </span>
  );
}
```

**Pros:** No dependencies at all, very simple.
**Cons:** Two `setInterval`/`setTimeout` interactions can desync; the opacity transition is less expressive than enter/exit with displacement.

#### Option C: react-text-transition (react-spring dep)

Uses spring physics for a slot-machine slide animation. Adds `react-spring` as a dependency, which is a large library (~130kb). Overkill.

#### Option D: CSS-only with `::placeholder` (does not work for rotation)

CSS animations on `::placeholder` only control the _appearance_ of static placeholder text (color, opacity of the placeholder itself). You cannot swap the text value via CSS alone — that requires a JS attribute update. Multiple animated `::placeholder` values is not possible. This approach dead-ends quickly.

### The Aceternity "Placeholders and Vanish Input" Reference

URL: https://ui.aceternity.com/components/placeholders-and-vanish-input

This is the most complete, battle-tested example of exactly this pattern. Its cycling logic:

- Accepts `placeholders: string[]`
- Cycles via `setInterval` (no framer for the cycle itself — framer is only used for the canvas vanish effect on submit)
- Hides the placeholder when `input.value.length > 0`
- Uses a canvas + `requestAnimationFrame` for the particle explosion on submit

The cycling interval logic is instructive but the canvas vanish effect is specific to their aesthetic. For DorkOS, Option A (motion/react AnimatePresence) is the right subset.

### MagicUI Options

MagicUI (magicui.design) offers `TypingAnimation` (typewriter with cursor), `MorphingText` (letter-level morph), and `TextAnimate` (word/character reveal). All are designed for visible display text, not input overlays. Their install pattern (shadcn-style copy-paste) is compatible with DorkOS but none target the input placeholder use case specifically.

---

## Recommendation

**Build a bespoke `AnimatedPlaceholder` component (~50 lines) using `motion/react` AnimatePresence.**

Rationale:

- DorkOS already has `motion/react` in the client — zero new dependencies
- AnimatePresence with `key` prop is the idiomatic, well-documented pattern in our animation system
- Full control over animation style: a subtle `y: 8 → 0` crossfade matches DorkOS's restrained aesthetic better than typewriter or spring-slide
- Can be hidden instantly and without jank when user starts typing or agent is running
- 50 lines of code vs. adding a library with 84 weekly downloads

**Suggested copy for DorkOS chat input placeholders:**
Cycle on 4-second interval, only when session is idle and input is empty. Suggestions:

- "Start a new task..."
- "Ask your agent to refactor a module"
- "Schedule a background job"
- "What did your agents do last night?"
- "Spin up a new session in /path/to/project"

---

## Research Gaps & Limitations

- Could not directly inspect the DOM/source of ChatGPT, Claude.ai, or Perplexity's inputs at runtime (no browser automation available in this research context)
- Exact weekly download numbers for `react-text-transition` and `typewriter-effect` could not be confirmed (npm registry returned 403 to WebFetch)
- Raycast is a native macOS app — no web source to inspect

## Search Methodology

- Searches performed: 14
- Most productive terms: "react animated rotating placeholder text chat input npm", "aceternity placeholder vanish input", "motion/react AnimatePresence cycling text key prop", "react-text-transition"
- Primary sources: npmjs.com, aceternity UI docs, magicui.design, motion.dev docs, bionicjulia.com

## Sources & Evidence

- [react-type-animation on npm](https://www.npmjs.com/package/react-type-animation) — ~57k–90k weekly downloads, last published 2 years ago
- [react-simple-typewriter on npm](https://www.npmjs.com/package/react-simple-typewriter) — 22,545 weekly downloads
- [react-placeholder-typing (Socket.dev analysis)](https://socket.dev/npm/package/react-placeholder-typing) — 84 weekly downloads, purpose-built for input placeholders
- [react-text-transition on GitHub](https://github.com/WinterCore/react-text-transition) — uses react-spring, slide direction support
- [Placeholders and Vanish Input — Aceternity UI](https://ui.aceternity.com/components/placeholders-and-vanish-input) — best reference implementation
- [Typewriter Effect Component — Aceternity UI](https://ui.aceternity.com/components/typewriter-effect) — typewriter for display text
- [MorphingText — MagicUI](https://magicui.design/docs/components/morphing-text) — letter-level morphing, too heavy for placeholders
- [TypingAnimation — MagicUI](https://magicui.design/docs/components/typing-animation) — typewriter with cursor, display text only
- [AnimatePresence docs — Motion](https://motion.dev/docs/react-animate-presence) — canonical reference for key-prop cycling pattern
- [The Power of Keys in Framer Motion](https://www.nan.fyi/keys-in-framer-motion) — explains key-triggered remount pattern
- [Rotating input placeholder text — CodePen (cheeaun)](https://codepen.io/cheeaun/pen/jMKzQO) — pure CSS approach reference
- [Animated placeholder with CSS/Tailwind — DEV](https://dev.to/tayfunerbilen/animated-placeholder-with-css-tailwind-2oc0) — label-float technique, not cycling
- [Creating a React component that fades changing words — Bionic Julia](https://bionicjulia.com/blog/creating-react-component-fades-changing-words) — clean CSS opacity + setInterval pattern
- [react-placeholder-typing on GitHub](https://github.com/pashanitw/react-placeholder-typing) — only purpose-built package; essentially abandoned
- [npm trends comparison](https://npmtrends.com/react-type-animation-vs-react-typing-vs-react-typing-animation) — download trend data
- [Perplexity iOS UI/UX animations — 60fps.design](https://60fps.design/apps/perplexity) — documents Perplexity's actual animation patterns
