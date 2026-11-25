/**
 * The first-run API (spec `one-minute-onboarding` §4):
 *
 * - `POST /api/onboarding/first-run` records the path picked on the Welcome
 *   screen and sets it up. It saves keys and moves the default runtime, so it
 *   sits behind the same bars as the DorkOS model setup
 *   (`routes/runtimes-doe-setup.ts`): this computer, and a person who owns the install.
 * - `POST /api/onboarding/welcome` posts DorkBot's welcome into #team, once.
 *
 * Mounted on the Hono `/api` app by `http/hono-api.ts`.
 *
 * @module routes/onboarding
 */
import path from 'node:path';
import { Hono, type Context } from 'hono';
import type { MeshCore } from '@dorkos/mesh';
import { FirstRunRequestSchema, type FirstRunRefusalCode } from '@dorkos/shared/onboarding-schemas';
import type { ProblemCode } from '@dorkos/shared/problem';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { logger, logError } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { accountNameForDisplay } from '../services/identity/operator-profile.js';
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
import { isAtThisComputer, isOnEncryptedConnection } from '../services/core/auth/gate-policy.js';

/** What the routes build their deps from, per request. */
export interface OnboardingRouterDeps {
  /** The first-run writers, for one request. */
  firstRun: () => FirstRunDeps;
  /** The welcome's config, rooms and name, for one request. */
  welcome: () => WelcomeDeps;
}

/** The person bar, then the owner bar: the 403 with the sentence, or `undefined`. */
function refuseUnlessOwner(c: Context<ApiEnv>): Response | undefined {
  const refusal = refuseUnlessAccountOwner(honoRequestFacts(c));
  if (!refusal) return undefined;
  return problem(c, refusal === 'not-a-person' ? 'person_only' : 'owner_only', {
    detail: 'Only the owner can set up DorkOS.',
  });
}

/**
 * The problem code for each first-run refusal. The sentence is the service's
 * own: each is written there, never an upstream service's text.
 */
const FIRST_RUN_PROBLEM: Record<FirstRunRefusalCode, ProblemCode> = {
  onboarding_complete: 'already_resolved',
  invalid_key: 'invalid_request',
  invalid_setup: 'invalid_request',
  models_unreachable: 'upstream_unavailable',
};

/** Answer a first-run refusal as a problem document. */
function firstRunProblem(c: Context<ApiEnv>, error: FirstRunError): Response {
  return problem(c, FIRST_RUN_PROBLEM[error.code], { detail: error.message });
}

/** DorkBot's directory. */
function dorkbotPath(): string {
  return path.join(resolveDorkHome(), 'agents', DORKBOT_AGENT_NAME);
}

/**
 * The production deps: the config, the mesh write-through and the rooms.
 *
 * @param meshCore - The agent registry, read per request; `undefined` while the
 *   mesh is not running, and DorkBot's manifest is then written without its
 *   registry sync.
 */
export function productionOnboardingDeps(
  meshCore: () => MeshCore | undefined
): OnboardingRouterDeps {
  return {
    firstRun: () => ({
      config: configManager,
      setDorkBotRuntime: async (runtime) => {
        try {
          await updateAgentManifest({
            agentPath: dorkbotPath(),
            body: { runtime },
            meshCore: meshCore(),
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
      // An account name that is only the email is no name to greet (DOR-2964).
      personName: () => {
        const owner = readOwnerAccount();
        const account = owner ? getUserById(owner.id) : null;
        return (
          configManager.get('profile').displayName ??
          accountNameForDisplay(account?.name, account?.email)
        );
      },
    }),
  };
}

/**
 * Build the first-run routes.
 *
 * @param deps - Where each request's writers come from.
 * @returns The routes, to mount at `/api/onboarding`.
 */
export function createOnboardingRoutes(deps: OnboardingRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/first-run', async (c) => {
    // Where the owner is changes nothing over an encrypted connection (DOR-3172).
    const facts = honoRequestFacts(c);
    if (!isAtThisComputer(facts) && !isOnEncryptedConnection(facts)) {
      return problem(c, 'operator_only', { detail: 'Setup is only available on this computer.' });
    }
    const refused = refuseUnlessOwner(c);
    if (refused) return refused;
    const parsed = FirstRunRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return problem(c, 'invalid_request', { detail: 'Choose how your agents run.' });
    }
    try {
      return c.json(await applyFirstRun(parsed.data, deps.firstRun()));
    } catch (error) {
      if (error instanceof FirstRunError) return firstRunProblem(c, error);
      logger.warn('[Onboarding] first-run setup failed', logError(error));
      return problem(c, 'internal_error', { detail: 'Couldn’t finish setup. Try again.' });
    }
  });

  router.post('/welcome', (c) => {
    const refused = refuseUnlessOwner(c);
    if (refused) return refused;
    try {
      return c.json(postFirstRunWelcome(deps.welcome()));
    } catch (error) {
      if (error instanceof FirstRunError) return firstRunProblem(c, error);
      if (error instanceof WelcomeUnavailableError) {
        return problem(c, 'temporarily_unavailable', {
          detail: '#team or DorkBot isn’t ready yet. Try again.',
        });
      }
      logger.warn('[Onboarding] welcome failed', logError(error));
      return problem(c, 'internal_error', {
        detail: 'Couldn’t post DorkBot’s welcome. Try again.',
      });
    }
  });

  return router;
}
