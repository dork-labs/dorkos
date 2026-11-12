/**
 * Which mini apps may read which connected apps (DOR-3547), as the client
 * reaches it. A slice of the `Transport` (`transport-slices.ts`). There is no
 * approve here on purpose: a yes is given only on its own page, outside the
 * app, where no mini app code runs.
 *
 * @module shared/transport-mini-app-access
 */
import type { MiniAppAccessList, MiniAppAccessRevokeResponse } from './mini-app-access-schemas.js';

/** List and take back mini apps' access to connected apps. */
export interface MiniAppAccessTransport {
  /** What each mini app waits for, and what each may read now. */
  getMiniAppAccess(): Promise<MiniAppAccessList>;
  /** Take one yes back. The mini app's next read of that account is refused. */
  revokeMiniAppAccess(approvalId: string): Promise<MiniAppAccessRevokeResponse>;
}
