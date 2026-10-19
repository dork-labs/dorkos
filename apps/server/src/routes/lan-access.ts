/**
 * Wi-Fi access routes (DOR-2930), mounted at `/api/lan-access`: where it stands,
 * and the switch that lets devices on the same network open DorkOS.
 *
 * Turning it ON is a person's decision about who can reach this computer, so it
 * clears the same bars as opening the person's own tunnel
 * (`POST /api/tunnel/start`), in the same order: the operator cookie under
 * login, a person rather than an agent, the front-door bar (the owner at this
 * computer, `refuseFrontDoorChange`, DOR-2969), then a real login.
 * `PATCH /api/config` runs the same front-door bar on `server.lanAccess`, so
 * neither route is a way around the other.
 * The login refusal carries `AUTH_REQUIRED_FOR_EXPOSURE`, which walks the
 * client into owner-account setup. Turning it OFF runs no bars, as stopping a
 * tunnel does not: it only ever narrows who can reach in.
 *
 * @module routes/lan-access
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  readCallerAuthority,
  refuseFrontDoorChange,
  requireOperatorCookieUnderLogin,
} from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import {
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
  canExpose,
} from '../services/core/auth/exposure-guard.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import {
  lanAccess,
  writeLanAccessSetting,
  LAN_ACCESS_UNSUPPORTED_MESSAGE,
  type LanAccess,
} from '../services/core/lan-access/index.js';

/** Refusal code: `DORKOS_HOST` is set, so it decides where DorkOS listens. */
export const LAN_ACCESS_SET_BY_ENVIRONMENT = 'LAN_ACCESS_SET_BY_ENVIRONMENT';

/** Refusal code: the switch does not work on this kind of computer yet. */
export const LAN_ACCESS_UNSUPPORTED = 'LAN_ACCESS_UNSUPPORTED';

/** The body `POST /api/lan-access` takes. */
const SwitchRequestSchema = z.object({ enabled: z.boolean() });

/** What the routes need, injected so tests own it. */
export interface LanAccessRouteDeps {
  /** The Wi-Fi access controller. */
  lanAccess: Pick<LanAccess, 'status' | 'reconcile'>;
  /** Write the `server.lanAccess` setting. */
  writeSetting: (enabled: boolean) => void;
  /** An owner account exists for other devices to sign in as (`canExpose`). */
  canExpose: () => boolean;
}

/** The bars a person clears before opening this computer to the network. */
function refuseOpening(c: Context<ApiEnv>, deps: LanAccessRouteDeps): Response | undefined {
  const caller = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'Wi-Fi access');
  if (cookieRefusal) {
    return c.json(
      { error: cookieRefusal.error, code: cookieRefusal.code },
      cookieRefusal.status as ContentfulStatusCode
    );
  }
  if (!trustedCaller(readCallerAuthority(caller))) {
    logger.warn('[LanAccess] Refused to open Wi-Fi access for an agent');
    return c.json({ error: OPERATOR_ONLY_CONFIG_ERROR, code: OPERATOR_ONLY_CONFIG_CODE }, 403);
  }
  const frontDoor = refuseFrontDoorChange(caller, 'Wi-Fi access');
  if (frontDoor) return c.json({ error: frontDoor.error, code: frontDoor.code }, 403);
  if (!deps.lanAccess.status().supported) {
    return c.json({ error: LAN_ACCESS_UNSUPPORTED_MESSAGE, code: LAN_ACCESS_UNSUPPORTED }, 409);
  }
  if (deps.lanAccess.status().setByEnvironment !== null) {
    return c.json(
      {
        error: `${deps.lanAccess.status().setByEnvironment} is set, so it decides where DorkOS listens.`,
        code: LAN_ACCESS_SET_BY_ENVIRONMENT,
      },
      409
    );
  }
  if (!deps.canExpose()) {
    return c.json(
      { error: EXPOSURE_REQUIRES_LOGIN_MESSAGE, code: AUTH_REQUIRED_FOR_EXPOSURE },
      409
    );
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

  /** GET /api/lan-access — whether Wi-Fi access is on, and the addresses to use. */
  router.get('/', (c) => c.json(deps.lanAccess.status()));

  /** POST /api/lan-access — `{ enabled }`. Answers with the status once applied. */
  router.post('/', async (c) => {
    const parsed = SwitchRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Send { "enabled": true } or { "enabled": false }.' }, 400);
    }
    const { enabled } = parsed.data;
    if (enabled) {
      const refusal = refuseOpening(c, deps);
      if (refusal) return refusal;
    }
    deps.writeSetting(enabled);
    return c.json(await deps.lanAccess.reconcile());
  });

  return router;
}
