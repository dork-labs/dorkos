import { ChevronDown, CornerUpRight, Plus } from 'lucide-react';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
} from '@/layers/shared/ui';

interface DispositionMenuProps {
  /**
   * Send the message into the running task now (steer). Present ONLY when the
   * agent can take a message mid-task — the caret and its Steer row are absent,
   * never greyed, when it cannot. A hidden choice is honest; a dead one makes
   * the person wonder what they did wrong.
   */
  onSteer?: () => void;
  /**
   * Add the message as context the agent uses next, without cutting into the
   * running task (stage). Present ONLY when the agent can take added context.
   */
  onStage?: () => void;
}

/**
 * The extra ways to send a message while the agent is working, tucked beside the
 * Queue button.
 *
 * Queue is the primary action and stands on its own; Steer and Add context are
 * the alternates, one tap away behind this caret. Each row appears only when the
 * agent supports it, so a runtime that can only queue shows no caret at all and
 * the composer collapses back to a single Queue button. That is the whole of the
 * "hidden, not disabled" rule for these two verbs: the presence of the callback
 * IS the capability, exactly as the rest of the composer treats attach and
 * mentions.
 *
 * Renders nothing when neither alternate is available, so a host may pass it
 * unconditionally.
 */
export function DispositionMenu({ onSteer, onStage }: DispositionMenuProps) {
  if (!onSteer && !onStage) return null;

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-ring bg-muted text-muted-foreground hover:bg-muted/80 shrink-0 rounded-lg p-1.5 transition-colors max-md:p-2"
          aria-label="More ways to send"
        >
          <ChevronDown className="size-(--size-icon-sm)" />
        </button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent align="end">
        {onSteer && (
          <ResponsiveDropdownMenuItem
            icon={CornerUpRight}
            description="Send it into the task now"
            onSelect={onSteer}
          >
            Steer
          </ResponsiveDropdownMenuItem>
        )}
        {onStage && (
          <ResponsiveDropdownMenuItem
            icon={Plus}
            description="Add it for later, without cutting in"
            onSelect={onStage}
          >
            Add context
          </ResponsiveDropdownMenuItem>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
