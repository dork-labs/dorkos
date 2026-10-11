/**
 * DorkOS picks the model (DOR-2784, ADR 261010-143211).
 *
 * With `runtimes.doe.inference: null` and the chat on DorkOS credits, nobody
 * typed a model, endpoint or limit, and none is needed: the credits catalog
 * already names the model it suggests for each request format
 * (`recommendedOn`). This module turns that into the chat's frozen inference,
 * and into the model list and readiness that describe it.
 *
 * One rule, three readers:
 *
 * - the first turn ({@link chooseDoeCreditsInference}), which may wait for a
 *   token and read the catalog;
 * - readiness ({@link peekDoeCreditsPick}), which never makes a request;
 * - the model list ({@link listDoeCreditsModels}), which reads the catalog
 *   the way every credits menu does.
 *
 * Formats are tried in {@link DOE_CREDITS_PREFERENCE} order, only those the
 * held token serves, and the first with a recommended model wins. No match is
 * a refusal, never another payer.
 *
 * @module services/runtimes/doe/auto-model
 */
import type { InferenceModel, InferenceToken } from '@dork-labs/cloud-api';
import type { RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { DoeInferenceConfigSchema, type DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { ModelOption } from '@dorkos/shared/types';
import { CHOSEN_BY_DORKOS } from '@dorkos/shared/runtime-connect';
import { creditsKilled } from '../../core/cloud/credits-availability.js';
import { readCreditsSettings } from '../../core/cloud/credits-defaults.js';
import { awaitCreditsToken, heldCreditsToken } from '../../core/cloud/credits-inference.js';
import {
  baseModelId,
  creditsModelOptions,
  creditsModelsFor,
  peekCreditsModelsFor,
  resolveCreditsLaunchModel,
} from '../../core/cloud/credits-models.js';
import {
  CreditsUnavailableError,
  creditsEndpointFor,
  creditsFormatOf,
  creditsProtocolServed,
} from '../../core/cloud/credits-protocols.js';
import { isCloudLinked } from '../../core/cloud/v1-client.js';
import { DOE_CREDITS_SUPPORT } from './credentials.js';

/** The request formats DorkOS tries, best first, when it picks a chat's model. */
export const DOE_CREDITS_PREFERENCE: readonly RuntimeCreditsProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
];

/** The runtime's name in a credits refusal. */
const RUNTIME_LABEL = 'DorkOS';

/** One pick: the format a chat speaks and the catalog model it runs. */
export interface DoeCreditsPick {
  protocol: RuntimeCreditsProtocol;
  model: InferenceModel;
}

/** The formats a token serves, in preference order. `null` serves the Anthropic format only. */
function servedProtocols(token: InferenceToken | null): RuntimeCreditsProtocol[] {
  return DOE_CREDITS_PREFERENCE.filter((protocol) => creditsProtocolServed(protocol, token));
}

/** The model a format's list recommends, if any. */
function recommendedIn(
  models: readonly InferenceModel[],
  protocol: RuntimeCreditsProtocol
): InferenceModel | undefined {
  const format = creditsFormatOf(protocol);
  return models.find((model) => model.recommendedOn?.includes(format) ?? false);
}

/** Read-only ports for {@link peekDoeCreditsPick}. */
export interface DoeCreditsPeekDeps {
  linked?: () => boolean;
  token?: () => InferenceToken | null;
  models?: (protocol: RuntimeCreditsProtocol) => readonly InferenceModel[];
}

/**
 * The model DorkOS would pick right now, from what this server already holds:
 * the live token and the cached catalog. Never mints, never fetches, so
 * readiness can ask it on every poll.
 *
 * @param deps - Injectable link, token and catalog reads.
 * @returns The pick, or `null` when there is no link or no recommended model.
 */
export function peekDoeCreditsPick(deps: DoeCreditsPeekDeps = {}): DoeCreditsPick | null {
  if (!(deps.linked ?? isCloudLinked)()) return null;
  // No token yet (offline boot) reads like the model list: Anthropic only.
  const token = (deps.token ?? heldCreditsToken)();
  const modelsFor = deps.models ?? peekCreditsModelsFor;
  for (const protocol of servedProtocols(token)) {
    const model = recommendedIn(modelsFor(protocol), protocol);
    if (model) return { protocol, model };
  }
  return null;
}

/**
 * Whether new DorkOS chats run on credits by default. Config only, no request.
 * Agents allowed onto credits do not count: that list spans every runtime, so
 * a Claude Code agent on credits says nothing about DorkOS.
 */
export function doeCreditsInUse(): boolean {
  return readCreditsSettings().defaults.doe?.runsOn === 'credits';
}

/** Ports for {@link doeCreditsReady}. */
export interface DoeCreditsReadyDeps extends DoeCreditsPeekDeps {
  inUse?: () => boolean;
}

/**
 * Whether a DorkOS chat with nothing configured can run on credits, for
 * readiness: credits in use, the computer linked, and either a model to pick
 * or nothing read yet to decide by. An offline boot holds no token, and a
 * fresh token can arrive before the catalog does; the first turn reads both
 * and decides then, so readiness does not call either "missing".
 *
 * @param deps - Injectable reads.
 */
export function doeCreditsReady(deps: DoeCreditsReadyDeps = {}): boolean {
  if (!(deps.inUse ?? doeCreditsInUse)()) return false;
  if (!(deps.linked ?? isCloudLinked)()) return false;
  const token = (deps.token ?? heldCreditsToken)();
  if (token === null) return true;
  if (peekDoeCreditsPick(deps) !== null) return true;
  const modelsFor = deps.models ?? peekCreditsModelsFor;
  return servedProtocols(token).every((protocol) => modelsFor(protocol).length === 0);
}

/** Ports for {@link chooseDoeCreditsInference}; each defaults to the real one. */
export interface DoeCreditsChoiceDeps {
  /** A live token, or the refusal that explains why there is none. */
  token?: () => Promise<InferenceToken>;
  /** The catalog's models in one format. */
  models?: (protocol: RuntimeCreditsProtocol) => Promise<readonly InferenceModel[]>;
  /** Whether credits serve a named model in one format (the shared launch rule). */
  launchModel?: typeof resolveCreditsLaunchModel;
}

/** A chat's frozen credits inference, and the model it replaced, if any. */
export interface DoeCreditsChoice {
  inference: DoeInferenceConfig;
  /** Set when the chat named a model credits do not serve. */
  replaced?: { from: string; fromName: string; toName: string };
}

/** A live token, or the refusal a credits launch would give. */
async function liveCreditsToken(): Promise<InferenceToken> {
  if (creditsKilled()) throw new CreditsUnavailableError('off', RUNTIME_LABEL);
  if (!isCloudLinked()) throw new CreditsUnavailableError('not-linked', RUNTIME_LABEL);
  const token = (await awaitCreditsToken()) ? heldCreditsToken() : null;
  if (token === null) throw new CreditsUnavailableError('unreachable', RUNTIME_LABEL);
  return token;
}

/** The frozen record for one format and catalog model. */
function frozenFor(
  token: InferenceToken,
  protocol: RuntimeCreditsProtocol,
  model: InferenceModel
): DoeInferenceConfig {
  return DoeInferenceConfigSchema.parse({
    source: 'dorkos-credits',
    provider: 'dorkos',
    protocol,
    endpoint: creditsEndpointFor(token.endpoints, protocol),
    model: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  });
}

/**
 * The inference a chat on credits freezes at its first turn when nothing is
 * configured.
 *
 * `candidates` are the models the chat already names, best first: its own
 * model, its agent's, then `runtimes.doe.defaultModel`. The first one credits
 * serve wins, in the first served format that serves it, by the same rule
 * every credits launch uses; when that is not the first candidate,
 * `replaced` names the one it stands in for. Matched by base id, so a variant marker
 * (`[1m]`) still finds its model, and the frozen id is always the catalog's.
 * With none served, the catalog's recommended model in the first served format
 * runs; when it stands in for a named model, `replaced` says so, so the turn
 * can tell the person.
 *
 * @param candidates - The models the chat names, best first; may be empty.
 * @param deps - Injectable token, catalog and launch-rule ports.
 * @throws {CreditsUnavailableError} When credits cannot pay (`off`, `not-linked`,
 *   `unreachable`) or no served format has a model (`no-models`).
 */
export async function chooseDoeCreditsInference(
  candidates: readonly string[],
  deps: DoeCreditsChoiceDeps = {}
): Promise<DoeCreditsChoice> {
  const token = await (deps.token ?? liveCreditsToken)();
  const modelsFor = deps.models ?? creditsModelsFor;
  const launchModel = deps.launchModel ?? resolveCreditsLaunchModel;
  const protocols = servedProtocols(token);
  const from = candidates[0];
  for (const [index, requested] of candidates.entries()) {
    for (const protocol of protocols) {
      const verdict = await launchModel(
        { credits: { ...DOE_CREDITS_SUPPORT, protocol } },
        requested
      );
      if (verdict.kind !== 'as-named') continue;
      const entry = findModel(await modelsFor(protocol), requested);
      if (!entry) continue;
      const inference = frozenFor(token, protocol, entry);
      // A later candidate standing in for the chat's own model is a swap too.
      if (index === 0 || from === undefined) return { inference };
      return {
        inference,
        replaced: { from, fromName: await nameOf(from, modelsFor), toName: entry.displayName },
      };
    }
  }
  for (const protocol of protocols) {
    const model = recommendedIn(await modelsFor(protocol), protocol);
    if (!model) continue;
    if (from === undefined) return { inference: frozenFor(token, protocol, model) };
    return {
      inference: frozenFor(token, protocol, model),
      replaced: { from, fromName: await nameOf(from, modelsFor), toName: model.displayName },
    };
  }
  throw new CreditsUnavailableError('no-models', RUNTIME_LABEL);
}

/** A catalog entry for a model id, matched without its variant marker. */
function findModel(models: readonly InferenceModel[], id: string): InferenceModel | undefined {
  return models.find((model) => baseModelId(model.id) === baseModelId(id));
}

/** A model's name for a person: the catalog's, in any format that lists it, else its id. */
async function nameOf(
  id: string,
  modelsFor: (protocol: RuntimeCreditsProtocol) => Promise<readonly InferenceModel[]>
): Promise<string> {
  for (const protocol of DOE_CREDITS_PREFERENCE) {
    const entry = findModel(await modelsFor(protocol), id);
    if (entry) return entry.displayName;
  }
  return id;
}

/** Ports for {@link listDoeCreditsModels}. */
export interface DoeCreditsListDeps {
  token?: () => InferenceToken | null;
  models?: (protocol: RuntimeCreditsProtocol) => Promise<readonly InferenceModel[]>;
}

/**
 * The models a chat DorkOS picks for may run, as a model menu: the catalog's
 * models in the format DorkOS would pick, its pick first, marked default and
 * described {@link CHOSEN_BY_DORKOS}. With no recommended model anywhere, the
 * first served format's models, none marked. Never mints a token.
 *
 * @param deps - Injectable token and catalog reads.
 */
export async function listDoeCreditsModels(deps: DoeCreditsListDeps = {}): Promise<ModelOption[]> {
  const protocols = servedProtocols((deps.token ?? heldCreditsToken)());
  const modelsFor = deps.models ?? creditsModelsFor;
  let fallback: ModelOption[] = [];
  for (const protocol of protocols) {
    const models = await modelsFor(protocol);
    const pick = recommendedIn(models, protocol);
    const options = creditsModelOptions(models, protocol);
    if (!pick) {
      if (fallback.length === 0) fallback = options;
      continue;
    }
    return options.map(({ isDefault: _default, ...option }) =>
      option.value === pick.id
        ? { ...option, description: CHOSEN_BY_DORKOS, isDefault: true }
        : { ...option, description: '' }
    );
  }
  return fallback;
}
