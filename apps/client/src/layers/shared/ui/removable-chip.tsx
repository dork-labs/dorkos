/**
 * A pill you can dismiss: an active filter, a chosen option, a tag.
 *
 * The filter bar already drew this, but its chip was welded to
 * `FilterBarContext`, so the tasks panel — whose agent filter is not wired to
 * that context — drew the same pill again a few pixels differently (DOR-1763
 * finding 17.12). This is the presentational half, with no context to join.
 *
 * @module shared/ui/removable-chip
 */
import type { ReactNode } from 'react';
import { X as XIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';

/** Marks the element that holds a row of removable chips. */
export const CHIP_GROUP_ATTR = 'data-chip-group';

/**
 * Marks the control focus lands on when the last chip goes: the group's "add"
 * button. Looked for in the group, then in each ancestor outward, so a filter
 * bar's "Filter" trigger beside the chip row still catches it.
 */
export const CHIP_GROUP_ADD_ATTR = 'data-chip-group-add';

const REMOVE_SELECTOR = '[data-slot="removable-chip-remove"]';

/**
 * Where focus goes when this chip's × is pressed: the next chip, else the
 * previous one, else the group's add control. Never `<body>`, which is where a
 * removed button leaves it on its own.
 *
 * @param button - The × being pressed.
 */
function focusTargetAfterRemoving(button: HTMLElement): HTMLElement | null {
  const group = button.closest(`[${CHIP_GROUP_ATTR}]`) ?? button.parentElement?.parentElement;
  if (!group) return null;
  const all = Array.from(group.querySelectorAll<HTMLElement>(REMOVE_SELECTOR));
  const at = all.indexOf(button);
  const sibling = all[at + 1] ?? all[at - 1];
  if (sibling) return sibling;
  for (let node: Element | null = group; node; node = node.parentElement) {
    const add = node.querySelector<HTMLElement>(`[${CHIP_GROUP_ADD_ATTR}]`);
    if (add) return add;
  }
  return null;
}

/** Everything a removable chip renders. */
export interface RemovableChipProps {
  /** What the chip says. */
  children: ReactNode;
  /** Drop it. */
  onRemove: () => void;
  /**
   * What the dismiss button announces, e.g. `Remove agent filter`. Screen
   * readers hear only this, so name the thing being removed — not "Remove".
   */
  removeLabel: string;
  className?: string;
}

/**
 * A pill with an × on the end.
 *
 * The body is inert text on the chip tint; only the × is a button, and it is a
 * full 24px target on a desktop and 44 under a thumb. Put the chips in an
 * element carrying {@link CHIP_GROUP_ATTR} so removing one moves focus to its
 * neighbour. Nothing animates out: the chip is gone, and focus says where you
 * are now.
 *
 * @param children - What the chip says.
 * @param onRemove - Drop it.
 * @param removeLabel - What the dismiss button announces.
 */
function RemovableChip({ children, onRemove, removeLabel, className }: RemovableChipProps) {
  return (
    <span
      data-slot="removable-chip"
      className={cn(
        'bg-foreground/7 text-muted-foreground inline-flex h-6 max-w-64 shrink-0 items-center rounded-full pl-2.5 text-xs font-medium whitespace-nowrap max-md:h-10 max-md:pl-3',
        className
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <button
        type="button"
        data-slot="removable-chip-remove"
        aria-label={removeLabel}
        onClick={(event) => {
          const next = focusTargetAfterRemoving(event.currentTarget);
          onRemove();
          // After React has dropped this chip, so the target is the one left.
          requestAnimationFrame(() => {
            if (next?.isConnected) next.focus();
          });
        }}
        className="focus-ring text-muted-foreground hover:bg-foreground/11 hover:text-foreground relative inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-[color,background-color] duration-150 ease-out max-md:h-10 max-md:w-11 max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-0.5 max-md:after:content-['']"
      >
        <XIcon aria-hidden className="size-(--size-icon-xs)" />
      </button>
    </span>
  );
}

export { RemovableChip };
