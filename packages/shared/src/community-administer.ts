/**
 * Whether the DorkOS app can manage a connected space for its person (DOR-3005), as the local
 * server answers `GET /api/community-connections/:ref/administer`.
 *
 * Managing a space takes a separate credential from the space, which an owner or admin gives the
 * app by ticking a consent line when they pair. Connections made before it, or approved without
 * it, keep working read-only; their owners and admins pair again to manage the space here.
 *
 * @module shared/community-administer
 */
import { z } from 'zod';

/** `GET /api/community-connections/:ref/administer`. */
export const CommunityConnectionAdministerSchema = z.strictObject({
  /** This connection holds the space's manage credential. */
  canAdminister: z.boolean(),
  /**
   * The space offers that credential to an owner or admin who pairs again. False for a space too
   * old to offer it, and while the space cannot be reached.
   */
  administerAvailable: z.boolean(),
});
/** Whether the app can manage a connected space, and whether pairing again would let it. */
export type CommunityConnectionAdminister = z.infer<typeof CommunityConnectionAdministerSchema>;
