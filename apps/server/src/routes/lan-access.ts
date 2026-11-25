/**
 * Network access routes (DOR-2930), mounted at `/api/lan-access`: where it stands,
 * and the switch that lets devices on the same network open DorkOS.
 *
 * Turning it ON is a person's decision about who can reach this computer, so it
 * clears the same bars as opening the person's own tunnel
 * (`POST /api/tunnel/start`), in the same order: the operator cookie under
 * login, a person rather than an agent, the front-door bar (the owner at this
 * computer, `refuseFrontDoorChange`, DOR-2969), then a real login.
 * `PATCH /api/config` runs the same front-door bar on `server.lanAccess`, so
 * neither route is a way around the other.
 * The login refusal carries `auth_required_for_exposure`, which walks the
 * client into owner-account setup. Turning it OFF runs no bars, as stopping a
 * tunnel does not: it only ever narrows who can reach in.
 *
 * @module routes/lan-access
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { frontDoorProblem, runFrontDoorWrite } from './front-door-step-up.js';
import { problem, readJsonBody, validationProblem, type ProblemStatus } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  readCallerAuthority,
  refuseFrontDoorChange,
  requireOperatorCookieUnderLogin,
} from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
  canExpose,
} from '../services/core/auth/exposure-guard.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { OPERATOR_ONLY_CONFIG_ERROR } from '../services/core/operator/config-write-policy.js';
import {
  lanAccess,
  writeLanAccessSetting,
  LAN_ACCESS_UNSUPPORTED_MESSAGE,
  type LanAccess,
} from '../services/core/lan-access/index.js';

/** The body `POST /api/lan-access` takes. */
const SwitchRequestSchema = z.object({ enabled: z.boolean() });

/** What the routes need, injected so tests own it. */
export interface LanAccessRouteDeps {
  /** The network access controller. */
  lanAccess: Pick<LanAccess, 'status' | 'reconcile'>;
  /** Write the `server.lanAccess` setting. */
  writeSetting: (enabled: boolean) => void;
  /** An owner account exists for other devices to sign in as (`canExpose`). */
  canExpose: () => boolean;
}

/** The bars a person clears before opening this computer to the network. */
function refuseOpening(c: Context<ApiEnv>, deps: LanAccessRouteDeps): Response | undefined {
  const caller = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'network access');
  if (cookieRefusal) {
    return problem(c, 'person_only', {
      detail: `${cookieRefusal.error}.`,
      status: cookieRefusal.status as ProblemStatus,
    });
  }
  if (!trustedCaller(readCallerAuthority(caller))) {
    logger.warn('[LanAccess] Refused to open network access for an agent');
    return problem(c, 'person_only', { detail: `${OPERATOR_ONLY_CONFIG_ERROR}.` });
  }
  const frontDoor = refuseFrontDoorChange(caller, 'network access');
  if (frontDoor) return frontDoorProblem(c, frontDoor);
  if (!deps.lanAccess.status().supported) {
    return problem(c, 'lan_access_unsupported', { detail: LAN_ACCESS_UNSUPPORTED_MESSAGE });
  }
  const setBy = deps.lanAccess.status().setByEnvironment;
  if (setBy !== null) {
    // The same setting `GET /api/lan-access` reports as `setByEnvironment`.
    return problem(c, 'set_by_environment', {
      detail: `${setBy} is set, so it decides where DorkOS listens.`,
    });
  }
  if (!deps.canExpose()) {
    return problem(c, 'auth_required_for_exposure', { detail: EXPOSURE_REQUIRES_LOGIN_MESSAGE });
  }
  return undefined;
}

/**
 * Build the routes mounted at `/api/lan-access`.
 *
 * @param deps - The controller and the setting it follows; defaults to the live ones.
 */
export function createLanAccessRoutes(
  deps: LanAccessRouteDeps = { lanAccess, writeSetting: writeLanAccessSetting, canExpose }
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** GET /api/lan-access — whether network access is on, and the addresses to use. */
  router.get('/', (c) => c.json(deps.lanAccess.status()));

  /** POST /api/lan-access — `{ enabled }`. Answers with the status once applied. */
  router.post('/', async (c) => {
    const parsed = SwitchRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error, {
        detail: 'Send { "enabled": true } or { "enabled": false }.',
      });
    }
    const { enabled } = parsed.data;
    if (enabled) {
      const refusal = refuseOpening(c, deps);
      if (refusal) return refusal;
      return runFrontDoorWrite(c, {
        kind: 'lan-access.enable',
        target: 'wifi-access',
        input: parsed.data,
        reason: 'Let devices on your network open DorkOS.',
        subject: 'Network access',
        run: async () => {
          // Environment support and exposure prerequisites can change while held.
          const unavailable = refuseOpening(c, deps);
          if (unavailable) return unavailable;
          deps.writeSetting(true);
          return c.json(await deps.lanAccess.reconcile());
        },
      });
    }
    deps.writeSetting(enabled);
    return c.json(await deps.lanAccess.reconcile());
  });

  return router;
}
