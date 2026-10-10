/**
 * Remote access routes (DOR-2086): the one report every surface reads, and the
 * actions a person takes on DorkOS managed remote access.
 *
 * ## Which actions are guarded, and why
 *
 * Starting setup (`POST /enrolment`), choosing a mode (`POST /mode`) and
 * withdrawing (`POST /withdraw`) decide who can reach this computer, and how,
 * and withdrawing ends a person's consent. They are a person's, at this
 * computer, so each runs these bars in this order:
 *
 * 1. the cookie bar under login (`requireOperatorCookieUnderLogin`): a
 *    per-user API key is not a person;
 * 2. the trusted-caller bar (`trustedCaller`): an agent, or a caller holding an
 *    approval token, is refused in every posture;
 * 3. the local-caller bar (`isLocalCaller`): a phone over a tunnel, managed
 *    access itself, or another device on the network is refused;
 * 4. for anything managed, a real login (`canExpose`), answered with the same
 *    `AUTH_REQUIRED_FOR_EXPOSURE` the person's own tunnel uses, so the client
 *    routes the person into creating an owner account.
 *
 * Withdrawing runs the first three bars and never the fourth: like every
 * narrowing, it must work with login, the exposure prerequisites or Cloud
 * down. The unlink step withdraws through the coordinator directly, never
 * through this route.
 *
 * Closing (`POST /close`) runs no bar, like `POST /api/tunnel/stop`: it only
 * narrows exposure, changes no consent, and gating it once stranded an open
 * tunnel (DOR-574).
 *
 * Every action answers with the full report, and every change reaches the
 * other surfaces through the `tunnel_status` event they already listen to.
 *
 * @module routes/remote-access
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { RemoteAccessReport } from '@dorkos/shared/types';

import {
  requireOperatorCookieUnderLogin,
  isLocalCaller,
  readCallerAuthority,
} from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
  canExpose,
} from '../services/core/auth/exposure-guard.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import {
  managedRemoteCoordinator,
  type CoordinatorResult,
  type ManagedRemoteCoordinator,
} from '../services/core/remote/managed-remote-coordinator.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/** Refusal code for a remote access action from anywhere but this computer. */
export const REMOTE_SETUP_NEEDS_THIS_COMPUTER = 'REMOTE_SETUP_NEEDS_THIS_COMPUTER';

const ModeRequestSchema = z.object({ mode: z.enum(['off', 'byo', 'managed']) });

/** What the routes need, injectable for tests. */
export interface RemoteAccessRouteDeps {
  coordinator: Pick<
    ManagedRemoteCoordinator,
    'report' | 'startEnrolment' | 'selectMode' | 'close' | 'withdraw'
  >;
  /** The exposure guard: a real login and an owner account. */
  canExpose: () => boolean;
  /** Stop the person's own tunnel and remember it is off, as `POST /api/tunnel/stop` does. */
  stopOwnTunnel: () => Promise<void>;
}

/** Stop the person's own tunnel and save `tunnel.enabled: false`, exactly as its own stop route. */
async function stopOwnTunnel(): Promise<void> {
  if (tunnelManager.getMode() === 'byo') await tunnelManager.stopOwnTunnel();
  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.enabled) return;
  configManager.set('tunnel', { ...tunnelConfig, enabled: false });
  logConfigWrite('turning remote access off', 'tunnel', tunnelConfig, configManager.get('tunnel'));
}

/**
 * The cookie, trusted-caller and local-caller bars, in that order. Answers the
 * refusal itself and returns `true` when it refused.
 */
function refusePersonBars(req: Request, res: Response): boolean {
  const cookieRefusal = requireOperatorCookieUnderLogin(res, 'remote access');
  if (cookieRefusal) {
    res.status(cookieRefusal.status).json({ error: cookieRefusal.error, code: cookieRefusal.code });
    return true;
  }
  if (!trustedCaller(readCallerAuthority(req, res))) {
    logger.warn('[RemoteAccess] Refused a remote access action from an agent');
    res.status(403).json({ error: OPERATOR_ONLY_CONFIG_ERROR, code: OPERATOR_ONLY_CONFIG_CODE });
    return true;
  }
  if (!isLocalCaller(req)) {
    res.status(403).json({
      error: 'Remote access can only be changed on the computer DorkOS runs on.',
      code: REMOTE_SETUP_NEEDS_THIS_COMPUTER,
    });
    return true;
  }
  return false;
}

/**
 * Build the router mounted at `/api/remote-access`.
 *
 * @param deps - Seams for tests; the default uses the live coordinator.
 */
export function createRemoteAccessRouter(deps: RemoteAccessRouteDeps = defaultDeps()): Router {
  const router = Router();

  /** Answer an action: its refusal, or the full report. */
  async function answer(res: Response, result: CoordinatorResult | void): Promise<void> {
    if (result && !result.ok) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }
    const report: RemoteAccessReport = await deps.coordinator.report();
    res.json(report);
  }

  function refuseWithoutLogin(res: Response): boolean {
    if (deps.canExpose()) return false;
    res
      .status(409)
      .json({ error: EXPOSURE_REQUIRES_LOGIN_MESSAGE, code: AUTH_REQUIRED_FOR_EXPOSURE });
    return true;
  }

  /** GET /api/remote-access/report — where remote access stands. */
  router.get('/report', async (_req, res) => {
    await answer(res);
  });

  /** POST /api/remote-access/enrolment — a person starts managed setup on this computer. */
  router.post('/enrolment', async (req, res) => {
    if (refusePersonBars(req, res) || refuseWithoutLogin(res)) return;
    await answer(res, await deps.coordinator.startEnrolment());
  });

  /** POST /api/remote-access/mode — a person chooses off, their own tunnel, or managed. */
  router.post('/mode', async (req, res) => {
    if (refusePersonBars(req, res)) return;
    const parsed = ModeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose off, byo or managed.', code: 'INVALID_MODE' });
      return;
    }
    const { mode } = parsed.data;
    if (mode === 'managed' && refuseWithoutLogin(res)) return;
    const result = await deps.coordinator.selectMode(mode);
    if (result.ok && mode === 'off') await deps.stopOwnTunnel();
    await answer(res, result);
  });

  /** POST /api/remote-access/close — close managed access now. Unguarded: it only narrows. */
  router.post('/close', async (_req, res) => {
    deps.coordinator.close();
    await answer(res);
  });

  /**
   * POST /api/remote-access/withdraw — a person withdraws managed access here,
   * and Cloud is asked to forget it. The person bars, never the login bar:
   * withdrawal works with login or Cloud down. Answers once the local
   * withdrawal is done; Cloud's answer arrives as a `tunnel_status` event.
   */
  router.post('/withdraw', async (req, res) => {
    if (refusePersonBars(req, res)) return;
    void deps.coordinator.withdraw();
    await answer(res);
  });

  return router;
}

function defaultDeps(): RemoteAccessRouteDeps {
  return { coordinator: managedRemoteCoordinator, canExpose, stopOwnTunnel };
}
