/**
 * The models DorkOS credits serve, as a runtime on credits may offer them
 * (spec `dorkos-account-by-default` §1, DOR-2636).
 *
 * The list is the service's own: `GET /v1/inference/models` names every model
 * the account may route to, with the protocols each one is offered on and the
 * one the service suggests starting with. Nothing here invents a model, names
 * one, or keeps a local list: a model credits do not serve is never offered,
 * and nothing is offered while the list cannot be read.
 *
 * ## Filtered by protocol, never by runtime
 *
 * A runtime declares the protocol it speaks to the credits endpoint
 * (`RuntimeCapabilities.credits.protocol`), and a model is offered to it only
 * when the service lists that protocol for the model. So Claude Code, which
 * speaks `anthropic-messages`, never sees a model the service offers only on
 * `openai-chat`. A runtime that joins credits later brings its protocol and
 * gets its list with no change here.
 *
 * ## Fail honest
 *
 * {@link readCreditsCatalog} answers `null` when the list cannot be had (not
 * linked, credits switched off, the service unreachable or answering something
 * that does not parse). The model menu then says the models could not be
 * loaded and keeps the runtime's default; the model gate refuses every model,
 * because a choice it cannot check against the service's list is a choice it
 * cannot honour.
 *
 * @module services/core/cloud/credits-models
 */
import {
  InferenceModelsResponseSchema,
  V1_ROUTES,
  type InferenceModel,
} from '@dork-labs/cloud-api';
import { CloudApiResponseError } from '@dork-labs/cloud-api/client';
import type { RuntimeCapabilities, RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import type { ModelOption } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { creditsKilled } from './credits-availability.js';
import { captureCloudV1Context, problemOf, type CloudV1Context } from './v1-client.js';

/** How long a read list is reused before the service is asked again. */
const CATALOG_TTL_MS = 5 * 60_000;
/** How long one read may take before the list counts as unavailable. */
const CATALOG_WAIT_MS = 5_000;

/** The last list read, kept only while the link it was read under stands. */
let cached: { models: InferenceModel[]; readAt: number; isCurrent: () => boolean } | null = null;
/** The one read in flight, shared by every caller that arrives while it runs. */
let inflight: Promise<InferenceModel[] | null> | null = null;
/** Injectable clock so the cache window is testable without waiting. */
let now: () => number = () => Date.now();

/**
 * Forget the cached list and swap the clock. Test seam only.
 *
 * @param opts - An optional clock.
 * @internal
 */
export function __resetCreditsModelsForTests(opts: { now?: () => number } = {}): void {
  cached = null;
  inflight = null;
  now = opts.now ?? (() => Date.now());
}

/**
 * Read the list under one captured link context. Testable core of
 * {@link readCreditsCatalog}, which supplies the kill switch and the context.
 *
 * @param killed - Whether the kill switch is on.
 * @param context - The captured link context, or `null` when unlinked.
 * @returns Every model the service lists, or `null` when the list cannot be had.
 * @internal
 */
export async function readCreditsCatalogWithContext(
  killed: boolean,
  context: CloudV1Context | null
): Promise<InferenceModel[] | null> {
  if (killed || context === null) return null;
  if (cached && cached.isCurrent() && now() - cached.readAt < CATALOG_TTL_MS) {
    return cached.models;
  }
  if (inflight) return inflight;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_WAIT_MS);
  timer.unref?.();
  const attempt = (async () => {
    try {
      const body = await context.client.get(
        V1_ROUTES.inferenceModels,
        InferenceModelsResponseSchema,
        { signal: controller.signal }
      );
      // A list read under a link that changed while it was in flight belongs
      // to nobody, so it is neither kept nor answered.
      if (!context.isCurrent()) return null;
      cached = { models: body.models, readAt: now(), isCurrent: context.isCurrent };
      return body.models;
    } catch (error) {
      // Status and code only: a schema error can quote what the service sent.
      logger.warn('[Cloud] Could not read the models DorkOS credits serve', {
        status:
          problemOf(error)?.status ??
          (error instanceof CloudApiResponseError ? error.status : null),
        code: problemOf(error)?.code,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight = attempt;
  try {
    return await attempt;
  } finally {
    if (inflight === attempt) inflight = null;
  }
}

/**
 * Every model the service lists for this account, or `null` when the list
 * cannot be had right now. Never throws.
 */
export function readCreditsCatalog(): Promise<InferenceModel[] | null> {
  return readCreditsCatalogWithContext(creditsKilled(), captureCloudV1Context());
}

/**
 * The service's models as one runtime's menu: only those offered on the
 * protocol it speaks, the recommended one first and marked as the default.
 * Pure, so the filter is testable without a service.
 *
 * Names and context sizes are the service's own. A model the service says
 * cannot use tools keeps `supportsToolUse: false`, so the menu warns before
 * the pick. Effort and fast mode are left unclaimed: the list says nothing
 * about either, and a control for a setting nobody confirmed is worse than
 * none.
 *
 * @param models - The service's list.
 * @param protocol - The protocol the runtime speaks to the credits endpoint.
 */
export function creditsModelOptions(
  models: readonly InferenceModel[],
  protocol: RuntimeCreditsProtocol
): ModelOption[] {
  const offered = models.filter((model) => model.protocols?.includes(protocol) ?? false);
  const recommended = offered.find((model) => model.recommendedOn?.includes(protocol) ?? false);
  const ordered = recommended
    ? [recommended, ...offered.filter((model) => model !== recommended)]
    : offered;
  return ordered.map((model) => ({
    value: model.id,
    displayName: model.displayName,
    description:
      model === recommended ? 'Recommended · Paid from DorkOS credits' : 'Paid from DorkOS credits',
    ...(model === recommended ? { isDefault: true } : {}),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsToolUse: model.supports.tools,
    supportsStreaming: model.supports.streaming,
  }));
}

/**
 * The menu a runtime on credits offers, or `null` when the service's list
 * cannot be had. A runtime that declares no credits protocol has nothing to
 * offer on credits, so its menu is empty.
 *
 * @param capabilities - The runtime's declared capabilities.
 */
export async function creditsModelsFor(
  capabilities: Pick<RuntimeCapabilities, 'credits'>
): Promise<ModelOption[] | null> {
  const protocol = capabilities.credits?.protocol;
  if (protocol === undefined) return [];
  const models = await readCreditsCatalog();
  return models === null ? null : creditsModelOptions(models, protocol);
}

/**
 * The model a launch on credits starts with when nobody chose one: the
 * service's suggestion for the runtime's protocol, or `null` when the service
 * suggests none or the list cannot be had (the runtime's own default then
 * stands).
 *
 * @param capabilities - The launching runtime's declared capabilities.
 */
export async function recommendedCreditsModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>
): Promise<string | null> {
  const options = await creditsModelsFor(capabilities);
  return options?.find((option) => option.isDefault)?.value ?? null;
}

/**
 * Whether a session on credits may be set to a model, as the sentence to
 * refuse with, or `null` when credits serve it on this runtime's protocol.
 *
 * Fails closed: while the service's list cannot be read, every model is
 * refused, because a choice that cannot be checked against what credits serve
 * cannot be promised to run.
 *
 * @param capabilities - The session's runtime's declared capabilities.
 * @param model - The model id the request asks to store.
 */
export async function rejectNonCreditsModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  model: string
): Promise<string | null> {
  const options = await creditsModelsFor(capabilities);
  if (options === null) {
    return "Couldn't load the models DorkOS credits cover, so the model wasn't changed. Try again.";
  }
  if (options.some((option) => option.value === model)) return null;
  return "DorkOS credits don't cover that model. Pick one from the model menu.";
}
