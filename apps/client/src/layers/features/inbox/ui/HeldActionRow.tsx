/**
 * A held connected-app action's waiting row, with Cancel (spec
 * `trusted-by-default-flip` §5.6).
 *
 * @module features/inbox/ui/HeldActionRow
 */
import { useEffect, useRef, useState } from 'react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import type { AgentVisualSource } from '@/layers/entities/agent';
import { holdTimeLeft } from '../lib/held-actions';
import { InboxRow } from './InboxRow';

/** Props for {@link HeldActionRow}. */
export interface HeldActionRowProps {
  /** The waiting row: `connector.destructive_pending` with a Cancel action. */
  notification: NotificationDTO;
  /** Whether a later row already says how this hold ended. */
  ended: boolean;
  /** The agent that asked, when the caller resolved it. */
  agent?: AgentVisualSource | null;
  /**
   * Whether a link asked for this hold (`?inbox=<holdId>`, from its phone push
   * or desktop banner): Cancel takes focus and the row a ring.
   */
  focused?: boolean;
  /** Where the row sits in its list, for the entrance stagger. */
  index?: number;
}

/** What pressing Cancel came to. */
type CancelState = 'idle' | 'cancelling' | 'cancelled' | 'too-late' | 'failed';

/** The short status line each finished press leaves beside the row. */
const STATUS: Partial<Record<CancelState, string>> = {
  cancelled: 'Cancelled',
  'too-late': 'Too late to cancel',
  failed: 'Couldn’t cancel. Try again.',
};

/**
 * The ordinary Inbox row, plus Cancel while the action is still waiting.
 *
 * Cancel shows only inside the 60-second window and only until a later row
 * says the hold ended; the button goes away by itself when the window closes.
 * A hold is not an undo, so there is no Cancel once it ran. The row itself
 * is text, not a link: this is the place its alerts open, and Cancel is the
 * one thing to do here.
 *
 * @param props - The row, whether its hold ended, and whether a link asked for it.
 */
export function HeldActionRow({ notification, ended, agent, focused, index }: HeldActionRowProps) {
  const transport = useTransport();
  const [state, setState] = useState<CancelState>('idle');
  const [firstSeen] = useState(() => Date.now());
  const [open, setOpen] = useState(() => holdTimeLeft(notification, firstSeen, Date.now()) > 0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const left = holdTimeLeft(notification, firstSeen, Date.now());
    const timer = setTimeout(() => setOpen(false), left);
    return () => clearTimeout(timer);
  }, [open, notification, firstSeen]);

  // A link asked for this hold: put the one control here under the finger.
  useEffect(() => {
    if (focused) cancelRef.current?.focus({ preventScroll: false });
  }, [focused]);

  const cancel = async () => {
    setState('cancelling');
    try {
      await transport.cancelHeldConnectorAction(notification.subject.id);
      setState('cancelled');
    } catch (err) {
      const status = (err as { status?: number }).status;
      setState(status === 404 ? 'too-late' : 'failed');
    }
  };

  const status = STATUS[state];
  const showCancel = open && !ended && state !== 'cancelled' && state !== 'too-late';

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md',
        focused && 'ring-ring ring-2 ring-offset-1'
      )}
      data-slot="held-action-row"
      data-focused={focused ? 'true' : undefined}
    >
      <div className="min-w-0 flex-1">
        <InboxRow notification={notification} agent={agent} index={index} />
      </div>
      {showCancel && (
        <Button
          ref={cancelRef}
          variant="ghost"
          size="sm"
          className="text-status-error h-7 shrink-0 px-2 text-xs"
          disabled={state === 'cancelling'}
          onClick={() => void cancel()}
        >
          Cancel
        </Button>
      )}
      <span role="status" aria-live="polite" className="text-muted-foreground shrink-0 text-xs">
        {status}
      </span>
    </div>
  );
}
