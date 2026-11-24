/**
 * Remote access routes (DOR-2086): the one report every surface reads, and the
 * actions a person takes on DorkOS managed remote access.
 *
 * ## Which actions are guarded, and why
 *
 * Starting setup (`POST /enrolment`), choosing a mode (`POST /mode`) and
 * withdrawing (`POST /withdraw`) decide who can reach this computer, and how,
 * and withdrawing ends a person's consent. They are a person's, at this
 * computer or on an encrypted connection, so each runs these bars in this
 * order:
 *
 * 1. the cookie bar under login (`requireOperatorCookieUnderLogin`): a
 *    per-user API key is not a person;
 * 2. the trusted-caller bar (`trustedCaller`): an agent, or a caller holding an
 *    approval token, is refused in every posture;
 * 3. the connection bar (`isAtThisComputer`, or `isOnEncryptedConnection`,
 *    DOR-3172): plain-`http` Wi-Fi and a bare network bind are refused; the
 *    own tunnel, managed access itself and DorkOS's own `https` listener pass;
 * 3b. the front-door bar (`refuseFrontDoorChange`, DOR-2969): only the
 *    install's owner using the app, never an API key;
 * 4. for anything managed, a real login (`canExpose`), answered with the
 *    `auth_required_for_exposure` problem, so the client routes the person
 *    into creating an owner account.
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
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RemoteAccessReport } from '@dorkos/shared/types';

import type { ApiEnv } from '../http/api-chain.js';
import { frontDoorProblem, runFrontDoorWrite } from './front-door-step-up.js';
import { problem, readJsonBody, validationProblem, type ProblemStatus } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  refuseFrontDoorChange,
  requireOperatorCookieUnderLogin,
  readCallerAuthority,
} from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
  canExpose,
} from '../services/core/auth/exposure-guard.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { OPERATOR_ONLY_CONFIG_ERROR } from '../services/core/operator/config-write-policy.js';
import {
  MANAGED_REMOTE_ALREADY_SET_UP,
  MANAGED_REMOTE_NOT_SET_UP,
  MANAGED_REMOTE_SETUP_FAILED,
  MANAGED_REMOTE_UNAVAILABLE,
  managedRemoteCoordinator,
  type CoordinatorResult,
  type ManagedRemoteCoordinator,
} from '../services/core/remote/managed-remote-coordinator.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { isAtThisComputer, isOnEncryptedConnection } from '../services/core/auth/gate-policy.js';

/**
 * The problem code for each way the managed remote coordinator refuses. Its
 * own codes stay its own; this is where they meet the API's one list.
 */
const COORDINATOR_PROBLEM: Record<string, ProblemCode> = {
  [MANAGED_REMOTE_UNAVAILABLE]: 'remote_access_unavailable',
  [MANAGED_REMOTE_ALREADY_SET_UP]: 'conflict',
  [MANAGED_REMOTE_NOT_SET_UP]: 'conflict',
  [MANAGED_REMOTE_SETUP_FAILED]: 'upstream_unavailable',
};

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
 * The cookie, trusted-caller and local-caller bars, in that order: the
 * refusal to answer with, or `undefined` when the caller may go on.
 */
function refusePersonBars(c: Context<ApiEnv>): Response | undefined {
  const caller = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'remote access');
  if (cookieRefusal) {
    return problem(c, 'person_only', {
      detail: `${cookieRefusal.error}.`,
      status: cookieRefusal.status as ProblemStatus,
    });
  }
  if (!trustedCaller(readCallerAuthority(caller))) {
    logger.warn('[RemoteAccess] Refused a remote access action from an agent');
    return problem(c, 'person_only', { detail: `${OPERATOR_ONLY_CONFIG_ERROR}.` });
  }
  if (!isAtThisComputer(caller) && !isOnEncryptedConnection(caller)) {
    return problem(c, 'operator_only', {
      detail: 'Remote access can only be changed on the computer DorkOS runs on.',
    });
  }
  // The front-door bar: the install's owner, using the app, never a key.
  const frontDoor = refuseFrontDoorChange(caller, 'remote access');
  if (frontDoor) return frontDoorProblem(c, frontDoor);
  return undefined;
}

/**
 * Build the routes mounted at `/api/remote-access`.
 *
 * @param deps - Seams for tests; the default uses the live coordinator.
 */
export function createRemoteAccessRoutes(
  deps: RemoteAccessRouteDeps = defaultDeps()
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** Answer an action: its refusal, or the full report. */
  async function answer(c: Context<ApiEnv>, result: CoordinatorResult | void): Promise<Response> {
    if (result && !result.ok) {
      return problem(c, COORDINATOR_PROBLEM[result.code] ?? 'conflict', {
        detail: result.error,
        status: result.status as ProblemStatus,
      });
    }
    const report: RemoteAccessReport = await deps.coordinator.report();
    return c.json(report);
  }

  /** The exposure guard's refusal, or `undefined` when a real login is set up. */
  function refuseWithoutLogin(c: Context<ApiEnv>): Response | undefined {
    if (deps.canExpose()) return undefined;
    return problem(c, 'auth_required_for_exposure', { detail: EXPOSURE_REQUIRES_LOGIN_MESSAGE });
  }

  /** GET /api/remote-access/report — where remote access stands. */
  router.get('/report', (c) => answer(c));

  /** POST /api/remote-access/enrolment — a person starts managed setup on this computer. */
  router.post('/enrolment', async (c) => {
    const refusal = refusePersonBars(c) ?? refuseWithoutLogin(c);
    if (refusal) return refusal;
    return runFrontDoorWrite(c, {
      kind: 'remote-access.enrolment',
      target: 'remote-access',
      input: {},
      reason: 'Set up Remote Access for DorkOS.',
      subject: 'remote access',
      run: async () => {
        const unavailable = refuseWithoutLogin(c);
        return unavailable ?? answer(c, await deps.coordinator.startEnrolment());
      },
    });
  });

  /** POST /api/remote-access/mode — a person chooses off, their own tunnel, or managed. */
  router.post('/mode', async (c) => {
    const refusal = refusePersonBars(c);
    if (refusal) return refusal;
    const parsed = ModeRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error, { detail: 'Choose off, byo or managed.' });
    }
    const { mode } = parsed.data;
    const loginRefusal = mode === 'managed' ? refuseWithoutLogin(c) : undefined;
    if (loginRefusal) return loginRefusal;
    if (mode === 'off') {
      const result = await deps.coordinator.selectMode(mode);
      if (result.ok) await deps.stopOwnTunnel();
      return answer(c, result);
    }
    return runFrontDoorWrite(c, {
      kind: 'remote-access.mode',
      target: 'remote-access',
      input: parsed.data,
      reason: 'Turn on Remote Access for DorkOS.',
      subject: 'remote access',
      run: async () => {
        const unavailable = mode === 'managed' ? refuseWithoutLogin(c) : undefined;
        return unavailable ?? answer(c, await deps.coordinator.selectMode(mode));
      },
    });
  });

  /** POST /api/remote-access/close — close managed access now. Unguarded: it only narrows. */
  router.post('/close', (c) => {
    deps.coordinator.close();
    return answer(c);
  });

  /**
   * POST /api/remote-access/withdraw — a person withdraws managed access here,
   * and Cloud is asked to forget it. The person bars, never the login bar:
   * withdrawal works with login or Cloud down. Answers once the local
   * withdrawal is done; Cloud's answer arrives as a `tunnel_status` event.
   */
  router.post('/withdraw', (c) => {
    const refusal = refusePersonBars(c);
    if (refusal) return refusal;
    void deps.coordinator.withdraw();
    return answer(c);
  });

  return router;
}

function defaultDeps(): RemoteAccessRouteDeps {
  return { coordinator: managedRemoteCoordinator, canExpose, stopOwnTunnel };
}
