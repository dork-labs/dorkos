/**
 * The first-run path a person picks on the Welcome screen, set up (spec
 * `one-minute-onboarding` §4.1, ADR 261010-143210).
 *
 * Calls run one at a time. Each first checks everything that can refuse (the
 * key, a hand-typed setup, a service that says the key is bad, a local model
 * that does not answer) and writes nothing until all of it passed, so a
 * refusal leaves the previous pick exactly as it was. A key whose service's
 * list cannot be read for any other reason is kept, on the preset's usual
 * model (`modelListed: false`). Then it undoes what the previous call set up, so "press
 * Continue, cancel, save a key" never leaves DorkOS credits armed or the
 * default runtime moved: the DorkOS runtime's credits record goes back to the
 * person's own sign-in, and `runtimes.default` and DorkBot's runtime go back to
 * what they were before the first call (`onboarding.priorRuntime`). Then it
 * applies the new pick and records it. Own AI turns credits off for the DorkOS
 * runtime whoever set them (a gap fill on an earlier link included); the DorkOS
 * pick clears `runtimes.doe.inference`, so DorkOS picks the model.
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
import { validateDoeSecret } from '../../runtimes/connect/doe-credentials.js';
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

/** The runtime an undo falls back to when the one before is not registered. */
const FALLBACK_RUNTIME = 'claude-code';

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
  /** Reads a service's model list with the key, once the person pressed Save. */
  fetch: PresetFetch;
  /** Whether this computer is linked already, so no new link will follow. */
  linked: () => boolean;
  /** Whether a runtime type is registered, so an undo never names one that is not. */
  isRuntime: (type: string) => boolean;
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
 * Whether the first run is over: finished, or dismissed. Both are written only
 * by a person (`onboarding.completedAt` and `dismissedAt` are operator-only),
 * so an agent cannot reopen it.
 *
 * @param onboarding - The stored onboarding section.
 */
export function firstRunClosed(onboarding: UserConfig['onboarding']): boolean {
  return onboarding.completedAt !== null || onboarding.dismissedAt !== null;
}

/** Put the DorkOS runtime back on the person's own sign-in when credits are its default. */
function turnDoeCreditsOff(deps: FirstRunDeps): void {
  if (readCreditsSettings(deps.config).defaults[DOE]?.runsOn === 'credits') {
    setCreditsDefault(DOE, false, deps.config);
  }
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
  // Cleared BEFORE the first await: a new-link hook that fires while DorkBot's
  // manifest is written must find no DorkOS pick to record credits for.
  writeOnboarding(deps, { firstRunPath: null, runtimeDefaultSetAt: null });
  if (previous === 'dorkos') turnDoeCreditsOff(deps);
  await useRuntime(deps, prior);
}

/** Save the DorkOS runtime's model setup, checked against its schema. */
function writeInference(deps: FirstRunDeps, inference: DoeInferenceConfig | null): void {
  const parsed = inference === null ? null : DoeInferenceConfigSchema.parse(inference);
  const runtimes = deps.config.get('runtimes');
  writeSection(deps, 'runtimes', { ...runtimes, doe: { ...runtimes.doe, inference: parsed } });
}

/** The model a pick starts on, and whether it came from the service's own list. */
interface PickedModel {
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  listed: boolean;
}

/**
 * The model to start on, read from the service's list with the key.
 *
 * A service that says the key is bad (401, 403) refuses the pick. With a key,
 * any other failed read (no answer, a 404, a key allowed to call the service
 * but not to list models) starts on the preset's `fallbackModel` and keeps the
 * key: spec §6.3, "a failing list read keeps the key". With no key (a model on
 * this computer) there is nothing to keep, so nothing answering refuses.
 */
async function pickFromList(
  deps: FirstRunDeps,
  preset: DoePreset,
  secret: string | undefined
): Promise<PickedModel> {
  try {
    return {
      ...pickPresetModel(preset, await listPresetModels(preset, secret, deps.fetch)),
      listed: true,
    };
  } catch (error) {
    if (!(error instanceof PresetModelsUnreachableError)) throw error;
    if (secret && error.keyRefused) {
      throw new FirstRunError(400, 'invalid_key', `${preset.service} didn't accept the key.`);
    }
    if (secret) {
      return {
        model: preset.fallbackModel,
        contextWindow: preset.limits.contextWindow,
        maxOutputTokens: preset.limits.maxOutputTokens,
        listed: false,
      };
    }
    throw new FirstRunError(
      502,
      'models_unreachable',
      `Couldn't reach ${preset.service}. Check that it is running.`
    );
  }
}

/** Refuse a key that cannot run the DorkOS runtime, before anything is written. */
function checkKey(secret: string): void {
  try {
    validateDoeSecret(secret);
  } catch (error) {
    if (error instanceof ConnectError) throw new FirstRunError(400, 'invalid_key', error.message);
    throw error;
  }
}

/** Check a hand-typed setup against its schema, before anything is written. */
function checkInference(inference: DoeInferenceConfig): DoeInferenceConfig {
  const parsed = DoeInferenceConfigSchema.safeParse(inference);
  if (!parsed.success) {
    throw new FirstRunError(400, 'invalid_setup', 'Check the model, endpoint, and token limits.');
  }
  return parsed.data;
}

/** An Own AI pick, checked and ready to write: the writes, and the model it runs on. */
interface PreparedChoice {
  model?: string;
  /** For a key preset: whether the model came from the service's own list. */
  modelListed?: boolean;
  write: () => Promise<void>;
}

/**
 * Check an Own AI pick and read what it needs (the service's model list)
 * WITHOUT writing anything, so every refusal leaves the previous pick as it
 * was. `agent-app` sets up nothing here: the app's connect cards do.
 */
async function prepareOwnChoice(deps: FirstRunDeps, choice: OwnAiChoice): Promise<PreparedChoice> {
  switch (choice.kind) {
    case 'agent-app':
      return { write: async () => {} };
    case 'local': {
      const preset = DOE_PRESETS.local;
      const { listed: _listed, ...picked } = await pickFromList(deps, preset, undefined);
      return {
        model: picked.model,
        write: async () => writeInference(deps, { ...presetInference(preset), ...picked }),
      };
    }
    case 'custom': {
      const inference = checkInference(choice.inference);
      if (inference.source === 'local') {
        return { model: inference.model, write: async () => writeInference(deps, inference) };
      }
      if (!choice.apiKey) throw new FirstRunError(400, 'invalid_key', 'Enter an API key.');
      const secret = choice.apiKey;
      checkKey(secret);
      return {
        model: inference.model,
        write: async () => {
          await deps.storeCredential(inference, secret);
        },
      };
    }
    default: {
      const preset = DOE_PRESETS[choice.kind];
      const secret = choice.apiKey;
      checkKey(secret);
      // The list is read with the key the person just saved in the form, and
      // only then is anything written: a key the service refuses changes
      // nothing; any other failed read keeps the key on the usual model.
      const { listed, ...picked } = await pickFromList(deps, preset, secret);
      return {
        model: picked.model,
        modelListed: listed,
        write: async () => {
          await deps.storeCredential({ ...presetInference(preset), ...picked }, secret);
        },
      };
    }
  }
}

/** One first-run pick at a time: a slow key check must not interleave with another pick. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Record the path picked on the Welcome screen and set it up. Calls run one
 * at a time, each reading the stored state afresh once it is its turn.
 *
 * @param request - The path, and for Own AI what was picked.
 * @param deps - The config and the writers.
 * @throws {FirstRunError} `onboarding_complete` (409) once the first run is
 *   finished or dismissed; `invalid_key` (400, the key refused by DorkOS or by
 *   the service), `invalid_setup` (400) and `models_unreachable` (502, a local
 *   model that did not answer), each before anything is written.
 */
export function applyFirstRun(
  request: FirstRunRequest,
  deps: FirstRunDeps
): Promise<FirstRunResult> {
  const run = queue.then(() => applyFirstRunNow(request, deps));
  queue = run.catch(() => undefined);
  return run;
}

/** {@link applyFirstRun}'s body, run inside the queue. */
async function applyFirstRunNow(
  request: FirstRunRequest,
  deps: FirstRunDeps
): Promise<FirstRunResult> {
  if (firstRunClosed(deps.config.get('onboarding'))) {
    throw new FirstRunError(409, 'onboarding_complete', 'Setup is already finished.');
  }
  // Everything that can refuse runs before the first write.
  const prepared =
    request.path === 'own' ? await prepareOwnChoice(deps, request.choice) : undefined;

  const onboarding = deps.config.get('onboarding');
  if (firstRunClosed(onboarding)) {
    throw new FirstRunError(409, 'onboarding_complete', 'Setup is already finished.');
  }
  // What to undo back to, kept from the FIRST call: a later call reads the
  // default this route already moved. A runtime that is no longer registered
  // (or a value written by hand) falls back to the built-in default.
  const stored = onboarding.priorRuntime ?? deps.config.get('runtimes').default;
  const prior = deps.isRuntime(stored) ? stored : FALLBACK_RUNTIME;
  if (onboarding.priorRuntime !== prior) writeOnboarding(deps, { priorRuntime: prior });
  await undoPreviousPick(deps, onboarding.firstRunPath, prior);

  if (request.path === 'dorkos') {
    // "Chosen by DorkOS": a credits chat runs on DorkOS's own pick, never on a
    // key some earlier pick left behind.
    writeInference(deps, null);
    await useRuntime(deps, DOE);
  } else if (request.path === 'own' && prepared) {
    await prepared.write();
    if (request.choice.kind !== 'agent-app') await useRuntime(deps, DOE);
  }
  // Any path but DorkOS: credits are not the DorkOS runtime's default, whoever
  // set them (a gap fill on an earlier link, or a link that landed while this
  // pick waited). Last, after every await, so nothing can arm them after it.
  if (request.path !== 'dorkos') turnDoeCreditsOff(deps);
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
    ...(prepared?.model ? { model: prepared.model } : {}),
    ...(prepared?.modelListed !== undefined ? { modelListed: prepared.modelListed } : {}),
  };
}
