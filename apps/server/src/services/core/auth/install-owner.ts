/**
 * Who owns this install, asked of one signed-in account. Its own module, beside
 * `./index.ts` rather than in it, so it reads `readOwnerAccount` through that
 * module's exports, the same seam every other owner check reads.
 *
 * @module services/core/auth/install-owner
 */
import { readOwnerAccount } from './index.js';

/**
 * Whether a signed-in account is the one that owns this install
 * (`readOwnerAccount`, ADR 260727-184933 D6). The owner half of
 * `refuseUnlessAccountOwner` (`lib/caller-authority.ts`), on its own for a surface that runs its own
 * person bars first (`routes/connector-management.ts`), so the two cannot
 * disagree about who the owner is.
 *
 * @param user - The account `sessionGate` resolved, if any.
 * @returns False when nobody is signed in, or no owner account can be read:
 *   nobody can be shown to own the install then.
 */
export function isInstallOwner(user: { userId: string } | undefined): boolean {
  const owner = readOwnerAccount();
  return owner !== null && user !== undefined && user.userId === owner.id;
}
