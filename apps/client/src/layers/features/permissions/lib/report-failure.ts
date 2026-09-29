/**
 * How a permission write that did not land is reported.
 *
 * @module features/permissions/lib/report-failure
 */
import { toast } from 'sonner';

/**
 * Tell the person a write did not land, in the server's words. The switch is
 * already back where it was: permission writes are never optimistic.
 *
 * @param err - What the write threw.
 */
export function reportPermissionFailure(err: unknown): void {
  toast.error(err instanceof Error && err.message ? err.message : "That change didn't save.");
}
