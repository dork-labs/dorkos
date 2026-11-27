/**
 * Tunnel route — endpoints to start and stop the ngrok tunnel and read its
 * status. Live changes come on `GET /api/events` as `tunnel_status`.
 *
 * @module routes/tunnel
 */
import { createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { env } from '../env.js';
import { getLocalCockpitPort } from '../lib/trusted-origins.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { TunnelPortMismatchError } from '../services/core/remote/own-tunnel-ingress.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import {
  canExpose,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
} from '../services/core/auth/exposure-guard.js';
import { resolveTunnelSettings } from '../services/core/config/tunnel-settings.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { OPERATOR_ONLY_CONFIG_ERROR } from '../services/core/operator/config-write-policy.js';
import {
  readCallerAuthority,
  refuseFrontDoorChange,
  requireOperatorCookieUnderLogin,
} from '../lib/caller-authority.js';
import { logger, logError } from '../lib/logger.js';
import { frontDoorReadAudience, readCallerPrincipal } from '../lib/caller-principal.js';

const router = new Hono<ApiEnv>();

/**
 * The read bar (DOR-3650): the status carries this machine's public address.
 * Another device already needs a sign-in or a key to get here (the session
 * gate, pinned by the cloud-groups contract); this keeps out a caller that says
 * it is an agent, here or anywhere. A key holder still reads it, as the
 * contract says. The same rule decides who hears `tunnel_status` on
 * `GET /api/events` ({@link frontDoorReadAudience}), so the two cannot drift.
 */
const refuseAgentRead: MiddlewareHandler<ApiEnv> = async (c, next) =>
  frontDoorReadAudience(readCallerPrincipal(honoRequestFacts(c)))
    ? next()
    : problem(c, 'person_only', { detail: 'Agents can’t read remote access.' });

/** GET /api/tunnel/status — on-demand status check. */
router.get('/status', refuseAgentRead, (c) => c.json(tunnelManager.status));

/**
 * The `409 tunnel_running` for a tunnel already open, with its address in
 * `url`: not a failure, the answer converging on a tunnel that is up.
 */
function alreadyRunning(c: Context<ApiEnv>): Response {
  return problem(c, 'tunnel_running', {
    detail: 'Remote access is already on.',
    extensions: { url: tunnelManager.status.url ?? null },
  });
}

router.post('/start', async (c) => {
  // Opening a tunnel publishes this machine, and `tunnel.enabled` is one of the
  // operator-only settings in `config-write-policy.ts` — which this route then
  // writes directly, bypassing the bars `PATCH /api/config` runs for exactly
  // those paths. So it runs the same two bars here, in the same order and for
  // the same reasons (see `routes/config.ts` → `refuseOperatorOnly`): the cookie
  // bar first, so a caller failing both hears the more useful answer.
  //
  // They sit above the already-running and exposure checks to match that
  // precedent — identity first, then the state of the world — and a test pins
  // the order so it cannot drift. That is the entire claim for the placement.
  //
  // It is deliberately NOT sold as keeping the tunnel's public URL from a caller
  // that fails a bar. It would look like it does, since the already-running 409
  // carries the URL and this refusal does not. But `GET /api/tunnel/status`
  // answers that same URL with no bars on it at all, so anything that can reach
  // this route can already read it. Whether the READ surface should be gated is
  // a separate question from who may open a tunnel, and is not decided here.
  //
  // `/stop` runs neither bar, and that asymmetry is deliberate — see the comment
  // there. Stopping only ever narrows exposure.
  const caller = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'Remote Access');
  if (cookieRefusal) {
    return problem(c, 'person_only', { detail: `${cookieRefusal.error}.` });
  }
  if (!trustedCaller(readCallerAuthority(caller))) {
    logger.warn('[Tunnel] Blocked start — an agent may not publish this machine');
    return problem(c, 'person_only', { detail: `${OPERATOR_ONLY_CONFIG_ERROR}.` });
  }
  // The front-door bar (DOR-2969): only the owner, at this computer, publishes it.
  const frontDoor = refuseFrontDoorChange(caller, 'remote access');
  if (frontDoor) return problem(c, 'operator_only', { detail: frontDoor.error });

  // Return 409 if a tunnel is already open. Asked of the manager rather than of
  // `status.connected`, which goes false for as long as ngrok is reconnecting
  // while the listener is still open — reading it turned a momentary
  // disconnect into `start()` throwing 'Tunnel is already running', answered as
  // a 500 (DOR-1738).
  if (tunnelManager.isRunning) return alreadyRunning(c);

  // Exposure guard (task 1.3): never open a public tunnel without a real login.
  // Allowed only when an owner account exists: every request through the tunnel
  // is another device, which always signs in as it (ADR 261015-125850). The
  // `auth_required_for_exposure` code routes the client into owner-account creation.
  if (!canExpose()) {
    logger.warn('[Tunnel] Blocked start — exposing DorkOS requires an owner account');
    return problem(c, 'auth_required_for_exposure', { detail: EXPOSURE_REQUIRES_LOGIN_MESSAGE });
  }

  const tunnelConfig = configManager.get('tunnel');
  // The same resolver the boot-time autostart reads, so the two cannot disagree
  // about what "the tunnel's settings" are (DOR-1738).
  const { config } = resolveTunnelSettings({
    env,
    stored: tunnelConfig,
    fallbackPort: getLocalCockpitPort(),
  });

  if (!config.authtoken) {
    return problem(c, 'tunnel_token_missing', { detail: 'Add an ngrok auth token first.' });
  }

  return runFrontDoorWrite(c, {
    kind: 'tunnel.start',
    target: 'own-tunnel',
    input: {
      port: config.port,
      domain: config.domain ?? null,
      credentialsHash: createHash('sha256')
        .update(JSON.stringify([config.authtoken, config.basicAuth ?? null]))
        .digest('hex'),
    },
    reason: 'Turn on Remote Access through your tunnel.',
    subject: 'remote access',
    run: async () => {
      if (JSON.stringify(configManager.get('tunnel')) !== JSON.stringify(tunnelConfig)) {
        return problem(c, 'precondition_failed', { detail: 'Tunnel settings changed. Try again.' });
      }
      if (!canExpose()) {
        return problem(c, 'auth_required_for_exposure', {
          detail: EXPOSURE_REQUIRES_LOGIN_MESSAGE,
        });
      }
      if (tunnelManager.isRunning) return alreadyRunning(c);
      try {
        await tunnelManager.start(config);

        // Persist enabled state
        const before = configManager.get('tunnel');
        configManager.set('tunnel', { ...before, enabled: true });
        logConfigWrite('the tunnel route', 'tunnel', before, configManager.get('tunnel'));

        return c.json({ url: tunnelManager.status.url });
      } catch (err) {
        // A TUNNEL_PORT the tunnel can't use is a setting to fix, not a fault: 409
        // with a stable code the app and scripts can act on (DOR-4263).
        if (err instanceof TunnelPortMismatchError) {
          logger.warn('[Tunnel] Refused start — TUNNEL_PORT points past Remote Access');
          return problem(c, 'tunnel_port_mismatch', {
            detail: 'Remote access can’t reach that port. Unset TUNNEL_PORT, or fix it.',
          });
        }
        // Say what went wrong in the log, where a person debugging reads it: the
        // answer carries one fixed sentence, never the error's own text (GitHub #1458).
        logger.error('[Tunnel] Failed to start', logError(err));
        return problem(c, 'internal_error', { detail: 'Couldn’t open your link. Try again.' });
      }
    },
  });
});

router.post('/stop', async (c) => {
  // DOR-574 revisited: an earlier version of this route gated `/stop` behind
  // `canExpose()`, mirroring `/start`. Adversarial review rejected that —
  // `canExpose()` answers "is login configured for exposure", not "is this
  // caller authorized", so it gates nothing a real attacker cannot already
  // walk past (when it is false, login is off and the whole API is open
  // anyway). Worse, it actively strands a running tunnel: start it while
  // exposable, disable login afterward, and `/stop` would 409 forever — the
  // response tells the operator to CREATE a login in order to turn something
  // OFF, and a default install with a stale `tunnel.enabled: true` from a
  // prior session could never self-heal. Stopping a tunnel only ever narrows
  // exposure, so it must always succeed regardless of the login posture.
  //
  // It stops the person's OWN tunnel only. DorkOS managed remote access has its
  // own close (DOR-2086), and never both are open at once, so this route never
  // needs to reach managed access to keep that true.
  try {
    await tunnelManager.stopOwnTunnel();

    // Persist disabled state
    const tunnelConfig = configManager.get('tunnel');
    configManager.set('tunnel', { ...tunnelConfig, enabled: false });
    logConfigWrite('the tunnel route', 'tunnel', tunnelConfig, configManager.get('tunnel'));

    return c.json({ ok: true });
  } catch (err) {
    logger.error('[Tunnel] Failed to stop', logError(err));
    return problem(c, 'internal_error', {
      detail: 'Couldn’t close your link. DorkOS can’t tell if it’s still on.',
    });
  }
});

export default router;
