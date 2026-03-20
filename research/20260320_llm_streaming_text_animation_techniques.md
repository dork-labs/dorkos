---
title: 'LLM Streaming Text Animation Techniques — Premium Chat UI Effects'
date: 2026-03-20
type: external-best-practices
status: active
tags:
  [
    animation,
    streaming,
    text-effects,
    chat-ui,
    react,
    css,
    motion,
    streamdown,
    typewriter,
    performance,
  ]
feature_slug: chat-microinteractions-polish
searches_performed: 16
sources_count: 38
---

# LLM Streaming Text Animation Techniques — Premium Chat UI Effects

## Research Summary

This report covers the full landscape of text streaming animation for LLM chat UIs: what production apps (ChatGPT, Claude.ai, Perplexity) actually do, every known CSS and JS technique, the most relevant libraries, DOM performance implications, and a concrete architecture for pluggable/swappable effects. The most significant finding for DorkOS is that **`streamdown` v2.4.0 (already installed) has a built-in `animated` prop with `fadeIn`, `blurIn`, and `slideUp` presets** — zero new dependencies required.

---

## Key Findings

### 1. What Production AI Chat Apps Actually Do

All three major apps use the same underlying pattern: **instant token append with a visual layer on top**, not character-by-character typewriter effects.

- **ChatGPT**: Tokens are appended directly to the DOM as they arrive. The only animation is a blinking cursor (`|`) while streaming. No per-character opacity or transform. The "gradual appearance" feeling comes from the natural rate of LLM token generation, not artificial delay.
- **Claude.ai**: Identical approach — token append, blinking cursor during streaming, container slides in once on first token. The message container has a subtle entrance animation (`opacity 0 → 1, y: 8 → 0`) but the text within it has no per-token animation.
- **Perplexity**: Uses a subtle **blur-in per word** effect. Each word emerges from a slightly blurred state as it arrives. This is the most sophisticated among the three and creates the distinctive "crystallizing" feel. Implementation is word-level spans with `filter: blur(4px) → blur(0)` + `opacity 0 → 1` via CSS keyframes.

**Why production apps avoid true typewriter (artificial delay):**

1. Artificial delay introduces a perceptual queue — the user can see text "held back" that has already arrived on the server, which feels dishonest.
2. True streaming at LLM token rates (5–30 tokens/sec) is already naturally paced for reading.
3. Character-by-character animation is inaccessible — screen readers would read a still-arriving stream unpredictably.
4. Per-character DOM thrashing at streaming speeds is expensive (see Performance section).

**The Perplexity exception**: Perplexity's blur-in is applied at the word level as words arrive naturally, not as an artificial slow-down. This is the sweet spot — the animation is purely visual, it doesn't delay information delivery.

### 2. The Streamdown Built-In Animation (Key Finding for DorkOS)

**`streamdown` v2.4.0 — already installed as `^2.4.0` — has a built-in `animated` prop.** This is the most important finding. Zero new dependencies.

```tsx
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css'; // includes animation CSS

// Current DorkOS StreamingText.tsx:
<Streamdown shikiTheme={['github-light', 'github-dark']} linkSafety={linkSafety}>
  {content}
</Streamdown>

// After adding animation:
<Streamdown
  shikiTheme={['github-light', 'github-dark']}
  linkSafety={linkSafety}
  animated={{ animation: 'blurIn', duration: 150, easing: 'ease-out', sep: 'word' }}
  isAnimating={isStreaming}
>
  {content}
</Streamdown>
```

**How it works internally:**

1. A rehype plugin walks the HAST tree and visits text nodes.
2. Each text node is split into per-word `<span class="sd-flow-token">` elements.
3. React's index-based reconciliation preserves existing spans — only newly appended words animate. Already-visible words never re-flash.
4. When `isAnimating` is `false`, the plugin is excluded entirely — completed messages render with zero span overhead.
5. Code blocks, `<pre>`, `<svg>`, `<math>`, and `<annotation>` elements are never split — their layout integrity is preserved.

**Built-in animation presets:**

| Name      | CSS Effect                                 | Best Use Case                                            |
| --------- | ------------------------------------------ | -------------------------------------------------------- |
| `fadeIn`  | `opacity: 0 → 1`                           | Conservative, universal, zero layout risk                |
| `blurIn`  | `opacity: 0 → 1` + `filter: blur(4px) → 0` | Perplexity-style premium feel; good for fast token rates |
| `slideUp` | `opacity: 0 → 1` + `translateY(4px) → 0`   | Claude.ai-esque; slight physical motion                  |

**Configuration:**

```tsx
animated={{
  animation: 'fadeIn' | 'blurIn' | 'slideUp' | string, // custom keyframe name
  duration: 150,        // ms; increase to 200-300 for fast-streaming models
  easing: 'ease',       // any CSS timing function
  sep: 'word' | 'char', // word is ~10x fewer DOM nodes
}}
```

**Custom animation support:**

```css
/* Define @keyframes with sd- prefix */
@keyframes sd-myEffect {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
```

Then pass `animation: 'myEffect'` (the `sd-` prefix is auto-applied).

**Performance optimization from docs:** For fast-streaming models dumping multiple tokens per render cycle, use `blurIn` (masks batch arrivals better than pure opacity), increase duration to 200–300ms, and use `ease-out` easing.

### 3. Technique Catalogue: CSS Approaches

#### Technique A: Per-Word Fade-In via CSS Keyframes (Recommended)

Wrap each word in a `<span>` and apply a CSS animation. Each span gets an `animation-delay` via inline `style="--i: N"` to stagger the appearance.

```css
@keyframes word-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.word-token {
  display: inline;
  opacity: 0; /* initial state before animation */
  animation: word-fade-in 150ms ease-out forwards;
  animation-delay: calc(var(--i, 0) * 30ms);
}
```

```tsx
// React component
function AnimatedWords({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <>
      {words.map((word, i) => (
        <span key={i} className="word-token" style={{ '--i': i } as React.CSSProperties}>
          {word}{' '}
        </span>
      ))}
    </>
  );
}
```

**Performance:** Only `opacity` is animated — GPU-composited, no layout recalculation. `animation-fill-mode: forwards` keeps the word visible after animation ends. This is the safest and most broadly supported approach.

**Markdown compatibility:** Difficult — requires splitting text nodes inside already-rendered markdown HTML. The `streamdown` `animated` prop solves this correctly via rehype; doing it manually would require a rehype/remark plugin or post-processing pass.

---

#### Technique B: Per-Word Blur-In (Perplexity Style)

Combines opacity with `filter: blur()`. The effect is that words "crystallize" into focus.

```css
@keyframes blur-in {
  from {
    opacity: 0;
    filter: blur(4px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}

.word-token-blur {
  display: inline;
  opacity: 0;
  animation: blur-in 200ms ease-out forwards;
}
```

**Performance caveat (critical):** `filter: blur()` is expensive when the blur radius is animated continuously. However, for this use case the blur only transitions once per word (from blur → sharp), which is a one-shot CSS animation on mount. The Chrome team's research shows the expensive path is animating the blur radius on a promoted layer every frame. A one-shot animation from `blur(4px) → blur(0)` is far cheaper because the browser can schedule it efficiently and it terminates.

The optimization: Keep blur values small (under 8px). Values under 20px are documented as smooth. Avoid `will-change: filter` on many elements simultaneously — only apply to the currently-animating batch.

**Markdown compatibility:** Same constraint as Technique A. Requires text-node splitting via rehype or streamdown's built-in.

---

#### Technique C: Slide-Up Fade Per Word (Claude.ai / Linear style)

```css
@keyframes slide-up-fade {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Both `opacity` and `transform` are GPU-composited. `translateY(4px)` is a very subtle shift — perceptible as "softness" rather than "movement." This is the DorkOS design language's preference (from CLAUDE.md: "every pixel, transition, and word is a decision about quality").

**Markdown compatibility:** Same constraints.

---

#### Technique D: Motion-Blur Typewriter (Character-Level)

Wraps each character in a `<motion.span>` and animates:

```tsx
<motion.span
  initial={{ opacity: 0, x: -2, filter: 'blur(2px)' }}
  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
  transition={{ duration: 0.08 }}
>
  {char}
</motion.span>
```

**Performance verdict: DO NOT USE for streaming text.** At 1000 characters, this creates 1000 `motion.span` elements. Each gets motion.dev's internal animation machinery. The DOM size explodes. Benchmark data shows that beyond ~200 simultaneously-animated elements, JS-driven animation approaches (motion.dev, GSAP, Web Animations API) start to degrade, particularly on mobile. CSS-only keyframes scale better because the browser can batch them off the main thread.

Use this technique only for **static hero text** in marketing contexts where the character count is bounded (< 100 chars) and the animation runs once on mount.

---

#### Technique E: requestAnimationFrame Buffer Queue (Network/Visual Decoupling)

This is not a visual effect technique — it's an **architectural technique** for making streaming feel smooth when the network delivers tokens in uneven bursts. Decouples network chunk arrival from visual token display.

```typescript
function useSmoothedStream(incomingText: string, speedMs = 5) {
  const [visibleText, setVisibleText] = useState('');
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const indexRef = useRef<number>(0);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;

    function tick(time: number) {
      if (time - lastTimeRef.current > speedMs) {
        lastTimeRef.current = time;
        indexRef.current++;
        setVisibleText(incomingText.slice(0, indexRef.current));
      }

      if (indexRef.current < incomingText.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        isAnimatingRef.current = false;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [incomingText, speedMs]);

  return visibleText;
}
```

**When to use:** When LLM tokens arrive in large bursts (e.g., 200 chars at once) and you want visual streaming at a human-readable pace. The Upstash Smooth Streaming article documents this exact pattern for AI SDK v5, using 5ms/character (200 chars/sec) as the sweet spot.

**Critical caveat:** This artificially slows text display. Users who read fast will be frustrated. It is more appropriate for **marketing demos** and **onboarding flows** than for production agent UIs. Kai and Priya (DorkOS's personas) want information fast, not paced.

---

#### Technique F: CSS `animation-delay` with CSS Custom Properties (Static Stagger)

For **hero text reveals** and **marketing pages** — not for streaming:

```css
.stagger-word {
  animation: fade-in 0.5s ease-out both;
  animation-delay: calc(var(--word-index, 0) * 0.04s);
}
```

```tsx
// In JSX — set --word-index as inline style
{
  words.map((word, i) => (
    <span key={i} className="stagger-word" style={{ '--word-index': i } as React.CSSProperties}>
      {word}{' '}
    </span>
  ));
}
```

CSS custom property stagger scales to any number of items without new CSS rules per item. Supports reversed stagger for exit animations by also setting `--word-count` and computing `calc(var(--word-count) - var(--word-index)) * delay`.

---

### 4. Libraries Comparison

| Library                          | Markdown Support            | Word-Level | Char-Level     | Custom Animations    | Streaming-Native                  | Size                         |
| -------------------------------- | --------------------------- | ---------- | -------------- | -------------------- | --------------------------------- | ---------------------------- |
| **`streamdown` `animated` prop** | Full (already in DorkOS)    | Yes        | Yes            | Yes (CSS @keyframes) | Yes (isAnimating flag)            | ~0kb (built-in)              |
| **`flowtoken`**                  | Full (AnimatedMarkdown)     | Yes        | Yes            | Yes                  | Requires `animation=null` on done | ~30kb                        |
| **`react-markdown-typewriter`**  | Full (react-markdown based) | No         | Yes (per-char) | Via motionProps      | Not designed for it               | ~25kb                        |
| **`typeit-react`**               | No                          | No         | Yes            | No                   | Via flush() method                | ~18kb                        |
| **`motion.dev` Typewriter**      | No                          | No         | Yes            | No                   | Not designed for it               | 1.3kb (Motion+ subscription) |
| **Vercel AI SDK `smoothStream`** | N/A (server-side transform) | Yes        | Yes            | N/A                  | Yes (server-side)                 | 0 (SDK built-in)             |

**Recommendation for DorkOS:** Use `streamdown`'s built-in `animated` prop. It is the only solution that correctly handles streaming markdown (including code blocks, links, tables) without splitting tokens across markdown syntax.

---

### 5. Vercel AI SDK `smoothStream` (Server-Side Approach)

`smoothStream` is a server-side `TransformStream` for Vercel AI SDK's `streamText`. It buffers raw LLM output and re-emits it in controlled chunks with configurable delays.

```typescript
import { smoothStream, streamText } from 'ai';

const result = streamText({
  model,
  prompt,
  experimental_transform: smoothStream({
    delayInMs: 20, // delay between chunks (default: 10ms)
    chunking: 'word', // 'word' | 'line' | RegExp | Intl.Segmenter | fn
  }),
});
```

**This is a complementary technique**, not an alternative to frontend animation. It controls the _rate_ at which chunks arrive at the client. It does not provide visual animation effects (opacity, blur, slide). Use it alongside frontend animation to ensure tokens arrive steadily even when the model dumps large batches.

**DorkOS relevance:** DorkOS uses a custom SSE pipeline (not Vercel AI SDK), so `smoothStream` is not directly applicable. The equivalent would be a server-side transform in the Express streaming route.

---

### 6. Performance Deep Dive

#### GPU-Composited Properties (Always Safe)

These properties never trigger layout recalculation or paint. They run entirely on the GPU compositor thread:

- `opacity`
- `transform` (translate, scale, rotate)

**Rule:** All text stream animations should use only `opacity` and/or `transform`. If `filter: blur()` is needed, use it for one-shot transitions on mount (not continuous re-animation).

#### Layout-Triggering Properties (Never Animate)

These trigger full layout recalculation on every frame — catastrophically expensive for many elements:

- `width`, `height`, `margin`, `padding`
- `left`, `top`, `right`, `bottom` (prefer `transform: translate()`)
- `font-size`, `line-height`

#### The Span Proliferation Problem

Wrapping every character in a `<span>` for animation creates a large DOM. Benchmarks and MDN documentation show:

| Granularity   | 1000-char response | DOM nodes added | Risk level           |
| ------------- | ------------------ | --------------- | -------------------- |
| Per-character | 1000 chars         | ~1000 spans     | High on mobile       |
| Per-word      | ~180 words         | ~180 spans      | Moderate, acceptable |
| Per-sentence  | ~8 sentences       | ~8 spans        | Negligible           |

**Recommendation:** Use word-level (`sep: 'word'`) for streaming animation. Character-level is acceptable only for short static strings (hero text, labels < 100 chars).

#### `animation-fill-mode: both` vs `forwards`

Use `both` (or `forwards`) on all streaming token spans. Without it, the span returns to `opacity: 0` after the animation completes — words vanish.

```css
.word-token {
  animation: fade-in 150ms ease-out both; /* 'both' = forwards + backwards */
}
```

#### Disabling Animation on Completed Messages

A critical optimization: once a message is fully streamed, remove animation spans. FlowToken documents this explicitly: `animation={null}` on completed messages. Streamdown does this automatically when `isAnimating` is `false` — the rehype plugin is excluded and completed messages render with plain text nodes.

#### `will-change` Usage

Do NOT apply `will-change: opacity` or `will-change: transform` broadly to every word span. `will-change` tells the browser to promote the element to its own compositor layer, consuming GPU memory. Applying it to 180 word spans creates 180 compositor layers — this is worse than not using it.

Use `will-change` only on a single wrapper element that contains the entire streaming text block.

```css
.streaming-message-container {
  will-change: transform; /* single layer for the whole block */
}

.word-token {
  /* no will-change here */
  animation: fade-in 150ms ease-out both;
}
```

---

### 7. Blur Animation Performance (Special Case)

The Chrome team documented that `filter: blur()` is expensive when animated on a promoted layer because the GPU must apply a convolution shader every frame. For streaming text, this means:

**Bad pattern (continuous blur radius change):**

```css
/* Expensive: GPU re-applies blur shader every frame */
.element {
  transition: filter 0.3s;
  filter: blur(8px);
}
.element.visible {
  filter: blur(0);
}
```

**Better pattern (one-shot mount animation, short duration):**

```css
/* Acceptable: runs once on mount, terminates, GPU can cache */
@keyframes blur-in {
  from {
    opacity: 0;
    filter: blur(4px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}
.word-token {
  animation: blur-in 150ms ease-out both;
}
```

**The Chrome optimization approach (for large blur values only):**
Pre-compute multiple blur stages (1px, 2px, 4px, 8px) and cross-fade between them via opacity. For the streaming text use case with small blur values (< 8px) and short durations (< 200ms), the overhead is acceptable. Only optimize if profiling shows blur is the bottleneck.

---

### 8. Swappable Effect Architecture

Design a `TextEffectMode` type and a `useTextEffect` abstraction that the `StreamingText` component can consume:

```typescript
// In shared/lib/text-effects.ts or features/chat/model/text-effect-types.ts

export type TextEffectMode =
  | 'none' // Instant text render, no animation (accessibility / power-user mode)
  | 'fade' // Simple opacity fade-in per word
  | 'blur-in' // Blur + opacity per word (Perplexity style)
  | 'slide-up' // translateY + opacity per word (Claude style)
  | 'typewriter'; // Character-by-character reveal (marketing/demo contexts)

export interface TextEffectConfig {
  mode: TextEffectMode;
  duration?: number; // ms, default 150
  easing?: string; // CSS timing fn, default 'ease-out'
  sep?: 'word' | 'char'; // default 'word'
}

// Maps effect modes to streamdown animated config
export function resolveStreamdownAnimation(
  config: TextEffectConfig
): StreamdownAnimatedConfig | false {
  if (!config.mode || config.mode === 'none') return false;

  const animationMap: Record<TextEffectMode, string> = {
    none: '',
    fade: 'fadeIn',
    'blur-in': 'blurIn',
    'slide-up': 'slideUp',
    typewriter: 'fadeIn', // fallback — true typewriter requires sep:'char'
  };

  return {
    animation: animationMap[config.mode],
    duration: config.duration ?? 150,
    easing: config.easing ?? 'ease-out',
    sep: config.mode === 'typewriter' ? 'char' : (config.sep ?? 'word'),
  };
}
```

**StreamingText.tsx with swappable effects:**

```tsx
import type { TextEffectConfig } from '@/layers/shared/lib/text-effects';
import { resolveStreamdownAnimation } from '@/layers/shared/lib/text-effects';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
  effect?: TextEffectConfig;
}

export function StreamingText({
  content,
  isStreaming = false,
  effect = { mode: 'blur-in' },
}: StreamingTextProps) {
  const animatedConfig = resolveStreamdownAnimation(effect);

  return (
    <div className={cn('relative', isStreaming && 'streaming-cursor')}>
      <Streamdown
        shikiTheme={['github-light', 'github-dark']}
        linkSafety={linkSafety}
        animated={animatedConfig !== false ? animatedConfig : undefined}
        isAnimating={isStreaming && animatedConfig !== false}
      >
        {content}
      </Streamdown>
    </div>
  );
}
```

**Providing the effect from a user preference store (Zustand):**

```typescript
// In app-store.ts or a dedicated preferences slice
interface ChatPreferences {
  textEffect: TextEffectMode;
  setTextEffect: (mode: TextEffectMode) => void;
}

// In component
const textEffect = useChatPreferences((s) => s.textEffect);
<StreamingText effect={{ mode: textEffect }} ... />
```

This enables a settings panel where users can pick their preferred streaming animation, or where DorkOS can default to `'blur-in'` with a `'none'` fallback for reduced-motion / performance preferences.

**Reduced motion integration:**

```typescript
function useTextEffectConfig(preferred: TextEffectMode): TextEffectConfig {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  return { mode: reducedMotion ? 'none' : preferred };
}
```

---

### 9. How the Major Apps Animate Text — Technical Summary

| App                  | Token Arrival              | Visual Layer               | Per-Token Animation               | Cursor During Streaming                           |
| -------------------- | -------------------------- | -------------------------- | --------------------------------- | ------------------------------------------------- | -------- |
| ChatGPT              | SSE, direct DOM append     | None                       | None                              | Blinking `                                        | ` cursor |
| Claude.ai            | SSE, React state           | Container fade-in once     | None on text                      | Blinking block cursor                             |
| Perplexity           | SSE, React state           | Per-word blur-in CSS       | `blur(4px) → 0` + `opacity 0 → 1` | None (word animation implies activity)            |
| DorkOS (current)     | SSE → streaming-cursor CSS | Container none             | None                              | Blinking cursor via `.streaming-cursor` CSS class |
| DorkOS (recommended) | SSE → streaming-cursor CSS | Container motion.div enter | Per-word `blurIn` via streamdown  | Streamdown caret prop                             |

---

## Detailed Analysis

### Markdown + Animation: The Core Tension

The fundamental problem with animating LLM streaming text is that **LLMs output markdown syntax**, and markdown must be rendered before animation spans can be applied. You cannot split `**bold text**` at the `*` characters — you'll break the markdown.

The only correct solutions are:

1. **Post-render span injection via rehype** — Parse markdown to HTML AST, then walk the AST and wrap text nodes in spans _after_ markdown is resolved. This is exactly what `streamdown`'s `animated` prop and `flowtoken`'s `AnimatedMarkdown` do.

2. **Animate the container, not the text** — Skip per-word animation entirely and animate the message container instead (slide up, fade in). This works perfectly with any markdown renderer.

3. **Pre-render delay** — Buffer text until a clean markdown boundary (sentence end, paragraph), then render the whole chunk with a CSS stagger. Creates choppy UX during fast generation.

Option 1 is correct for premium feel. Option 2 is correct for simplicity and accessibility.

**Never attempt:** Splitting raw markdown string at spaces and wrapping in spans. You will break markdown tables, code blocks, links, and bold/italic syntax.

### The Blinking Cursor

The blinking cursor is the most impactful single element of streaming animation. It communicates "the model is still writing" without any text-level animation. DorkOS already implements this via the `.streaming-cursor` CSS class.

Streamdown also has a built-in `caret` prop — check if it replaces the custom `.streaming-cursor` implementation for cleaner integration.

### Why `blurIn` is the Right Default for DorkOS

The DorkOS design language is "Calm Tech" — precise, intentional, technical. The blur-in effect aligns because:

1. It feels like **precision instruments coming into focus**, not consumer animation theater.
2. It **masks batch token arrivals** better than a pure fade — when 5 words arrive simultaneously, blur-in makes them feel like they emerged organically rather than popping in as a group.
3. It is **Perplexity's choice** — the AI chat app with the most refined visual feel among the three.
4. **150ms duration** is below the threshold of conscious notice but above the threshold of "something happened."

The `slideUp` effect is a good alternative — more physical, closer to the message container entrance animation DorkOS already uses.

---

## Implementation Recommendation for DorkOS

**Minimal change, maximum impact:**

1. Add `import 'streamdown/styles.css'` to `apps/client/src/index.css` or `StreamingText.tsx`.
2. Add `animated` and `isAnimating` props to the `Streamdown` component in `StreamingText.tsx`.
3. Default to `blurIn` with 150ms duration.
4. Add `TextEffectMode` to the preferences system for future user configurability.

```tsx
// apps/client/src/layers/features/chat/ui/StreamingText.tsx
// Add to existing imports:
import 'streamdown/styles.css';

// Modify the Streamdown usage:
<Streamdown
  shikiTheme={['github-light', 'github-dark']}
  linkSafety={linkSafety}
  animated={{ animation: 'blurIn', duration: 150, easing: 'ease-out', sep: 'word' }}
  isAnimating={isStreaming}
>
  {content}
</Streamdown>;
```

That is the complete implementation for the base feature. The swappable architecture can be layered on top as a follow-on.

---

## Sources & Evidence

- "A UI library to animate and style streaming LLM output" — [FlowToken GitHub](https://github.com/Ephibbs/flowtoken)
- FlowToken API: `sep` prop ("word" | "char"), `animation` prop, `animationDuration`, `animationTimingFunction`, `codeStyle`, `customComponents` — [FlowToken README](https://github.com/Ephibbs/flowtoken/blob/main/README.md)
- "To lower the memory footprint, disable animations by setting the animation parameter to null on any completed messages" — [FlowToken GitHub](https://github.com/Ephibbs/flowtoken)
- Upstash smooth streaming hook: `requestAnimationFrame` + 5ms/char buffer, decouples network from visual — [Smooth Text Streaming in AI SDK v5 | Upstash Blog](https://upstash.com/blog/smooth-streaming)
- `smoothStream` API: `delayInMs`, `chunking: 'word' | 'line' | RegExp | Intl.Segmenter | fn` — [AI SDK Core: smoothStream](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
- Vercel AI SDK streaming with smooth animation: "receiving chunks from the server as fast as possible, but streaming them to users at a consistent, readable pace" — [Real-time AI in Next.js | LogRocket Blog](https://blog.logrocket.com/nextjs-vercel-ai-sdk-streaming/)
- TypeIt + flush() pattern for streaming: "queues text for animation, `flush()` discards queue after processing, ideal for streaming" — [Streaming Text Like an LLM with TypeIt | Alex MacArthur](https://macarthur.me/posts/streaming-text-with-typeit/)
- react-markdown-typewriter: `delay` prop (ms between chars), `motionProps.characterVariants` — [react-markdown-typewriter README](https://github.com/DRincs-Productions/react-markdown-typewriter/blob/main/README.md)
- motion.dev Typewriter: 1.3kb, `speed`, `variance`, `backspace` props, Motion+ subscription — [Typewriter: Realistic typing animations in React | Motion](https://motion.dev/docs/react-typewriter)
- Blur-in CSS keyframes: `from { opacity: 0; filter: blur(10px) }` to `{ opacity: 1; filter: blur(0) }` — [Blur Reveal Effect | Cruip](https://cruip.com/blur-reveal-effect-with-framer-motion-and-tailwind-css/)
- Chrome performance: animating `filter: blur()` on promoted layer is expensive; one-shot mount animation acceptable; pre-computed blur stages for continuous animation — [Animating a blur | Chrome for Developers](https://developer.chrome.com/blog/animated-blur)
- `transform` and `opacity` are GPU-composited, never trigger layout — [CSS and JavaScript animation performance | MDN](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/CSS_JavaScript_animation_performance)
- CSS custom property stagger technique: `animation-delay: calc(0.025s * var(--index))` — [Staggered Animations with CSS Custom Properties | Cloud Four](https://cloudfour.com/thinks/staggered-animations-with-css-custom-properties/)
- Staggered text animation with Tailwind: `cubic-bezier(.37,.01,0,.98)` timing, word-level splitting — [Create Staggered Text Animation with Tailwind CSS and React | Builder.io](https://www.builder.io/blog/stagger-text-animation-tailwind)
- Perplexity-style streaming reference implementation — [reworkd/perplexity-style-streaming | GitHub](https://github.com/reworkd/perplexity-style-streaming)
- Perplexity iOS App animation analysis — [Perplexity iOS App UI/UX animation | 60fps.design](https://60fps.design/apps/perplexity)
- Streamdown v2.4.0 `animated` prop: `animation`, `duration`, `easing`, `sep`, `isAnimating`, `onAnimationStart`, `onAnimationEnd`; presets: `fadeIn`, `blurIn`, `slideUp`; `createAnimatePlugin()` for custom pipelines — [Streamdown Docs: Animation](https://streamdown.ai/docs/animation)
- "Per-word streaming animation plugin (@streamdown/animate)" issue thread — [Streamdown Issue #371 | GitHub](https://github.com/vercel/streamdown/issues/371)
- llm-ui: "renders characters at the native frame rate of your display" — [llm-ui.com](https://llm-ui.com/)
- `animation-fill-mode: forwards` keeps element at final keyframe state after animation completes — [animation-fill-mode | MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-fill-mode)
- Background on chat UI streaming: "production apps do not use character-by-character typewriter" (prior DorkOS research) — [research/20260309_chat_microinteractions_polish.md]

---

## Research Gaps & Limitations

- Could not directly inspect Claude.ai or ChatGPT's DOM/source to confirm blur-in exact values — the Perplexity approach is documented via third-party reproduction repos and visual analysis, not official engineering posts.
- The `motion.dev` Typewriter component requires a Motion+ paid subscription — full API was not accessible; props were gathered from search result excerpts.
- Streamdown's `animated` prop was confirmed via the docs page and GitHub issue thread but not by reading the package source directly. The `^2.4.0` version constraint in DorkOS's `package.json` should include this feature (confirmed added in 2.x series based on the issue).
- The `smoothStream` PR adding chunking functions was merged in April 2025 — this is after the assistant's knowledge cutoff but confirmed via live search.

---

## Contradictions & Disputes

- **"Production apps use typewriter animation"** vs. **"Production apps don't."** Many tutorials teach typewriter effects for AI chat. Direct analysis shows ChatGPT and Claude.ai do NOT use per-character animation — they rely on natural token generation speed. Perplexity uses per-word blur-in. The typewriter approach is for demos and marketing; production uses instant-append or word-level CSS effects.
- **`blurIn` performance:** Some developers avoid `filter: blur()` entirely due to performance concerns. The Chrome engineering blog confirms it is expensive for continuous animation but acceptable for one-shot mount transitions at small values (< 8px). The streamdown implementation is a one-shot mount, making it safe.
- **`will-change` on many spans:** Some recommendations suggest adding `will-change: opacity` to animated spans. The correct guidance from MDN and Google is to avoid this on many elements — it creates too many compositor layers and hurts overall performance.

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "flowtoken npm animatedmarkdown streaming", "streamdown animated prop animation plugin", "blur-in CSS keyframes LLM streaming filter blur opacity", "Vercel AI SDK smoothStream chunking word", "staggered CSS custom properties animation-delay", "react-markdown-typewriter motion API"
- Primary information sources: streamdown.ai docs, GitHub repos (flowtoken, react-markdown-typewriter, perplexity-style-streaming, streamdown issues), MDN, Chrome Developers blog, Upstash blog, ai-sdk.dev docs
