import { ClipboardList } from 'lucide-react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { STATUS_ITEM_TRIGGER_CLASS } from '../lib/status-item-classes';

export interface PlanModeItemProps {
  /** The way of working this runtime offers, as it declared it. */
  descriptor: PermissionModeDescriptor;
  /** Whether the session is in it right now. */
  active: boolean;
  /** Switch it on or off. */
  onToggle: (next: boolean) => void;
  /** When true, the chip is disabled and says why. */
  disabled?: boolean;
}

/**
 * Plan, as a switch beside the composer rather than a stop on the Trust Dial.
 *
 * Planning is not a level of trust — it is a way of working you turn on for a
 * stretch and off again when the plan is agreed (spec `trust-dial`, decision 1).
 * Sitting it on the dial made "how much may this agent do?" and "what should it
 * do next?" look like the same question, and made Plan compete for a stop with
 * the setting a person actually wanted to keep.
 *
 * Rendered only where the runtime declares such a mode, so a Codex session
 * simply has no chip. Switching it off is handled by the caller, which restores
 * the stop the session was at.
 *
 * @param props - The declared mode, whether it is on, and the toggle.
 */
export function PlanModeItem({ descriptor, active, onToggle, disabled }: PlanModeItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          disabled={disabled}
          onClick={() => onToggle(!active)}
          className={cn(
            STATUS_ITEM_TRIGGER_CLASS,
            'items-center gap-1',
            'disabled:cursor-not-allowed disabled:opacity-40',
            active && 'text-foreground'
          )}
        >
          <ClipboardList className="size-(--size-icon-xs) shrink-0" aria-hidden />
          <span className="truncate">{descriptor.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {disabled ? 'Send a message first' : descriptor.promise}
      </TooltipContent>
    </Tooltip>
  );
}
