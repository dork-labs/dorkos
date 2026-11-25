/**
 * The free arm of the live OpenCode conformance run reaches a local model and
 * nothing else (DOR-4754).
 *
 * Before, the free arm left provider and model unset, so the sidecar used
 * whatever the person's own OpenCode config named, and any exported hosted key
 * reached it. Now the run owns every input OpenCode reads a model or a login
 * from: its config file, its config, data and state folders, and the hosted key
 * names DorkOS lets through to it. Anything other than a loopback address stops
 * the run before a prompt is sent.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The variable that names the local model, in the local server's own spelling. */
export const LOCAL_MODEL_VAR = 'DORKOS_OPENCODE_LOCAL_MODEL';
/** The variable that names the local server's OpenAI-compatible address. */
export const LOCAL_URL_VAR = 'DORKOS_OPENCODE_LOCAL_URL';
/** The variable that names the model's context window, in tokens. */
export const LOCAL_CONTEXT_VAR = 'DORKOS_OPENCODE_LOCAL_CONTEXT';
/** The window most local coding models have (qwen2.5-coder's is 32,768). */
export const DEFAULT_LOCAL_CONTEXT = 32_768;
/** Ollama's address, the documented local server. */
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:11434/v1';
/** The one provider the run's config enables. */
export const LOCAL_PROVIDER = 'dorkos-local';

/**
 * Hosted keys and config sources OpenCode would read. DorkOS passes these
 * through to the sidecar (`runtime-environment-catalog.ts`), so the free run
 * removes them before it boots.
 */
export const HOSTED_INPUTS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_BASE_URL',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DB',
] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Which live arm a run asked for. */
export interface LiveMode {
  free: boolean;
  paid: boolean;
  live: boolean;
}

/**
 * Decide the live arm from its flags.
 *
 * `paid` needs its key as well as its flag, and a flag without a key throws:
 * a mocked fallback would report a green about a provider nothing reached.
 * Both flags at once throw too, so a free run can never turn into a paid one.
 *
 * @param env - The environment the run was started with.
 */
export function readLiveMode(env: NodeJS.ProcessEnv): LiveMode {
  const free = env.DORKOS_OPENCODE_LIVE === '1';
  const paid = env.DORKOS_OPENCODE_LIVE_PAID === '1';
  if (free && paid) {
    throw new Error(
      'DORKOS_OPENCODE_LIVE=1 and DORKOS_OPENCODE_LIVE_PAID=1 were both set. Pick one: ' +
        'the free run uses a local model only, the paid run spends on OpenRouter.'
    );
  }
  if (paid && (env.OPENROUTER_API_KEY ?? '').trim() === '') {
    throw new Error(
      'DORKOS_OPENCODE_LIVE_PAID=1 was set with no OPENROUTER_API_KEY, so this suite has no way ' +
        'to reach a model. Set the key, or unset the flag to run fully mocked. Refusing rather ' +
        'than falling back to the mocked run, which would report a green about a provider ' +
        'nothing reached.'
    );
  }
  return { free, paid, live: free || paid };
}

/** The local model and address one free run uses. */
export interface FreeLocalTarget {
  model: string;
  baseURL: string;
  /** Declared so OpenCode can say how full the conversation is. */
  context: number;
}

/**
 * Read the free run's target, or refuse with what to set.
 *
 * @param env - The environment the run was started with.
 * @throws When no model is named, or the address is not on this computer.
 */
export function readFreeLocalTarget(env: NodeJS.ProcessEnv): FreeLocalTarget {
  const model = (env[LOCAL_MODEL_VAR] ?? '').trim();
  if (model === '') {
    throw new Error(
      `DORKOS_OPENCODE_LIVE=1 needs ${LOCAL_MODEL_VAR}, a model your local server has ` +
        `(for example qwen2.5-coder:7b from \`ollama list\`). The free run never falls back ` +
        `to the model your own OpenCode config names, which may be a hosted one.`
    );
  }
  const baseURL = (env[LOCAL_URL_VAR] ?? '').trim() || DEFAULT_LOCAL_URL;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch (error) {
    throw new Error(`${LOCAL_URL_VAR} is not an address: ${baseURL}`, { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${LOCAL_URL_VAR} must be on this computer (127.0.0.1, localhost or [::1]), not ` +
        `${url.host}. The free run only talks to a local model.`
    );
  }
  const rawContext = (env[LOCAL_CONTEXT_VAR] ?? '').trim();
  const context = rawContext === '' ? DEFAULT_LOCAL_CONTEXT : Number(rawContext);
  if (!Number.isInteger(context) || context <= 0) {
    throw new Error(`${LOCAL_CONTEXT_VAR} must be a whole number of tokens, not ${rawContext}`);
  }
  return { model, baseURL, context };
}

/**
 * The OpenCode config one free run boots with: only the local provider is
 * enabled, and both the main and the small model are local.
 *
 * @param target - The local model and address.
 */
export function freeLocalConfig(target: FreeLocalTarget): Record<string, unknown> {
  const model = `${LOCAL_PROVIDER}/${target.model}`;
  return {
    enabled_providers: [LOCAL_PROVIDER],
    provider: {
      [LOCAL_PROVIDER]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Local model',
        options: { baseURL: target.baseURL },
        models: { [target.model]: { limit: { context: target.context, output: 4096 } } },
      },
    },
    model,
    small_model: model,
  };
}

/**
 * Point the run's OpenCode inputs at `home` and remove the hosted ones.
 *
 * @param env - The environment the sidecar will inherit; changed in place.
 * @param home - The run's throwaway folder.
 * @returns The target the run uses.
 * @throws Before any change, when the target is missing or not local.
 */
export function prepareFreeLocalRun(env: NodeJS.ProcessEnv, home: string): FreeLocalTarget {
  const target = readFreeLocalTarget(env);
  for (const name of HOSTED_INPUTS) delete env[name];
  for (const [name, dir] of [
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_DATA_HOME', 'data'],
    ['XDG_STATE_HOME', 'state'],
  ] as const) {
    env[name] = path.join(home, 'opencode-xdg', dir);
    fs.mkdirSync(env[name], { recursive: true });
  }
  const configFile = path.join(home, 'opencode-free.json');
  fs.writeFileSync(configFile, JSON.stringify(freeLocalConfig(target)), 'utf8');
  env.OPENCODE_CONFIG = configFile;
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return target;
}
