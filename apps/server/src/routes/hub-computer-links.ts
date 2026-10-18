/**
 * The owner's half of linking computers to a hub (step B3, DOR-2946), mounted
 * inside `/api/hub/computers` (`routes/hub-computers.ts`), behind the same
 * guard: a hub only, the owner's own browser sign-in only, never an agent or
 * an API key.
 *
 * - `POST /link-code` mints a one-time link code (`hub-relay/link-codes.ts`)
 *   and answers it with the hub's host folded in, for the owner to copy to the
 *   computer. Never cached.
 * - `DELETE /:computerId` unlinks a computer: its relay secret stops working
 *   at once, and any connection it has open is closed.
 *
 * The computer's half, redeeming the code, is `routes/hub-link.ts`.
 *
 * @module routes/hub-computer-links
 */
import type { Hono } from 'hono';
import { formatRelayLinkCode } from '@dorkos/shared/session-relay-link';
import type { AuditActor, AuditOutcome } from '@dorkos/shared/audit-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { errorBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { currentAuditActor } from '../services/audit/audit-context.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  forgetLinkedComputer,
  hubLinkCodes,
  liveServingOrigin,
  readLinkedComputers,
  type LinkedComputer,
  type MintedLinkCode,
} from '../services/core/hub-relay/index.js';

/** What the owner's link routes read and write, injectable for tests. */
export interface HubComputerLinkDeps {
  /** The hub's origin while it serves; `null` otherwise. */
  servingOrigin: () => string | null;
  /** Mint a code, remembering who asked for it. */
  mint: (mintedBy: AuditActor | undefined) => MintedLinkCode;
  /** Unlink a computer; whether it was linked. */
  forget: (computerId: string) => Promise<boolean>;
  /** A linked computer's stored record, or `null`. */
  record: (computerId: string) => LinkedComputer | null;
}

/** The live store, codes and serving state. */
export const liveHubComputerLinkDeps: HubComputerLinkDeps = {
  servingOrigin: liveServingOrigin,
  mint: (mintedBy) => hubLinkCodes.mint(mintedBy),
  forget: (computerId) => forgetLinkedComputer(computerId),
  record: (computerId) =>
    readLinkedComputers().find((computer) => computer.computerId === computerId) ?? null,
};

/** Record an owner's link change, readable by them alone. */
function auditLinkChange(entry: {
  action: string;
  operation: 'create' | 'remove';
  summary: string;
  outcome: AuditOutcome;
  error?: string;
  target: { type: string; id: string; name?: string };
}): void {
  const scope = currentAuditActor();
  recordAudit({
    ...entry,
    ...(scope ? { visibility: 'participants', participants: [scope.actor.accountId] } : {}),
  });
}

/**
 * Mount the owner's link routes on the `/api/hub/computers` group, after its
 * guard.
 *
 * @param router - The group, its guard already in place.
 * @param deps - Override for tests; defaults to the live hub.
 */
export function mountHubComputerLinkRoutes(
  router: Hono<ApiEnv>,
  deps: HubComputerLinkDeps = liveHubComputerLinkDeps
): void {
  router.post('/link-code', (c) => {
    const origin = deps.servingOrigin();
    if (!origin) {
      return c.json(errorBody('This hub is not serving yet.', 'HUB_NOT_SERVING'), 503);
    }
    const minted = deps.mint(currentAuditActor()?.actor);
    auditLinkChange({
      action: 'hub.relay.link_code.create',
      operation: 'create',
      summary: 'Made a code to link a computer',
      outcome: 'ok',
      target: { type: 'hub', id: origin },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      linkCode: formatRelayLinkCode(minted.code, origin),
      expiresAt: new Date(minted.expiresAt).toISOString(),
    });
  });

  router.delete('/:computerId', async (c) => {
    const computerId = c.req.param('computerId');
    const name = deps.record(computerId)?.computerName;
    let removed: boolean;
    try {
      removed = await deps.forget(computerId);
    } catch (error) {
      logger.warn('[HubRelay] A computer could not be unlinked', { error: (error as Error).name });
      auditLinkChange({
        action: 'hub.relay.computer.unlink',
        operation: 'remove',
        summary: 'A computer could not be unlinked',
        outcome: 'failed',
        error: 'store_failed',
        target: { type: 'computer', id: computerId, ...(name ? { name } : {}) },
      });
      return c.json(errorBody("Couldn't unlink that computer. Try again.", 'UNLINK_FAILED'), 503);
    }
    if (!removed) return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    auditLinkChange({
      action: 'hub.relay.computer.unlink',
      operation: 'remove',
      summary: 'Unlinked a computer',
      outcome: 'ok',
      target: { type: 'computer', id: computerId, ...(name ? { name } : {}) },
    });
    return c.body(null, 204);
  });
}
