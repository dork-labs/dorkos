/**
 * "Want a nudge when this needs you?" — the one time DorkOS asks about browser
 * notifications.
 *
 * @module features/notifications/ui/PermissionPrimer
 */
import { Bell } from 'lucide-react';
import { Button, Card } from '@/layers/shared/ui';

/** The two answers the card offers. */
export interface PermissionPrimerProps {
  /** Ask the browser for permission. */
  onAllow: () => void;
  /** Decline for good. */
  onNotNow: () => void;
}

/**
 * The contextual permission card — appearance only.
 *
 * WHETHER to draw it is {@link usePermissionPrimer}'s answer, not this
 * component's: the session's promotional cards arbitrate through a `BottomSlot`,
 * which needs to know who qualifies before it renders anybody. Drawing this
 * without asking that hook first shows the card to somebody who already answered
 * it.
 *
 * @param props - The two answers.
 */
export function PermissionPrimer({ onAllow, onNotNow }: PermissionPrimerProps) {
  return (
    <Card
      data-slot="notification-permission-primer"
      gap="none"
      // No outer margin: BottomSlot owns the spacing around whichever card wins
      // the slot (DOR-1759), so a card carrying its own would double it.
      className="flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    >
      <Bell className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        Want a nudge when this needs you? DorkOS can show a notification while you are looking at
        something else.
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          responsive={false}
          className="h-7 px-2 text-xs"
          onClick={onNotNow}
        >
          Not now
        </Button>
        <Button
          variant="outline"
          size="sm"
          responsive={false}
          className="h-7 px-2 text-xs"
          onClick={onAllow}
        >
          Turn on notifications
        </Button>
      </div>
    </Card>
  );
}
