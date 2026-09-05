/**
 * How one `@mention` reads inline, in message text and everywhere else a
 * resolved reference to a room member is drawn.
 *
 * @module shared/ui/mention-pill
 */
import type * as React from 'react';
import { cva } from 'class-variance-authority';
import { Bot, Send } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import type { IdentityOrigin } from '@/layers/shared/lib/identity-origin';

/**
 * How much of an agent's own colour tints the pill's text, mixed toward the
 * theme's own foreground token rather than toward transparent. Mixing
 * against `hsl(var(--foreground))` — which the browser resolves at paint
 * time — is what makes this adapt to dark mode for free: the same mix lands
 * as a darkened shade of the colour in light mode and a lightened tint of it
 * in dark mode, without reading the theme in script. The `hsl()` wrapper is
 * load-bearing: this app's theme tokens store a bare `H S% L%` triple (e.g.
 * `0 0% 9%`), which is not a valid `<color>` on its own — `color-mix()` with
 * an unwrapped triple is invalid CSS and the whole declaration is silently
 * dropped, not just the offending channel.
 */
const AGENT_TEXT_MIX = '65%';

const mentionPillVariants = cva(
  // Deliberately `inline`, not `inline-flex`/`inline-block`: only a plain
  // inline box fragments across a line wrap, which is what lets
  // `overflow-wrap:anywhere` break a long single-token handle mid-word while
  // `box-decoration-break:clone` redraws the pill's padding and background on
  // each resulting line. An atomic box would just overflow instead.
  'inline rounded-md px-1.5 py-0.5 font-medium [-webkit-box-decoration-break:clone] [box-decoration-break:clone] [overflow-wrap:anywhere]',
  {
    variants: {
      /**
       * `neutral` is a static theme-token pill (human, system); `agent` wears
       * its identity's own colour at **14%** — lighter than
       * {@link IdentityAvatar}'s 18% tint, because a pill's background sits
       * directly behind body text rather than behind a large, mostly-empty
       * disc.
       *
       * The colour arrives through `--identity-color`, which the pill publishes
       * inline, rather than through an inline `background-color`. That is what
       * makes the hover step below possible at all: an inline background beats
       * every stylesheet rule, so no `:hover` could ever have moved it.
       */
      tone: {
        neutral: 'bg-secondary text-secondary-foreground',
        agent: 'bg-[color-mix(in_oklch,var(--identity-color)_14%,transparent)]',
      },
      interactive: {
        true: 'focus-visible:ring-ring cursor-pointer transition-[background-color] duration-(--identity-answer) ease-(--identity-ease-standard) focus-visible:ring-2 focus-visible:outline-none',
        false: '',
      },
    },
    /**
     * Chip tier: the tint steps ONE notch and nothing else — no ring, no glow,
     * no lift. A pill mid-paragraph that glowed would pull the eye out of the
     * sentence; 14% → 20% is just enough to confirm "yes, this is the thing you
     * are pointing at" without breaking the line.
     *
     * It replaces a `brightness-95` filter, which multiplied a considered
     * identity colour toward grey — the opposite of the identity answering.
     * The neutral pill has no identity colour to raise, so it steps its own
     * surface toward the text instead: `--secondary` is lighter than the
     * foreground in light mode and darker in dark mode, so one mix reads as a
     * step up in both without asking the theme any questions.
     */
    compoundVariants: [
      {
        tone: 'agent',
        interactive: true,
        class: 'hover:bg-[color-mix(in_oklch,var(--identity-color)_20%,transparent)]',
      },
      {
        tone: 'neutral',
        interactive: true,
        class: 'hover:bg-[color-mix(in_oklch,hsl(var(--secondary)),hsl(var(--foreground))_10%)]',
      },
    ],
    defaultVariants: {
      tone: 'neutral',
      interactive: false,
    },
  }
);

export interface MentionPillProps extends Omit<React.ComponentProps<'span'>, 'color'> {
  /** What kind of identity this mention resolved to. */
  kind: 'human' | 'agent' | 'system';
  /** Display name shown inside the pill. */
  label: string;
  /**
   * The `@handle` this mention was typed as. Not always shown in the pill
   * itself, but carried into the `title` so hovering (or a screen reader
   * reading the title) can recover it even when `label` is a display name.
   */
  handle?: string;
  /** Identity colour for an agent mention. Ignored for `human`/`system`. */
  color?: string;
  /**
   * Where a human participant is posting from. `'local'` (or omitted) draws
   * the plain neutral pill; `{ platform }` adds a small platform glyph after
   * the name. Meaningless for `kind !== 'human'`.
   */
  origin?: IdentityOrigin;
  /**
   * Whether this mention resolved to a real member of the room. `false`
   * renders plain, inert text — no pill, no pointer — regardless of `kind`,
   * because a pointer cursor on unresolved text promises a click that does
   * nothing.
   */
  resolved: boolean;
  /**
   * Whether this pill carries a hover/click affordance — the cursor, the hover
   * tint step and the focus ring.
   *
   * **Appearance only; the behaviour is the caller's.** This pill stays a
   * `<span>`, so a caller that turns this on also passes what makes it real —
   * `onClick`, `role="button"` and `tabIndex`, which reach the span through the
   * prop spread (`MentionPillRenderer` is the live example). Turning it on
   * alone paints a control that does nothing, which is the one thing the
   * unresolved branch above exists to avoid.
   */
  interactive?: boolean;
}

/**
 * A resolved `@mention`, styled by who it points at.
 *
 * Three looks, chosen once and never inferred from `color` alone: an agent
 * wears its own identity colour with a Bot glyph standing in for the `@`; a
 * local person is a neutral `@name` pill; an external (bridged) person is
 * the same neutral pill with a small platform glyph after the name. A
 * `system` mention (the room's own voice — never DorkBot, which posts as an
 * agent) gets the neutral pill with no `@`, since it does not name a person
 * with a handle.
 *
 * Unresolved mentions bypass all of that: `resolved={false}` returns plain
 * text, no matter what `kind` says, because a mention nobody could match to
 * a member is not a fact this pill can vouch for.
 */
function MentionPill({
  kind,
  label,
  handle,
  color,
  origin,
  resolved,
  interactive,
  className,
  ...props
}: MentionPillProps) {
  if (!resolved) {
    return (
      <span
        data-slot="mention-pill"
        data-resolved="false"
        className={cn('text-muted-foreground', className)}
        {...props}
      >
        @{label}
      </span>
    );
  }

  const title = handle ? `@${handle}` : label;

  if (kind === 'agent') {
    return (
      <span
        data-slot="mention-pill"
        data-kind="agent"
        title={title}
        className={cn(mentionPillVariants({ tone: 'agent', interactive }), className)}
        style={
          {
            // Published, not painted: the background lives in a class that
            // reads this (see the `tone` variant), so a `:hover` rule can step
            // it. The text colour stays inline because it does not move.
            '--identity-color': color ?? 'currentColor',
            color: `color-mix(in oklch, ${color ?? 'currentColor'} ${AGENT_TEXT_MIX}, hsl(var(--foreground)))`,
          } as React.CSSProperties
        }
        {...props}
      >
        <Bot aria-hidden className="mr-0.5 inline-block size-[0.85em] align-[-0.15em]" />
        {label}
      </span>
    );
  }

  if (kind === 'system') {
    return (
      <span
        data-slot="mention-pill"
        data-kind="system"
        className={cn(mentionPillVariants({ tone: 'neutral', interactive }), className)}
        {...props}
      >
        {label}
      </span>
    );
  }

  const isExternal = typeof origin === 'object' && origin !== null;

  return (
    <span
      data-slot="mention-pill"
      data-kind="human"
      title={title}
      className={cn(mentionPillVariants({ tone: 'neutral', interactive }), className)}
      {...props}
    >
      @{label}
      {isExternal && (
        <Send
          aria-hidden
          className="ml-0.5 inline-block size-[0.72em] align-[-0.05em] opacity-70"
        />
      )}
    </span>
  );
}

export { MentionPill, mentionPillVariants };
