/**
 * The first-run API (spec `one-minute-onboarding` §4):
 *
 * - `POST /api/onboarding/first-run` records the path picked on the Welcome
 *   screen and sets it up. It saves keys and moves the default runtime, so it
 *   sits behind the same bars as the DorkOS model setup
 *   (`doe-setup-router.ts`): this computer, and a person who owns the install.
 * - `POST /api/onboarding/welcome` posts DorkBot's welcome into #team, once.
 *
 * @module routes/onboarding
 */
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { FirstRunRequestSchema } from '@dorkos/shared/onboarding-schemas';
import { isLocalCaller, refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { logger, logError } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { isCloudLinked } from '../services/core/cloud/v1-client.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { AgentUpdateError, updateAgentManifest } from '../services/core/operator/agent-updater.js';
import {
  FirstRunError,
  applyFirstRun,
  type FirstRunDeps,
} from '../services/core/onboarding/first-run.js';
import {
  WelcomeUnavailableError,
  postFirstRunWelcome,
  type WelcomeDeps,
} from '../services/core/onboarding/welcome.js';
import { DORKBOT_AGENT_NAME } from '../services/mesh/ensure-dorkbot.js';
import { getRoomService } from '../services/rooms/index.js';
import { storeDoeCredential } from '../services/runtimes/connect/doe-credentials.js';
import type { PresetFetch } from '../services/runtimes/doe/presets.js';

/** What the router builds its deps from, per request. */
export interface OnboardingRouterDeps {
  /** The first-run writers, for one request. */
  firstRun: (req: Request) => FirstRunDeps;
  /** The welcome's config, rooms and name, for one request. */
  welcome: (req: Request) => WelcomeDeps;
}

/** The person bar, then the owner bar; refuses with the sentence and returns `true`. */
function refuseUnlessOwner(req: Request, res: Response): boolean {
  const refusal = refuseUnlessAccountOwner(req, res);
  if (!refusal) return false;
  res.status(403).json({ error: 'Only the owner can set up DorkOS.', code: refusal });
  return true;
}

/** DorkBot's directory. */
function dorkbotPath(): string {
  return path.join(resolveDorkHome(), 'agents', DORKBOT_AGENT_NAME);
}

/** The production deps: the config, the mesh write-through and the rooms. */
const productionDeps: OnboardingRouterDeps = {
  firstRun: (req) => ({
    config: configManager,
    setDorkBotRuntime: async (runtime) => {
      try {
        await updateAgentManifest({
          agentPath: dorkbotPath(),
          body: { runtime },
          meshCore: req.app.locals.meshCore,
        });
      } catch (error) {
        // An install without DorkBot, or a default no agent can name, still
        // gets its default runtime moved; DorkBot keeps the runtime it has.
        const skippable =
          error instanceof AgentUpdateError && ['NOT_FOUND', 'VALIDATION'].includes(error.code);
        if (!skippable) throw error;
        logger.warn('[Onboarding] DorkBot was left on its runtime', { code: error.code });
      }
    },
    storeCredential: (inference, secret) => storeDoeCredential(inference, secret),
    fetch: ((url, init) => fetch(url, init)) satisfies PresetFetch,
    linked: isCloudLinked,
    isRuntime: (type) => runtimeRegistry.has(type),
  }),
  welcome: () => ({
    config: configManager,
    rooms: getRoomService(),
    dorkbotPath: dorkbotPath(),
    personName: () => configManager.get('profile').displayName ?? readOwnerAccount()?.name ?? null,
  }),
};

/**
 * Build the first-run router.
 *
 * @param deps - Where each request's writers come from.
 */
export function createOnboardingRouter(deps: OnboardingRouterDeps = productionDeps): Router {
  const router = Router();

  router.post('/first-run', async (req, res) => {
    if (!isLocalCaller(req)) {
      return res.status(403).json({ error: 'Setup is only available on this computer.' });
    }
    if (refuseUnlessOwner(req, res)) return;
    const parsed = FirstRunRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose how your agents run.' });
    try {
      return res.json(await applyFirstRun(parsed.data, deps.firstRun(req)));
    } catch (error) {
      if (error instanceof FirstRunError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      logger.warn('[Onboarding] first-run setup failed', logError(error));
      return res.status(500).json({ error: "Couldn't finish setup. Try again." });
    }
  });

  router.post('/welcome', (req, res) => {
    if (refuseUnlessOwner(req, res)) return;
    try {
      return res.json(postFirstRunWelcome(deps.welcome(req)));
    } catch (error) {
      if (error instanceof FirstRunError || error instanceof WelcomeUnavailableError) {
        const code = error instanceof FirstRunError ? error.code : 'team_unavailable';
        return res.status(error.status).json({ error: error.message, code });
      }
      logger.warn('[Onboarding] welcome failed', logError(error));
      return res.status(500).json({ error: "Couldn't post DorkBot's welcome. Try again." });
    }
  });

  return router;
}

export default createOnboardingRouter();
