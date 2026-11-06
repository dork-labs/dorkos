import { useSyncExternalStore } from 'react';
import { getActionStepUpShowing, subscribeActionStepUp } from '@/layers/shared/lib';

/**
 * Whether a change in flight is waiting on "Confirm it's you". Only the server decides that a
 * change is held, so this reads the sheet rather than guessing from what was pressed.
 *
 * @param pending - Whether this control's own change is in flight.
 */
export function useConfirmWaiting(pending: boolean): boolean {
  const showing = useSyncExternalStore(subscribeActionStepUp, getActionStepUpShowing);
  return pending && showing !== null;
}
