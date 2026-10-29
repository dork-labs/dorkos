import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useWithheldExtensions } from '../model/use-withheld-extensions';

/** Props for {@link WithheldExtensionsNotice}. */
export interface WithheldExtensionsNoticeProps {
  /** The manifest contribution key of the slot this sits in, e.g. `right-panel`. */
  slot: string;
  /** Open the approval card, where a person can review the change. */
  onReview: () => void;
  className?: string;
}

/**
 * One muted amber line per mini app held back in this slot because its code
 * changed (DOR-3068), with a quiet Review that opens its approval card. Not
 * an error: the app is fine, it is waiting for a yes. Draws nothing when no
 * app in this slot is waiting.
 */
export function WithheldExtensionsNotice({
  slot,
  onReview,
  className,
}: WithheldExtensionsNoticeProps) {
  const withheld = useWithheldExtensions(slot);
  if (withheld.length === 0) return null;
  return (
    <ul className={cn('space-y-1', className)} aria-label="Mini apps waiting for your OK">
      {withheld.map((ext) => (
        <li
          key={ext.id}
          data-testid={`withheld-extension-${ext.id}`}
          className="bg-status-warning-bg text-status-warning-fg flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 truncate">{ext.name} changed and is waiting for your OK</span>
          <Button
            variant="ghost"
            size="xs"
            // 44px to hit on a touch screen, same size to look at.
            className="text-status-warning-fg shrink-0 pointer-coarse:min-h-11"
            onClick={onReview}
          >
            Review
          </Button>
        </li>
      ))}
    </ul>
  );
}
