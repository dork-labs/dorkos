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
 * ## Only once the service says, and never worse than before
 *
 * A service older than the `protocols` field lists models without saying
 * which protocol each is on. Then nothing here changes anything: a runtime on
 * credits keeps its own menu, catalog check and default, exactly as before
 * this module existed ({@link CreditsMenu} `unfiltered`). Once the service
 * says, the list decides. The last list it answered is kept on disk under the
 * link it was read under, so a failed read (now, or after a restart) answers
 * that list, marked out of date, rather than reopening or closing the menu.
 * With no list ever read, the answer is today's behaviour.
 *
 * @module services/core/cloud/credits-models
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  InferenceModelsResponseSchema,
  V1_ROUTES,
  type InferenceModel,
} from '@dork-labs/cloud-api';
import { CloudApiResponseError } from '@dork-labs/cloud-api/client';
import type { RuntimeCapabilities, RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import type { ModelOption } from '@dorkos/shared/types';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { creditsKilled } from './credits-availability.js';
import {
  captureCloudV1Context,
  problemOf,
  readCloudInstanceToken,
  type CloudV1Context,
} from './v1-client.js';

/** How long a read list is reused before the service is asked again. */
const CATALOG_TTL_MS = 5 * 60_000;
/**
 * How old the last good list may be and still stand in for the service. Past
 * this, a failed read answers as though no list was ever read: today's
 * behaviour, never a stale menu that could refuse a model credits now serve.
 */
const LAST_GOOD_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** How long one read may take before the last good list stands in. */
const CATALOG_WAIT_MS = 5_000;

/**
 * The last list the service answered under one link, as kept in memory and on
 * disk (`<dorkHome>/cache/cloud/credits-models.json`). `linkKey` is a one-way
 * fingerprint of the link credential the list was read under, never the
 * credential, so a relink to another account never reuses another account's list.
 */
interface LastGoodList {
  linkKey: string;
  models: InferenceModel[];
  savedAt: string;
}

/** What one read answers: the list, and whether it came from the service just now. */
export interface CreditsCatalogRead {
  /** Every model the list names. */
  models: InferenceModel[];
  /** False when the service could not be read and this is the last good list. */
  fresh: boolean;
}

/** The list read last, while the link it was read under stands. */
let cached: { models: InferenceModel[]; readAt: number; isCurrent: () => boolean } | null = null;
/** The last good list, in memory (`undefined` until the disk copy was looked for). */
let lastGood: LastGoodList | null | undefined;
/** The one read in flight, shared by every caller that arrives while it runs. */
let inflight: Promise<CreditsCatalogRead | null> | null = null;
/** Injectable clock so the cache window is testable without waiting. */
let now: () => number = () => Date.now();
/** Where the last good list is kept; swappable in tests. */
let storePath: () => string = () =>
  path.join(resolveDorkHome(), 'cache', 'cloud', 'credits-models.json');

/**
 * Forget the cached list (in memory only), and swap the clock or the store.
 * Test seam only: a test that wants a "restart" calls this and keeps the store.
 *
 * @param opts - An optional clock and store path.
 * @internal
 */
export function __resetCreditsModelsForTests(
  opts: { now?: () => number; storePath?: string } = {}
): void {
  cached = null;
  inflight = null;
  lastGood = undefined;
  now = opts.now ?? (() => Date.now());
  if (opts.storePath !== undefined) {
    const where = opts.storePath;
    storePath = () => where;
  }
}

/** Whether a list says which protocols any of its models are on. */
function saysProtocols(models: readonly InferenceModel[]): boolean {
  return models.some((model) => model.protocols !== undefined);
}

/**
 * A one-way fingerprint of a link credential: enough to tell two links apart,
 * nothing that could be used as one.
 *
 * @param token - The link credential.
 */
export function creditsLinkKey(token: string): string {
  return createHash('sha256').update(`dorkos-credits-models:${token}`).digest('hex').slice(0, 32);
}

/** The last good list for this link, from memory or disk, or `null`. */
function lastGoodFor(linkKey: string): InferenceModel[] | null {
  if (lastGood === undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<LastGoodList>;
      const parsed = InferenceModelsResponseSchema.shape.models.safeParse(raw.models);
      lastGood =
        typeof raw.linkKey === 'string' && parsed.success
          ? { linkKey: raw.linkKey, models: parsed.data, savedAt: String(raw.savedAt ?? '') }
          : null;
    } catch {
      lastGood = null;
    }
  }
  if (!lastGood || lastGood.linkKey !== linkKey) return null;
  // Too old to stand in for the service: a list from last month says less
  // about what credits serve today than no list at all.
  const savedAt = Date.parse(lastGood.savedAt);
  if (Number.isNaN(savedAt) || now() - savedAt > LAST_GOOD_MAX_AGE_MS) return null;
  return lastGood.models;
}

/** Keep a fresh list as the last good one, in memory and on disk. Best effort. */
function keepLastGood(linkKey: string, models: InferenceModel[]): void {
  lastGood = { linkKey, models, savedAt: new Date(now()).toISOString() };
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(lastGood), 'utf8');
  } catch (error) {
    logger.warn('[Cloud] Could not keep the credits model list', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Read the list under one captured link context. Testable core of
 * {@link readCreditsCatalog}, which supplies the kill switch, the context and
 * the link's fingerprint.
 *
 * A list the service answers is kept as the last good one, on disk, so a
 * failed read (here or after a restart) answers that list with `fresh: false`
 * rather than nothing: once the service has said which protocols its models
 * are on, the answer stays the same across an outage and a restart.
 *
 * @param killed - Whether the kill switch is on.
 * @param context - The captured link context, or `null` when unlinked.
 * @param linkKey - The link's fingerprint ({@link creditsLinkKey}), or `null` when unlinked.
 * @returns The list, or `null` when there is none to be had.
 * @internal
 */
export async function readCreditsCatalogWithContext(
  killed: boolean,
  context: CloudV1Context | null,
  linkKey: string | null
): Promise<CreditsCatalogRead | null> {
  if (killed || context === null || linkKey === null) return null;
  if (cached && cached.isCurrent() && now() - cached.readAt < CATALOG_TTL_MS) {
    return { models: cached.models, fresh: true };
  }
  if (inflight) return inflight;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_WAIT_MS);
  timer.unref?.();
  const attempt = (async (): Promise<CreditsCatalogRead | null> => {
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
      keepLastGood(linkKey, body.models);
      return { models: body.models, fresh: true };
    } catch (error) {
      // Status and code only: a schema error can quote what the service sent.
      logger.warn('[Cloud] Could not read the models DorkOS credits serve', {
        status:
          problemOf(error)?.status ??
          (error instanceof CloudApiResponseError ? error.status : null),
        code: problemOf(error)?.code,
      });
      if (!context.isCurrent()) return null;
      const kept = lastGoodFor(linkKey);
      return kept ? { models: kept, fresh: false } : null;
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
 * The service's list for this account, the last good one when the service
 * cannot be read, or `null` when there is neither. Never throws.
 */
export function readCreditsCatalog(): Promise<CreditsCatalogRead | null> {
  const token = readCloudInstanceToken();
  return readCreditsCatalogWithContext(
    creditsKilled(),
    captureCloudV1Context(),
    token ? creditsLinkKey(token) : null
  );
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
 * none. The description stays short (`Recommended`, or nothing), because the
 * menu's own heading already says these are the models credits cover.
 *
 * @param models - The service's list.
 * @param protocol - The protocol the runtime speaks to the credits endpoint.
 * @param opts - `outOfDate` when the list is the last good one, not a fresh read.
 */
export function creditsModelOptions(
  models: readonly InferenceModel[],
  protocol: RuntimeCreditsProtocol,
  opts: { outOfDate?: boolean } = {}
): ModelOption[] {
  const offered = models.filter((model) => model.protocols?.includes(protocol) ?? false);
  const recommended = offered.find((model) => model.recommendedOn?.includes(protocol) ?? false);
  const ordered = recommended
    ? [recommended, ...offered.filter((model) => model !== recommended)]
    : offered;
  return ordered.map((model) => ({
    value: model.id,
    displayName: model.displayName,
    description: model === recommended ? 'Recommended' : '',
    ...(model === recommended ? { isDefault: true } : {}),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsToolUse: model.supports.tools,
    supportsStreaming: model.supports.streaming,
    paidFromCredits: true,
    ...(opts.outOfDate ? { creditsListOutOfDate: true } : {}),
  }));
}

/**
 * What a runtime on credits is offered, by what the service has said.
 *
 * - `filtered` — the service says which protocols its models are on, so the
 *   menu is exactly the models credits serve on the runtime's protocol.
 *   `outOfDate` when the service could not be read just now and this is the
 *   last good list it answered (kept across a restart).
 * - `unfiltered` — the service says nothing about protocols (a service older
 *   than the `protocols` field), or there is no list at all: never read, and
 *   nothing kept. Everything behaves as it did before credits had a menu: the
 *   runtime's own models, its own catalog check, its own default. A filter the
 *   service has never asked for must never take a model away.
 */
export type CreditsMenu =
  { kind: 'filtered'; models: ModelOption[]; outOfDate: boolean } | { kind: 'unfiltered' };

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
  const read = await readCreditsCatalog();
  if (read === null || !saysProtocols(read.models)) return { kind: 'unfiltered' };
  const outOfDate = !read.fresh;
  return {
    kind: 'filtered',
    models: creditsModelOptions(read.models, protocol, { outOfDate }),
    outOfDate,
  };
}

/** Whether a menu serves a model, by its id or by any id it is also known as. */
function serves(models: readonly ModelOption[], ids: readonly (string | undefined)[]): boolean {
  const wanted = ids.flatMap((id) => (id === undefined ? [] : [baseModelId(id)]));
  return models.some((option) => wanted.includes(baseModelId(option.value)));
}

/**
 * A model id without the bracketed variant marker a runtime's catalog may
 * append (`claude-opus-5-5[1m]`, the one-million-token context variant of
 * `claude-opus-5-5`). The marker selects a context window, not a model, so
 * credits that serve the model serve it.
 *
 * @param id - A model id as a catalog or the service names it.
 */
export function baseModelId(id: string): string {
  return id.replace(/(?:\[[^\]]*\])+$/, '');
}

/** What {@link resolveCreditsLaunchModel} answers. */
export type CreditsLaunchModel =
  /** The service says nothing about protocols, or the model is served: as named. */
  | { kind: 'as-named'; model: string | undefined }
  /** No model was named: the service's suggestion. */
  | { kind: 'suggested'; model: string }
  /** The named model is not served: the suggestion runs instead, and both are named. */
  | { kind: 'replaced'; model: string; from: string; toName: string }
  /** The service says which protocols its models are on, and none is on this one. */
  | { kind: 'none-served' };

/**
 * The model a launch on credits runs (spec `dorkos-account-by-default` §1,
 * DOR-2636).
 *
 * Only once the service says which protocols its models are on: a session
 * with no model starts on the service's suggestion, and one whose model
 * credits do not serve (pinned on an agent, a schedule or the runtime's
 * default before it ran on credits) runs on the suggestion instead. A model is
 * served when its own id or the id it resolves to (`resolvedModel`, for a
 * Claude Code alias such as `sonnet`) is on the list, so an alias that names a
 * served model is never replaced. When the list names no model at all on the
 * runtime's protocol, the answer is `none-served`, which the launch refuses
 * plainly rather than sending a request that cannot succeed.
 *
 * @param capabilities - The launching runtime's declared capabilities.
 * @param model - The model the session names, if any.
 * @param resolvedModel - The id that model expands to, when the runtime knows.
 */
export async function resolveCreditsLaunchModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  model: string | undefined,
  resolvedModel?: string
): Promise<CreditsLaunchModel> {
  const menu = await creditsMenuFor(capabilities);
  if (menu.kind !== 'filtered') return { kind: 'as-named', model };
  if (menu.models.length === 0) return { kind: 'none-served' };
  if (model !== undefined && serves(menu.models, [model, resolvedModel])) {
    return { kind: 'as-named', model };
  }
  const pick = menu.models.find((option) => option.isDefault) ?? menu.models[0]!;
  if (model === undefined) return { kind: 'suggested', model: pick.value };
  return { kind: 'replaced', model: pick.value, from: model, toName: pick.displayName };
}

/** How the credits list judged a model; see {@link judgeCreditsModel}. */
export type CreditsModelVerdict = { judged: false } | { judged: true; refusal: string | null };

/**
 * Whether a session, agent or schedule on credits may be set to a model.
 *
 * `judged: false` while the service says nothing about protocols (or there is
 * no list at all): the caller then judges exactly as it did before (the
 * runtime's own catalog, or no check at all). Once the service has said, the
 * list convicts: a model it does not list on the runtime's protocol, under its
 * own id or the one it resolves to, is refused. A list that could not be
 * refreshed still judges, from the last good copy.
 *
 * @param capabilities - The runtime's declared capabilities.
 * @param model - The model id the request asks to store.
 * @param resolvedModel - The id that model expands to, when the runtime knows.
 */
export async function judgeCreditsModel(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  model: string,
  resolvedModel?: string
): Promise<CreditsModelVerdict> {
  const menu = await creditsMenuFor(capabilities);
  if (menu.kind === 'unfiltered') return { judged: false };
  return {
    judged: true,
    refusal: serves(menu.models, [model, resolvedModel])
      ? null
      : 'DorkOS credits don’t cover that model. Pick one from the model menu.',
  };
}
