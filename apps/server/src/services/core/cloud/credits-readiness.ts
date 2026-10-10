/**
 * How far a link has got towards running the DorkOS runtime on credits, for a
 * first run that waits on it (spec `one-minute-onboarding` §5.2).
 *
 * The answer is read from facts this server already holds: the link, the held
 * credits token, the models list it last read, the last mint's refusal and the
 * card fact from the last balance read under this link. The read itself never
 * waits on the network. While the first run is open and the link is made but
 * not `ready` yet, it starts the reads that can move it on (the models list, the
 * balance) in the background, at most once per {@link REFRESH_EVERY_MS}, so the
 * next poll sees their answer.
 *
 * @module services/core/cloud/credits-readiness
 */
import {
  BalanceSchema,
  V1_ROUTES,
  type InferenceModel,
  type InferenceToken,
} from '@dork-labs/cloud-api';
import type { CloudCreditsReadiness } from '@dorkos/shared/cloud-schemas';
import type { RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';
import { readCreditsSettings } from './credits-defaults.js';
import { creditsMintRefusal, heldCreditsToken } from './credits-inference.js';
import { creditsLinkKey, peekCreditsModelsFor, readCreditsCatalog } from './credits-models.js';
import { creditsFormatOf, creditsProtocolServed } from './credits-protocols.js';
import { isCloudLinked, readCloudInstanceToken, readOrNull } from './v1-client.js';

/** Every request format the DorkOS runtime can speak to the credits endpoint. */
export const DOE_CREDITS_PROTOCOLS: readonly RuntimeCreditsProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
];

/** How often a not-ready answer may start the background reads again. */
const REFRESH_EVERY_MS = 10_000;

/** What the readiness answer is read from. Injectable so every state is testable. */
export interface CreditsReadinessFacts {
  /** Whether this computer is linked. */
  linked: () => boolean;
  /** The live credits token, or `null`. */
  token: () => InferenceToken | null;
  /** The models list as last read, for one protocol. Never fetches. */
  models: (protocol: RuntimeCreditsProtocol) => readonly InferenceModel[];
  /** The problem code the last mint was refused with, or `null`. */
  mintRefusal: () => string | null;
  /**
   * Whether the account has a saved payment method: `false` only when the
   * service said so, `undefined` when it has not said or was not read.
   */
  paymentMethodOnFile: () => boolean | undefined;
  /**
   * Whether the first run's DorkOS path is still waiting for the new link to
   * record credits for the DorkOS runtime. Until it has, a first turn would not
   * run on them, so the answer is not `ready` yet.
   */
  awaitingFirstRunChoice: () => boolean;
}

/**
 * Whether one protocol is ready: the token serves it, and the list names a model
 * to start with in its format.
 */
function protocolReady(facts: CreditsReadinessFacts, protocol: RuntimeCreditsProtocol): boolean {
  const token = facts.token();
  if (token === null || !creditsProtocolServed(protocol, token)) return false;
  const format = creditsFormatOf(protocol);
  return facts.models(protocol).some((model) => model.recommendedOn?.includes(format) ?? false);
}

/**
 * The readiness answer for a set of facts. A missing card fact never blocks:
 * only the service saying `paymentMethodOnFile: false` reads as `needs-card`.
 *
 * @param facts - What the answer is read from.
 */
export function readinessFrom(facts: CreditsReadinessFacts): CloudCreditsReadiness {
  if (!facts.linked()) return 'unlinked';
  if (facts.mintRefusal() === 'entitlement_required') return 'refused';
  if (facts.paymentMethodOnFile() === false) return 'needs-card';
  if (facts.awaitingFirstRunChoice()) return 'linked';
  if (DOE_CREDITS_PROTOCOLS.some((protocol) => protocolReady(facts, protocol))) return 'ready';
  return 'linked';
}

/** What {@link creditsReadinessWith} reads and starts. Injectable so its timing is testable. */
export interface CreditsReadinessDeps {
  /** The readiness facts, minus the card fact this module remembers itself. */
  facts: Omit<CreditsReadinessFacts, 'paymentMethodOnFile'>;
  /** A one-way key for the current link, or `null` when unlinked. */
  linkKey: () => string | null;
  /** Whether the first run is still open (neither finished nor dismissed). */
  firstRunOpen: () => boolean;
  /** Read the models list again. */
  readCatalog: () => Promise<unknown>;
  /** Read the balance's card fact; `undefined` when the service did not say. */
  readCardOnFile: () => Promise<boolean | undefined>;
  /** The clock. */
  now: () => number;
}

/** The last card fact read, and the link it was read under. */
let card: { linkKey: string; onFile: boolean | undefined } | null = null;
let lastRefreshAt = Number.NEGATIVE_INFINITY;
let refreshing = false;

/**
 * Forget the remembered card fact and the refresh clock. Test seam only.
 *
 * @internal
 */
export function __resetCreditsReadinessForTests(): void {
  card = null;
  lastRefreshAt = Number.NEGATIVE_INFINITY;
  refreshing = false;
}

/**
 * Read the models list and the balance again, in the background. Failures are
 * logged without any response value and leave the last answers in place.
 */
function refreshInBackground(deps: CreditsReadinessDeps, linkKey: string): void {
  const now = deps.now();
  if (refreshing || now - lastRefreshAt < REFRESH_EVERY_MS) return;
  refreshing = true;
  lastRefreshAt = now;
  void Promise.all([
    deps.readCatalog().catch(() => null),
    deps.readCardOnFile().then((onFile) => {
      // Only for the link it was read under: an answer that lands after a
      // relink belongs to the other account.
      if (deps.linkKey() === linkKey) card = { linkKey, onFile };
    }),
  ])
    .catch((err: unknown) => {
      logger.debug('[credits] readiness refresh failed', { err: String(err) });
    })
    .finally(() => {
      refreshing = false;
    });
}

/**
 * The readiness answer, with the card fact remembered per link. Never waits on
 * the network. While the first run is open and the answer is not settled, it
 * starts the reads that can move it on, at most once per
 * {@link REFRESH_EVERY_MS}; a computer that finished its first run never pays
 * for a background read on a status poll.
 *
 * @param deps - What it reads and starts.
 */
export function creditsReadinessWith(deps: CreditsReadinessDeps): CloudCreditsReadiness {
  const linkKey = deps.linkKey();
  // Unlinked, or linked to another account: the card fact is no longer known.
  if (linkKey === null || card?.linkKey !== linkKey) card = null;
  const answer = readinessFrom({
    ...deps.facts,
    linked: () => linkKey !== null && deps.facts.linked(),
    paymentMethodOnFile: () => card?.onFile,
  });
  if (linkKey !== null && answer !== 'ready' && answer !== 'refused' && deps.firstRunOpen()) {
    refreshInBackground(deps, linkKey);
  }
  return answer;
}

/** The first-run section, read tolerantly. */
function onboarding() {
  return configManager.get('onboarding');
}

/**
 * The production readiness deps. Every member reads its module on the call
 * rather than at load, so a test that replaces one of those modules with a
 * partial mock can still import this one.
 */
const productionDeps: CreditsReadinessDeps = {
  facts: {
    linked: () => isCloudLinked(),
    token: () => heldCreditsToken(),
    models: (protocol) => peekCreditsModelsFor(protocol),
    mintRefusal: () => creditsMintRefusal(),
    awaitingFirstRunChoice: () => {
      const state = onboarding();
      return (
        state.firstRunPath === 'dorkos' &&
        state.completedAt === null &&
        state.dismissedAt === null &&
        readCreditsSettings().defaults.doe?.runsOn !== 'credits'
      );
    },
  },
  linkKey: () => {
    const token = isCloudLinked() ? readCloudInstanceToken() : null;
    return token ? creditsLinkKey(token) : null;
  },
  firstRunOpen: () => {
    const state = onboarding();
    return state.completedAt === null && state.dismissedAt === null;
  },
  readCatalog: () => readCreditsCatalog(),
  readCardOnFile: async () =>
    (await readOrNull((client) => client.get(V1_ROUTES.balance, BalanceSchema)))
      ?.paymentMethodOnFile,
  now: () => Date.now(),
};

/** This server's readiness answer for `GET /api/cloud/credits`. */
export function creditsReadiness(): CloudCreditsReadiness {
  return creditsReadinessWith(productionDeps);
}
