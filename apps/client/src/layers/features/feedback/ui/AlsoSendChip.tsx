import { Check, Eye } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface AlsoSendChipProps {
  /** What the chip adds to the report ("Diagnostics"). */
  label: string;
  /** What that is, in one plain sentence, for the tooltip. */
  summary: string;
  /** Whether it will be sent. */
  pressed: boolean;
  /** Turn it on or off. */
  onPressedChange: (pressed: boolean) => void;
  /** Open the full preview of exactly what would be sent. */
  onPreview: () => void;
}

/**
 * One "Also send" choice under the feedback message box: a pill that is a real
 * toggle (`aria-pressed`), with an eye button beside it that opens the preview of
 * exactly what it would send. Small on purpose; the message is the form, and
 * these are the extras a person can check and switch off.
 *
 * On shows a check and off shows nothing, so the state reads without colour.
 * On a phone the eye grows to a 44px target, and both focus rings sit inside
 * the pill rather than spilling over its border.
 */
export function AlsoSendChip({
  label,
  summary,
  pressed,
  onPressedChange,
  onPreview,
}: AlsoSendChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border text-xs transition-colors duration-150',
        pressed ? 'bg-muted/60 text-foreground' : 'text-muted-foreground'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={pressed}
            onClick={() => onPressedChange(!pressed)}
            className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded-full py-1 pr-1.5 pl-2.5 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
          >
            {pressed && <Check className="size-3" aria-hidden />}
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{summary}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${label.toLowerCase()}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center justify-center rounded-full py-1 pr-2.5 pl-1 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset max-sm:min-h-11 max-sm:min-w-11 max-sm:px-0"
      >
        <Eye className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}
