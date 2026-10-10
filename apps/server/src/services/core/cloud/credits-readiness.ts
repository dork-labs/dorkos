/**
 * How far a link has got towards running the DorkOS runtime on credits, for a
 * first run that waits on it (spec `one-minute-onboarding` §5.2).
 *
 * The answer is read from facts this server already holds: the link, the held
 * credits token, the models list it last read, the last mint's refusal and the
 * last balance it read. The read itself never waits on the network. When the
 * link is made but the answer is not `ready` yet, it starts the reads that can
 * move it on (the models list, the balance) in the background, at most once per
 * {@link REFRESH_EVERY_MS}, so the next poll sees their answer.
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
import { peekCreditsModelsFor, readCreditsCatalog } from './credits-models.js';
import { creditsFormatOf, creditsProtocolServed } from './credits-protocols.js';
import { isCloudLinked, readOrNull } from './v1-client.js';

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

/** The last balance answer's card fact, and when the balance was last asked. */
let cardOnFile: boolean | undefined;
let lastRefreshAt = 0;
let refreshing = false;

/**
 * Forget the remembered card fact and the refresh clock. Test seam only.
 *
 * @internal
 */
export function __resetCreditsReadinessForTests(): void {
  cardOnFile = undefined;
  lastRefreshAt = 0;
  refreshing = false;
}

/**
 * Read the models list and the balance again, in the background. Failures are
 * logged without any response value and leave the last answers in place.
 */
function refreshInBackground(now: number): void {
  if (refreshing || now - lastRefreshAt < REFRESH_EVERY_MS) return;
  refreshing = true;
  lastRefreshAt = now;
  void Promise.all([
    readCreditsCatalog().catch(() => null),
    readOrNull((client) => client.get(V1_ROUTES.balance, BalanceSchema)).then((balance) => {
      if (balance === null) return;
      // `paymentMethodOnFile` is a newer optional field of the balance
      // (`@dork-labs/cloud-api`). Read without assuming the parsed shape
      // carries it: absent means unknown, and unknown never blocks.
      const fact = (balance as { paymentMethodOnFile?: unknown }).paymentMethodOnFile;
      cardOnFile = typeof fact === 'boolean' ? fact : undefined;
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
 * This server's readiness answer for `GET /api/cloud/credits`. Never waits on
 * the network; starts the background reads when linked and not ready yet.
 */
export function creditsReadiness(): CloudCreditsReadiness {
  const linked = isCloudLinked();
  if (!linked) {
    cardOnFile = undefined;
    return 'unlinked';
  }
  const answer = readinessFrom({
    linked: () => linked,
    token: heldCreditsToken,
    models: peekCreditsModelsFor,
    mintRefusal: creditsMintRefusal,
    paymentMethodOnFile: () => cardOnFile,
    awaitingFirstRunChoice: () => {
      const onboarding = configManager.get('onboarding');
      return (
        onboarding.firstRunPath === 'dorkos' &&
        onboarding.completedAt === null &&
        readCreditsSettings().defaults.doe?.runsOn !== 'credits'
      );
    },
  });
  if (answer !== 'ready' && answer !== 'refused') refreshInBackground(Date.now());
  return answer;
}
