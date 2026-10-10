/**
 * The first-run path a person picks on the Welcome screen, set up (spec
 * `one-minute-onboarding` §4.1, ADR 261010-143210).
 *
 * Every call first undoes what the previous call set up, so "press Continue,
 * cancel, save a key" never leaves DorkOS credits armed or the default runtime
 * moved: the DorkOS runtime's credits record goes back to the person's own
 * sign-in, and `runtimes.default` and DorkBot's runtime go back to what they
 * were before the first call (`onboarding.priorRuntime`). Then it applies the
 * new pick and records it.
 *
 * The DorkOS path writes no credits record itself while the link is still to
 * be made. A new link starts every credits choice over (`fillCreditsGaps`), so
 * the new-link hook records it instead ({@link recordFirstRunCreditsChoice}),
 * and nothing can spend before the person approved the link. On a computer
 * that is linked already, no new link will come, so it is recorded here.
 *
 * Every write here is the person's own pick in the app, made behind the route's
 * person and owner bars (`routes/onboarding.ts`), and each leaves a line.
 *
 * @module services/core/onboarding/first-run
 */
import type { DoeInferenceConfig, UserConfig } from '@dorkos/shared/config-schema';
import { DoeInferenceConfigSchema } from '@dorkos/shared/config-schema';
import type {
  FirstRunRefusalCode,
  FirstRunRequest,
  FirstRunResult,
  OwnAiChoice,
} from '@dorkos/shared/onboarding-schemas';
import { logConfigWrite } from '../operator/config-write.js';
import {
  readCreditsSettings,
  recordFirstRunCreditsChoice,
  setCreditsDefault,
} from '../cloud/credits-defaults.js';
import { ConnectError } from '../../runtimes/connect/connect-error.js';
import {
  DOE_PRESETS,
  PresetModelsUnreachableError,
  listPresetModels,
  pickPresetModel,
  presetInference,
  type DoePreset,
  type PresetFetch,
} from '../../runtimes/doe/presets.js';

/** The DorkOS runtime's type. */
const DOE = 'doe';

/** Who the config lines name. */
const WRITER = 'the first-run route';

/** The config surface this module reads and writes. */
export interface FirstRunConfigPort {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void;
}

/** What a first-run pick needs from the rest of the server. Injectable for tests. */
export interface FirstRunDeps {
  /** Config reads and writes. */
  config: FirstRunConfigPort;
  /** Move DorkBot onto a runtime, through the agent manifest's write-through. */
  setDorkBotRuntime: (runtime: string) => Promise<void>;
  /** Save a key for the DorkOS runtime (`storeDoeCredential`). */
  storeCredential: (inference: DoeInferenceConfig, secret: string) => Promise<DoeInferenceConfig>;
  /** Reads a service's model list, after the key was saved. */
  fetch: PresetFetch;
  /** Whether this computer is linked already, so no new link will follow. */
  linked: () => boolean;
  /** The clock, for `runtimeDefaultSetAt`. */
  now?: () => Date;
}

/** A refusal the route answers with its status, code and sentence. */
export class FirstRunError extends Error {
  /**
   * Build a refusal.
   *
   * @param status - The HTTP status.
   * @param code - Why, for the client to act on.
   * @param message - The sentence a person reads.
   */
  constructor(
    readonly status: number,
    readonly code: FirstRunRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'FirstRunError';
  }
}

/** Write one section, leaving a line, when it changed. */
function writeSection<K extends keyof UserConfig>(
  deps: FirstRunDeps,
  key: K,
  next: UserConfig[K]
): void {
  const before = deps.config.get(key);
  if (JSON.stringify(before) === JSON.stringify(next)) return;
  deps.config.set(key, next);
  logConfigWrite(WRITER, key, before, next);
}

/** Merge leaves into the stored `onboarding` section. */
function writeOnboarding(deps: FirstRunDeps, leaves: Partial<UserConfig['onboarding']>): void {
  writeSection(deps, 'onboarding', { ...deps.config.get('onboarding'), ...leaves });
}

/** Point new conversations and DorkBot at one runtime. */
async function useRuntime(deps: FirstRunDeps, runtime: string): Promise<void> {
  writeSection(deps, 'runtimes', { ...deps.config.get('runtimes'), default: runtime });
  await deps.setDorkBotRuntime(runtime);
}

/**
 * Undo what the previous pick set up, and clear its record, so a pick that
 * fails partway leaves nothing armed behind it.
 */
async function undoPreviousPick(
  deps: FirstRunDeps,
  previous: UserConfig['onboarding']['firstRunPath'],
  prior: string
): Promise<void> {
  if (previous === null) return;
  if (
    previous === 'dorkos' &&
    readCreditsSettings(deps.config).defaults[DOE]?.runsOn === 'credits'
  ) {
    setCreditsDefault(DOE, false, deps.config);
  }
  await useRuntime(deps, prior);
  writeOnboarding(deps, { firstRunPath: null, runtimeDefaultSetAt: null });
}

/** Save the DorkOS runtime's model setup, checked against its schema. */
function writeInference(deps: FirstRunDeps, inference: DoeInferenceConfig): void {
  const parsed = DoeInferenceConfigSchema.parse(inference);
  const runtimes = deps.config.get('runtimes');
  writeSection(deps, 'runtimes', { ...runtimes, doe: { ...runtimes.doe, inference: parsed } });
}

/** The service's list, read; a failure becomes the sentence the client shows. */
async function pickFromList(deps: FirstRunDeps, preset: DoePreset, secret: string | undefined) {
  try {
    return pickPresetModel(preset, await listPresetModels(preset, secret, deps.fetch));
  } catch (error) {
    if (!(error instanceof PresetModelsUnreachableError)) throw error;
    const hint = secret ? 'Check the key.' : 'Check that it is running.';
    throw new FirstRunError(502, 'models_unreachable', `Couldn't reach ${preset.service}. ${hint}`);
  }
}

/** Save a key, turning its refusal into a first-run refusal. */
async function storeKey(
  deps: FirstRunDeps,
  inference: DoeInferenceConfig,
  secret: string
): Promise<DoeInferenceConfig> {
  try {
    return await deps.storeCredential(inference, secret);
  } catch (error) {
    if (error instanceof ConnectError && error.status === 400) {
      throw new FirstRunError(400, 'invalid_key', error.message);
    }
    throw error;
  }
}

/**
 * Set the DorkOS runtime up for an Own AI pick, and return the model it now
 * runs on. `agent-app` sets up nothing here: the app's connect cards do.
 */
async function applyOwnChoice(
  deps: FirstRunDeps,
  choice: OwnAiChoice
): Promise<string | undefined> {
  switch (choice.kind) {
    case 'agent-app':
      return undefined;
    case 'local': {
      const preset = DOE_PRESETS.local;
      const picked = await pickFromList(deps, preset, undefined);
      writeInference(deps, { ...presetInference(preset), ...picked });
      return picked.model;
    }
    case 'custom': {
      if (choice.inference.source === 'local') {
        writeInference(deps, choice.inference);
        return choice.inference.model;
      }
      if (!choice.apiKey) throw new FirstRunError(400, 'invalid_key', 'Enter an API key.');
      await storeKey(deps, choice.inference, choice.apiKey);
      return choice.inference.model;
    }
    default: {
      const preset = DOE_PRESETS[choice.kind];
      // The key is saved first: nothing reaches the service before the person
      // pressed Save, and a list that cannot be read keeps the key.
      const stored = await storeKey(deps, presetInference(preset), choice.apiKey);
      const picked = await pickFromList(deps, preset, choice.apiKey);
      writeInference(deps, { ...stored, ...picked });
      return picked.model;
    }
  }
}

/**
 * Record the path picked on the Welcome screen and set it up.
 *
 * @param request - The path, and for Own AI what was picked.
 * @param deps - The config and the writers.
 * @throws {FirstRunError} `onboarding_complete` (409) once the first run is
 *   finished; `invalid_key` (400) before anything is saved;
 *   `models_unreachable` (502) when the key was saved but the list could not be
 *   read.
 */
export async function applyFirstRun(
  request: FirstRunRequest,
  deps: FirstRunDeps
): Promise<FirstRunResult> {
  const onboarding = deps.config.get('onboarding');
  if (onboarding.completedAt !== null) {
    throw new FirstRunError(409, 'onboarding_complete', 'Setup is already finished.');
  }
  // What to undo back to, kept from the FIRST call: a later call reads the
  // default this route already moved.
  const prior = onboarding.priorRuntime ?? deps.config.get('runtimes').default;
  if (onboarding.priorRuntime === null) writeOnboarding(deps, { priorRuntime: prior });
  await undoPreviousPick(deps, onboarding.firstRunPath, prior);

  let model: string | undefined;
  if (request.path === 'dorkos') {
    await useRuntime(deps, DOE);
  } else if (request.path === 'own') {
    model = await applyOwnChoice(deps, request.choice);
    if (request.choice.kind !== 'agent-app') await useRuntime(deps, DOE);
  }
  // An AI app's connect cards pick the default from what signed in, and they
  // pick only while this stamp is unset.
  const decided = !(request.path === 'own' && request.choice.kind === 'agent-app');
  const now = (deps.now ?? (() => new Date()))().toISOString();
  writeOnboarding(deps, {
    firstRunPath: request.path,
    runtimeDefaultSetAt: decided ? now : null,
  });
  // Already linked, so no new link will come to record it: record it now.
  if (request.path === 'dorkos' && deps.linked()) recordFirstRunCreditsChoice(deps.config);
  return {
    path: request.path,
    runtime: deps.config.get('runtimes').default,
    ...(model ? { model } : {}),
  };
}
