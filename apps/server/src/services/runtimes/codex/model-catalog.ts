/**
 * Account-aware Codex model discovery through the CLI app-server protocol.
 *
 * @module services/runtimes/codex/model-catalog
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import type { EffortLevel, ModelOption } from '@dorkos/shared/types';
import { logger, logError } from '../../../lib/logger.js';
import { runtimeEnvironment } from '../shared/runtime-environment-config.js';
import { resolveCodexHome } from './codex-home.js';
import { readCodexModelContextWindows } from './model-context-windows.js';
import { CodexJsonRpcClient } from './app-server/json-rpc-client.js';
import { initializeCodexClient } from './app-server/handshake.js';
import { CodexRpcError } from './app-server/protocol/errors.js';

const MODEL_PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 10;
const MODEL_QUERY_TIMEOUT_MS = 15_000;
const CONTEXT_METADATA_TIMEOUT_MS = 100;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_STALE_TTL_MS = 5 * 60_000;
const MAX_APP_SERVER_STDOUT_BYTES = 2 * 1024 * 1024;

const AppServerModelSchema = z.object({
  model: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
  inputModalities: z.array(z.string()).optional(),
  additionalSpeedTiers: z.array(z.string()).optional(),
});

const ModelListResponseSchema = z.object({
  data: z.array(AppServerModelSchema),
  nextCursor: z.string().nullable().optional(),
});

type AppServerModel = z.infer<typeof AppServerModelSchema>;
type SpawnModelServer = (
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => ChildProcessWithoutNullStreams;
type ReadAuthMetadata = (file: string) => Promise<{ mtimeMs: number; size: number }>;
type ReadContextWindows = (clientVersion: string) => Promise<ReadonlyMap<string, number>>;

/** Options for one bounded app-server model query. */
export interface QueryCodexModelsOptions {
  /** Process factory; tests replace it with an in-memory protocol peer. */
  spawn?: SpawnModelServer;
  /** Complete projected process environment; defaults to the Codex auth-probe profile. */
  environment?: NodeJS.ProcessEnv;
  /** Hard deadline for the complete initialize and paginated list exchange. */
  timeoutMs?: number;
  /** CLI-owned context-window reader; tests replace it with a deterministic map. */
  readContextWindows?: ReadContextWindows;
  /** Maximum part of the model-query deadline spent on optional context metadata. */
  contextMetadataTimeoutMs?: number;
}

/** Dependencies for the cached account-aware model catalog. */
export interface CodexModelCatalogOptions {
  /** Resolve the same CLI binary a real turn will use. */
  resolveBinary: () => Promise<string | null>;
  /** Resolve the complete environment shared by auth identity and model discovery. */
  resolveEnvironment?: () => Record<string, string>;
  /** Resolve the Codex home plus auth-file fingerprint used as the cache identity. */
  resolveAuthContext?: (env: NodeJS.ProcessEnv) => Promise<string>;
  /** Run the live app-server exchange. */
  query?: (binary: string, env: NodeJS.ProcessEnv) => Promise<ModelOption[]>;
  /** Clock seam for deterministic TTL tests. */
  now?: () => number;
  /** Successful-answer freshness window. */
  ttlMs?: number;
  /** Report a swallowed discovery failure. */
  onError?: (error: unknown) => void;
}

const knownEfforts = new Set<string>(EFFORT_LEVELS);

function isEffortLevel(value: string): value is EffortLevel {
  return knownEfforts.has(value);
}

/**
 * Map one CLI-reported picker row into DorkOS's runtime-neutral model shape.
 *
 * @param model - Validated model row from `model/list`.
 * @returns The corresponding DorkOS model option.
 */
export function mapAppServerModel(model: AppServerModel): ModelOption {
  const efforts = model.supportedReasoningEfforts
    .map((option) => option.reasoningEffort)
    .filter(isEffortLevel);
  return {
    value: model.model,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    supportsEffort: efforts.length > 0,
    supportedEffortLevels: efforts,
    supportsFastMode: model.additionalSpeedTiers?.includes('fast') ?? false,
    supportsVision: model.inputModalities?.includes('image') ?? false,
    supportsToolUse: true,
    supportsImageOutput: false,
    provider: 'openai',
  };
}

/** Add only exact model-cache matches to rows already confirmed by app-server. */
function addContextWindows(
  models: ModelOption[],
  windows: ReadonlyMap<string, number>
): ModelOption[] {
  return models.map((model) => {
    const contextWindow = windows.get(model.value);
    return contextWindow === undefined ? model : { ...model, contextWindow };
  });
}

/**
 * Ask a resolved Codex CLI for the models visible to its current account.
 *
 * One-shot use of the shared app-server client: spawn, `initialize`, page
 * `model/list`, close. Bounded end to end by `timeoutMs`, and per line by the
 * same 2 MiB this query has always allowed.
 *
 * @param binary - Absolute path to the resolved Codex executable.
 * @param options - Injectable environment, process, and deadline seams.
 * @returns Every visible model across all returned pages.
 */
export async function queryCodexModels(
  binary: string,
  options: QueryCodexModelsOptions = {}
): Promise<ModelOption[]> {
  const environment = options.environment ?? runtimeEnvironment('codex', 'auth-probe');
  const timeoutMs = options.timeoutMs ?? MODEL_QUERY_TIMEOUT_MS;
  const contextMetadataTimeoutMs = options.contextMetadataTimeoutMs ?? CONTEXT_METADATA_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const readContextWindows =
    options.readContextWindows ??
    ((clientVersion: string) =>
      readCodexModelContextWindows({ codexHome: resolveCodexHome(environment), clientVersion }));

  const child = options.spawn
    ? options.spawn(binary, ['app-server', '--stdio'], environment)
    : nodeSpawn(binary, ['app-server', '--stdio'], { stdio: 'pipe', env: environment });
  const client = new CodexJsonRpcClient(child, {
    maxLineBytes: MAX_APP_SERVER_STDOUT_BYTES,
    lineLimitMessage: 'Codex app-server model/list output exceeded the byte limit',
    label: 'model catalog',
  });
  child.once('error', (error) => client.close({ kind: 'exited', detail: error.message }));
  child.once('exit', (code, signal) =>
    client.close({
      kind: 'exited',
      detail: `Codex app-server exited before model/list (${code ?? signal ?? 'unknown'})`,
    })
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Codex model/list timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  let models: ModelOption[];
  let appServerVersion: string | null;
  try {
    ({ models, appServerVersion } = await Promise.race([listAllModels(client), deadline]));
  } finally {
    clearTimeout(timer);
    client.close();
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // The process already exited; the result that settled this exchange wins.
    }
  }
  if (appServerVersion === null) return models;
  return withContextWindows(
    models,
    appServerVersion,
    Math.min(Math.max(0, contextMetadataTimeoutMs), Math.max(0, deadlineAt - Date.now())),
    readContextWindows
  );
}

/** Initialize, then follow `model/list` pagination to the end. */
async function listAllModels(
  client: CodexJsonRpcClient
): Promise<{ models: ModelOption[]; appServerVersion: string | null }> {
  let appServerVersion: string | null;
  try {
    appServerVersion = await initializeCodexClient(client, { experimentalApi: false });
  } catch (error) {
    if (error instanceof CodexRpcError)
      throw new Error('Codex app-server rejected initialize', { cause: error });
    throw error;
  }
  const rows: AppServerModel[] = [];
  let cursor: string | null = null;
  for (let page = 1; ; page += 1) {
    if (page > MAX_MODEL_PAGES) throw new Error('Codex model/list exceeded the page limit');
    let result: unknown;
    try {
      result = await client.request('model/list', {
        cursor,
        includeHidden: false,
        limit: MODEL_PAGE_SIZE,
      });
    } catch (error) {
      if (error instanceof CodexRpcError)
        throw new Error('Codex app-server rejected model/list', { cause: error });
      throw error;
    }
    const parsed = ModelListResponseSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid model/list response');
    }
    rows.push(...parsed.data.data);
    if (!parsed.data.nextCursor) break;
    cursor = parsed.data.nextCursor;
  }
  return { models: rows.map(mapAppServerModel), appServerVersion };
}

/** Add optional context windows, within a budget that never fails the answer. */
async function withContextWindows(
  models: ModelOption[],
  clientVersion: string,
  budgetMs: number,
  readContextWindows: ReadContextWindows
): Promise<ModelOption[]> {
  if (budgetMs === 0) return models;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: ModelOption[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(metadataTimer);
      resolve(value);
    };
    const metadataTimer = setTimeout(() => settle(models), budgetMs);
    void Promise.resolve()
      .then(() => readContextWindows(clientVersion))
      .then(
        (windows) => settle(addContextWindows(models, windows)),
        () => settle(models)
      );
  });
}

/**
 * Resolve the auth identity that controls Codex's account-scoped model list.
 *
 * @param env - Environment used by the Codex subprocess.
 * @param readMetadata - Auth-file metadata reader; injectable for tests.
 * @returns Codex home plus auth-file metadata, without reading credential contents.
 */
export async function resolveCodexAuthContext(
  env: NodeJS.ProcessEnv = runtimeEnvironment('codex', 'auth-probe'),
  readMetadata: ReadAuthMetadata = stat
): Promise<string> {
  const home = resolveCodexHome(env);
  try {
    const metadata = await readMetadata(path.join(home, 'auth.json'));
    return `${home}\u0000${metadata.mtimeMs}:${metadata.size}`;
  } catch {
    return `${home}\u0000missing`;
  }
}

/**
 * Cached account-aware model discovery for one Codex runtime instance.
 *
 * A failed refresh may reuse the last good answer for at most five minutes for
 * the same binary, projected environment names, and auth-file identity. The key
 * deliberately retains no environment values; changing an environment-backed
 * credential requires the same server restart as other runtime launches, while
 * an auth-file or effective projected-name change invalidates the catalog immediately.
 * Failures never extend the stale deadline, and a changed auth identity can
 * never see the prior account's list.
 */
export class CodexModelCatalog {
  private readonly resolveBinary: () => Promise<string | null>;
  private readonly resolveEnvironment: () => Record<string, string>;
  private readonly resolveAuthContext: (env: NodeJS.ProcessEnv) => Promise<string>;
  private readonly query: (binary: string, env: NodeJS.ProcessEnv) => Promise<ModelOption[]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly onError: (error: unknown) => void;
  private cache: {
    key: string;
    models: ModelOption[];
    expiresAt: number;
    staleUntil: number;
  } | null = null;
  private inFlight: { key: string; promise: Promise<ModelOption[]> } | null = null;

  constructor(options: CodexModelCatalogOptions) {
    this.resolveBinary = options.resolveBinary;
    this.resolveEnvironment =
      options.resolveEnvironment ?? (() => runtimeEnvironment('codex', 'auth-probe'));
    this.resolveAuthContext = options.resolveAuthContext ?? resolveCodexAuthContext;
    this.query =
      options.query ?? ((binary, environment) => queryCodexModels(binary, { environment }));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? MODEL_CACHE_TTL_MS;
    this.onError =
      options.onError ??
      ((error) => logger.warn('[Codex] model catalog discovery failed', logError(error)));
  }

  /** Return the current account's catalog, or an empty unknown answer when discovery has never worked. */
  async getSupportedModels(): Promise<ModelOption[]> {
    const binary = await this.resolveBinary();
    if (!binary) return [];
    const environment = this.resolveEnvironment();
    const environmentNames = JSON.stringify(
      Object.keys(environment).sort((left, right) => left.localeCompare(right))
    );
    const key = `${binary}\u0000${environmentNames}\u0000${await this.resolveAuthContext(environment)}`;
    if (this.cache?.key === key && this.cache.expiresAt > this.now()) return this.cache.models;
    if (this.inFlight?.key === key) return this.inFlight.promise;

    const promise = this.refresh(binary, key, environment);
    this.inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  private async refresh(
    binary: string,
    key: string,
    environment: NodeJS.ProcessEnv
  ): Promise<ModelOption[]> {
    try {
      const models = await this.query(binary, environment);
      const now = this.now();
      this.cache = {
        key,
        models,
        expiresAt: now + this.ttlMs,
        staleUntil: now + MODEL_STALE_TTL_MS,
      };
      return models;
    } catch (error) {
      this.onError(error);
      const now = this.now();
      const sameIdentity = this.cache?.key === key ? this.cache : null;
      const usesStaleAnswer = sameIdentity !== null && sameIdentity.staleUntil > now;
      const models = usesStaleAnswer ? sameIdentity.models : [];
      this.cache = {
        key,
        models,
        expiresAt:
          usesStaleAnswer && models.length > 0
            ? Math.min(now + this.ttlMs, sameIdentity.staleUntil)
            : now + this.ttlMs,
        staleUntil: sameIdentity?.staleUntil ?? now,
      };
      return models;
    }
  }
}
