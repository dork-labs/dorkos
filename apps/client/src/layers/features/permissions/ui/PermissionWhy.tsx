import type { PermissionLastChange } from '@dorkos/shared/permissions';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { lastChangeWhy } from '../lib/permission-why';

/** Props for {@link PermissionWhy}. */
export interface PermissionWhyProps {
  /**
   * The question, naming the setting and its state, e.g. "Why is Rooms set
   * to Allowed?". It is the trigger's accessible name and the panel's title, so
   * two "Why?" links on one screen never share a name.
   */
  question: string;
  /** Where the state comes from, from `stateWhy` or `filesWhy`. */
  sentence: string;
  /** The last change to the setting behind it, when one is on record. */
  lastChange?: PermissionLastChange;
  /** Extra classes for the trigger. */
  className?: string;
}

/**
 * "Why?" beside a permission state (spec `agent-permissions`, task 4.2): tap
 * or click it for where the state comes from and who last changed it, when,
 * and where. A popover on a wide screen, a bottom sheet on a phone.
 *
 * Opened on a click or tap rather than on hover. A hover panel on a settings
 * row opens while the pointer travels to the switch beside it, and a phone has
 * no hover at all; one gesture that works everywhere, from the keyboard too.
 *
 * @param props - See {@link PermissionWhyProps}.
 */
export function PermissionWhy({ question, sentence, lastChange, className }: PermissionWhyProps) {
  const change = lastChangeWhy(lastChange);
  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          aria-label={question}
          className={cn(
            // Inline, so the vertical padding widens the tap target on a
            // phone without moving the line it sits in.
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline rounded-sm py-2 text-xs underline decoration-dotted underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none md:py-0',
            className
          )}
        >
          Why?
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-72 space-y-1.5" align="start">
        <ResponsivePopoverTitle className="text-sm font-medium">{question}</ResponsivePopoverTitle>
        <p className="text-sm" data-testid="permission-why-source">
          {sentence}
        </p>
        {change ? (
          <p className="text-muted-foreground text-xs" data-testid="permission-why-change">
            {change}
          </p>
        ) : null}
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
