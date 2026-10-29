/**
 * The small outlined icon button an Inbox decision row answers with.
 *
 * @module features/inbox/ui/IconAction
 */
import type { Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** One 26px outlined icon button with its name as a tooltip. */
export function IconAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  expanded,
  controls,
  buttonRef,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          responsive={false}
          ref={buttonRef}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          disabled={disabled}
          onClick={onClick}
          className={cn('size-[26px]', expanded && 'bg-accent text-accent-foreground')}
        >
          <Icon aria-hidden className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
