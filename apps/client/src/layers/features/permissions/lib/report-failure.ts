/**
 * How a permission write that did not land is reported.
 *
 * @module features/permissions/lib/report-failure
 */
import { toast } from 'sonner';
import { awayFromTheComputerSentence } from '@/layers/shared/lib';

/**
 * Tell the person a write did not land, in the server's words. The switch is
 * already back where it was: permission writes are never optimistic.
 *
 * A write refused for where this device is, such as raising permissions from
 * Wi-Fi (DOR-3037), is not a fault: the app's mutation handler already says
 * so calmly, so this adds no red toast beside it.
 *
 * @param err - What the write threw.
 */
export function reportPermissionFailure(err: unknown): void {
  if (awayFromTheComputerSentence(err)) return;
  toast.error(
    err instanceof Error && err.message ? err.message : 'Couldn’t save that change. Try again.'
  );
}
