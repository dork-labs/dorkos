/**
 * The models DorkOS credits serve, as a runtime on credits may offer them
 * (spec `dorkos-account-by-default` §1, DOR-2636).
 *
 * The list is the service's own: `GET /v1/inference/models` names every model
 * the account may route to, with the protocols each one is offered on and the
 * one the service suggests starting with. Nothing here invents a model, names
 * one, or keeps a local list: once the service says which protocols its
 * models are on, a model credits do not serve there is never offered.
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
 * ## Only once the service says, and fail honest
 *
 * A service older than the `protocols` field lists models without saying
 * which protocol each is on. Then nothing here changes anything: a runtime on
 * credits keeps its own menu, catalog check and default, exactly as before
 * this module existed ({@link CreditsMenu} `unfiltered`). Once the service
 * says, the list decides, and a list that cannot be read then is
 * `unavailable`: the menu says the models could not be loaded and keeps the
 * session's model, and the model gate refuses, because offering the runtime's
 * own models would offer models credits are known not to serve.
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
/**
 * Whether the last list the service answered said which protocols its models
 * are on. Kept past a failed read, so an outage after the service has said
 * does not quietly reopen the runtime's whole menu.
 */
let serviceSaidProtocols = false;
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
  serviceSaidProtocols = false;
  now = opts.now ?? (() => Date.now());
}

/** Whether a list says which protocols any of its models are on. */
function saysProtocols(models: readonly InferenceModel[]): boolean {
  return models.some((model) => model.protocols !== undefined);
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
      serviceSaidProtocols = saysProtocols(body.models);
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
    paidFromCredits: true,
  }));
}

/**
 * What a runtime on credits is offered, by what the service has said.
 *
 * - `filtered` — the service says which protocols its models are on, so the
 *   menu is exactly the models credits serve on the runtime's protocol.
 * - `unfiltered` — the service says nothing about protocols (a service older
 *   than the `protocols` field), or nothing has been said yet and the list
 *   cannot be read. Everything behaves as it did before credits had a menu:
 *   the runtime's own models, its own catalog check, its own default. A
 *   filter the service has never asked for must never take a model away.
 * - `unavailable` — the service HAS said which protocols its models are on,
 *   and the list cannot be read now. Offering the runtime's own models then
 *   would offer models credits are known not to serve.
 */
export type CreditsMenu =
  { kind: 'filtered'; models: ModelOption[] } | { kind: 'unfiltered' } | { kind: 'unavailable' };

/**
 * The menu a runtime on credits is offered; see {@link CreditsMenu}.
 *
 * @param capabilities - The runtime's declared capabilities.
 */
export async function creditsMenuFor(
  capabilities: Pick<RuntimeCapabilities, 'credits'>
): Promise<CreditsMenu> {
  const protocol = capabilities.credits?.protocol;
  if (protocol === undefined) return { kind: 'unfiltered' };
  const models = await readCreditsCatalog();
  if (models === null)
    return serviceSaidProtocols ? { kind: 'unavailable' } : { kind: 'unfiltered' };
  if (!saysProtocols(models)) return { kind: 'unfiltered' };
  return { kind: 'filtered', models: creditsModelOptions(models, protocol) };
}

/**
 * The model a launch on credits runs, and whether it had to replace the one
 * the session named (spec `dorkos-account-by-default` §1, DOR-2636).
 *
 * Only when the service says which protocols its models are on: a session
 * with no model starts on the service's suggestion, and one whose model
 * credits do not serve (pinned on an agent, a schedule or the runtime's
 * default before it ran on credits) runs on the suggestion instead, with
 * `replaced` naming both so the person is told. Never a failed launch over a
 * model, and never a change while the service says nothing about protocols.
 *
 * @param capabilities - The launching runtime's declared capabilities.
 * @param model - The model the session names, if any.
 */
export async function resolveCreditsLaunchModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  model: string | undefined
): Promise<{ model: string | undefined; replaced?: { from: string; to: string } }> {
  const menu = await creditsMenuFor(capabilities);
  if (menu.kind !== 'filtered') return { model };
  if (model !== undefined && menu.models.some((option) => option.value === model)) {
    return { model };
  }
  const pick = menu.models.find((option) => option.isDefault) ?? menu.models[0];
  if (!pick) return { model };
  if (model === undefined) return { model: pick.value };
  return { model: pick.value, replaced: { from: model, to: pick.displayName } };
}

/** How the credits list judged a model; see {@link judgeCreditsModel}. */
export type CreditsModelVerdict = { judged: false } | { judged: true; refusal: string | null };

/**
 * Whether a session, agent or schedule on credits may be set to a model.
 *
 * `judged: false` while the service says nothing about protocols: the caller
 * then judges exactly as it did before (the runtime's own catalog, or no
 * check at all). Once the service has said, the list convicts: a model it
 * does not list on the runtime's protocol is refused, and so is every model
 * while the list cannot be read.
 *
 * @param capabilities - The runtime's declared capabilities.
 * @param model - The model id the request asks to store.
 */
export async function judgeCreditsModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  model: string
): Promise<CreditsModelVerdict> {
  const menu = await creditsMenuFor(capabilities);
  if (menu.kind === 'unfiltered') return { judged: false };
  if (menu.kind === 'unavailable') {
    return {
      judged: true,
      refusal:
        "Couldn't load the models DorkOS credits cover, so the model wasn't changed. Try again.",
    };
  }
  return {
    judged: true,
    refusal: menu.models.some((option) => option.value === model)
      ? null
      : "DorkOS credits don't cover that model. Pick one from the model menu.",
  };
}
