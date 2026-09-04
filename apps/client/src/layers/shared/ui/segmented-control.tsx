import * as React from 'react';
import { LayoutGroup, motion } from 'motion/react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

/**
 * The thumb's travel — the same spring the nav pill and the session row use.
 *
 * A smooth, deliberate slide rather than the snappier button preset: the thumb
 * is the widest thing that moves in a settings row, and 500-stiffness on that
 * distance reads as a flick.
 */
const THUMB_SPRING = { type: 'spring', stiffness: 280, damping: 32 } as const;

/**
 * The shared layout id inside one control.
 *
 * Namespaced per instance by the `LayoutGroup id` below rather than being
 * unique itself, so two controls on screen at once cannot hand the thumb back
 * and forth between them.
 */
const THUMB_LAYOUT_ID = 'segmented-control-thumb';

/**
 * Which segment is checked, published to the segments.
 *
 * The thumb has to know, and Radix's radio group keeps its own resolved value
 * to itself — a segment can read `data-state` from the DOM but not from React.
 */
const SegmentedControlContext = React.createContext<{ value: string | undefined } | null>(null);

/**
 * A row of two or more mutually exclusive choices, all visible at once.
 *
 * Built on Radix's radio group rather than hand-rolled, so it arrives with the
 * keyboard behaviour a person is entitled to expect: one Tab stop for the whole
 * row, arrow keys moving (and selecting) between segments, `role="radiogroup"`
 * and `aria-checked` without anyone remembering to write them.
 *
 * Use it when the options are few, short, and worth reading side by side — the
 * Trust Dial's three stops are the reference case. A list that has to scroll, or
 * options whose labels are sentences, wants a menu instead.
 *
 * **Arrow keys stop at the ends.** Radix wraps by default, and because a radio
 * group selects as focus moves, wrapping means one ArrowLeft on the first
 * segment silently commits the last one. On a control whose ends are "safest"
 * and "most dangerous" — which is what a segmented control usually is — that is
 * a keypress nobody meant to make. Pass `loop` explicitly to opt back in.
 *
 * **The raised segment travels.** One thumb slides between the stops rather
 * than blinking off one and on at the next, which is what makes a spectrum —
 * the Trust Dial's three stops most of all — read as a spectrum. Same
 * `layoutId` grammar the One Bar's tab strip and the sidebar's active row use,
 * so the app has one answer to "how does a selection move" instead of three.
 *
 * @param props - Radix radio-group props; `value`, `onValueChange`, `disabled`.
 */
function SegmentedControl({
  className,
  loop = false,
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  // Radix owns the selection; this mirrors it so the thumb knows where to sit.
  // Uncontrolled use stays supported — `value` still wins whenever it is given,
  // exactly as Radix resolves it, so no caller has to change.
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const checked = value ?? uncontrolled;
  const groupId = React.useId();
  const context = React.useMemo(() => ({ value: checked }), [checked]);

  return (
    <SegmentedControlContext.Provider value={context}>
      <LayoutGroup id={groupId}>
        <RadioGroupPrimitive.Root
          data-slot="segmented-control"
          orientation="horizontal"
          loop={loop}
          value={value}
          defaultValue={defaultValue}
          onValueChange={(next) => {
            setUncontrolled(next);
            onValueChange?.(next);
          }}
          className={cn(
            'bg-muted border-border flex w-full items-stretch gap-0.5 rounded-lg border p-0.5',
            'data-[disabled]:opacity-50',
            className
          )}
          {...props}
        />
      </LayoutGroup>
    </SegmentedControlContext.Provider>
  );
}

/**
 * One segment. Renders its own children — an icon, a word, a second line — so the
 * primitive stays a shape and the meaning stays with the caller.
 *
 * The selected segment lifts: it takes the page's own background and a soft
 * shadow, which is what makes a flat row read as a switch. That raised surface
 * is one element shared by the whole row, so picking a new stop slides it there
 * instead of redrawing it. Under reduced motion the slide goes and the thumb
 * simply appears in its new place — the fact survives, the travel does not.
 *
 * @param props - Radix radio-item props; `value` identifies the segment.
 */
function SegmentedControlItem({
  className,
  children,
  value,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  const row = React.useContext(SegmentedControlContext);
  const isChecked = row != null && row.value === value;

  return (
    <RadioGroupPrimitive.Item
      data-slot="segmented-control-item"
      value={value}
      className={cn(
        // `flex-auto`, not `flex-1`: segments start at their content width and share
        // what is left, so a long word like "Full autonomy" is not squeezed into an
        // ellipsis by two short ones. The stop words are the control.
        'text-muted-foreground relative flex min-w-0 flex-auto cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-xs',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        // The raised surface belongs to the thumb below now, which is why this
        // only transitions colour. But `data-[state=checked]:bg-background` and
        // its shadow stay as the FLOOR, not decoration: Radix owns `data-state`
        // regardless of whether an item sits inside `SegmentedControlContext`,
        // while the thumb below reads a context value that mirrors it. A
        // `SegmentedControlItem` rendered outside a `SegmentedControl` — legal
        // by the type system, exported from the barrel — would have no context
        // and so no thumb, but Radix would still mark it checked; without this
        // floor that segment would show no selection at all.
        'motion-safe:transition-[color] motion-safe:duration-150 motion-safe:ease-out',
        'hover:text-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-soft',
        'disabled:pointer-events-none disabled:cursor-not-allowed',
        className
      )}
      {...props}
    >
      {isChecked && (
        <motion.span
          aria-hidden
          data-slot="segmented-control-thumb"
          layoutId={THUMB_LAYOUT_ID}
          className="bg-background shadow-soft absolute inset-0 rounded-md"
          transition={THUMB_SPRING}
        />
      )}
      {/* Above the thumb, which is painted across the whole segment. */}
      <span className="relative z-10 flex min-w-0 items-center justify-center gap-1.5">
        {children}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

export { SegmentedControl, SegmentedControlItem };
