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
import { resolveCodexHome } from './codex-home.js';
import {
  parseCodexAppServerVersion,
  readCodexModelContextWindows,
} from './model-context-windows.js';

const INITIALIZE_REQUEST_ID = 1;
const FIRST_MODEL_REQUEST_ID = 2;
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
type SpawnModelServer = (binary: string, args: string[]) => ChildProcessWithoutNullStreams;
type ReadAuthMetadata = (file: string) => Promise<{ mtimeMs: number; size: number }>;
type ReadContextWindows = (clientVersion: string) => Promise<ReadonlyMap<string, number>>;

/** Options for one bounded app-server model query. */
export interface QueryCodexModelsOptions {
  /** Process factory; tests replace it with an in-memory protocol peer. */
  spawn?: SpawnModelServer;
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
  /** Resolve the Codex home plus auth-file fingerprint used as the cache identity. */
  resolveAuthContext?: () => Promise<string>;
  /** Run the live app-server exchange. */
  query?: (binary: string) => Promise<ModelOption[]>;
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

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * Ask a resolved Codex CLI for the models visible to its current account.
 *
 * @param binary - Absolute path to the resolved Codex executable.
 * @param options - Injectable process and deadline seams.
 * @returns Every visible model across all returned pages.
 */
export function queryCodexModels(
  binary: string,
  options: QueryCodexModelsOptions = {}
): Promise<ModelOption[]> {
  const spawn = options.spawn ?? ((file, args) => nodeSpawn(file, args, { stdio: 'pipe' }));
  const timeoutMs = options.timeoutMs ?? MODEL_QUERY_TIMEOUT_MS;
  const contextMetadataTimeoutMs = options.contextMetadataTimeoutMs ?? CONTEXT_METADATA_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const readContextWindows =
    options.readContextWindows ??
    ((clientVersion: string) =>
      readCodexModelContextWindows({ codexHome: resolveCodexHome(), clientVersion }));

  return new Promise<ModelOption[]>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, ['app-server', '--stdio']);
    } catch (error) {
      reject(error);
      return;
    }

    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    const models: AppServerModel[] = [];
    let settled = false;
    let appServerVersion: string | null = null;
    let pendingModelRequestId = FIRST_MODEL_REQUEST_ID;
    let pageCount = 0;
    let stdoutBytes = 0;
    let stdoutBuffer = '';

    const closeChild = (): void => {
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // The process already exited; the result that settled this exchange wins.
      }
    };

    const finish = (result: { models: ModelOption[] } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      closeChild();
      if ('error' in result) reject(result.error);
      else resolve(result.models);
    };

    const finishModels = (models: ModelOption[]): void => {
      if (settled) return;
      settled = true;
      closeChild();
      const clientVersion = appServerVersion;
      if (clientVersion === null) {
        resolve(models);
        return;
      }
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const metadataBudgetMs = Math.min(Math.max(0, contextMetadataTimeoutMs), remainingMs);
      if (metadataBudgetMs === 0) {
        resolve(models);
        return;
      }

      let metadataSettled = false;
      const metadataTimer = setTimeout(() => {
        metadataSettled = true;
        resolve(models);
      }, metadataBudgetMs);
      void Promise.resolve()
        .then(() => readContextWindows(clientVersion))
        .then(
          (windows) => {
            if (metadataSettled) return;
            metadataSettled = true;
            clearTimeout(metadataTimer);
            resolve(addContextWindows(models, windows));
          },
          () => {
            if (metadataSettled) return;
            metadataSettled = true;
            clearTimeout(metadataTimer);
            resolve(models);
          }
        );
    };

    const send = (message: unknown): void => {
      if (settled) return;
      try {
        writeMessage(child, message);
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    };

    const requestPage = (cursor: string | null): void => {
      pageCount += 1;
      if (pageCount > MAX_MODEL_PAGES) {
        finish({ error: new Error('Codex model/list exceeded the page limit') });
        return;
      }
      send({
        id: pendingModelRequestId,
        method: 'model/list',
        params: { cursor, includeHidden: false, limit: MODEL_PAGE_SIZE },
      });
    };

    const timer = setTimeout(() => {
      finish({ error: new Error(`Codex model/list timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => finish({ error }));
    child.stdin.once('error', (error) => finish({ error }));
    child.once('exit', (code, signal) => {
      if (!settled) {
        finish({
          error: new Error(
            `Codex app-server exited before model/list (${code ?? signal ?? 'unknown'})`
          ),
        });
      }
    });
    const handleLine = (line: string): void => {
      if (settled || line === '') return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        finish({ error: new Error('Codex app-server returned invalid JSON') });
        return;
      }
      if (typeof message !== 'object' || message === null || !('id' in message)) return;
      const response = message as { id: unknown; result?: unknown; error?: unknown };
      if (response.id === INITIALIZE_REQUEST_ID) {
        if (response.error !== undefined) {
          finish({ error: new Error('Codex app-server rejected initialize') });
          return;
        }
        appServerVersion = parseCodexAppServerVersion(
          (response.result as { userAgent?: unknown } | undefined)?.userAgent
        );
        send({ method: 'initialized' });
        requestPage(null);
        return;
      }
      if (response.id !== pendingModelRequestId) return;
      if (response.error !== undefined) {
        finish({ error: new Error('Codex app-server rejected model/list') });
        return;
      }
      const parsed = ModelListResponseSchema.safeParse(response.result);
      if (!parsed.success) {
        finish({ error: new Error('Codex app-server returned an invalid model/list response') });
        return;
      }
      models.push(...parsed.data.data);
      if (parsed.data.nextCursor) {
        pendingModelRequestId += 1;
        requestPage(parsed.data.nextCursor);
        return;
      }
      finishModels(models.map(mapAppServerModel));
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_APP_SERVER_STDOUT_BYTES) {
        finish({ error: new Error('Codex app-server model/list output exceeded the byte limit') });
        return;
      }
      stdoutBuffer += chunk.toString();
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        if (settled) return;
        newline = stdoutBuffer.indexOf('\n');
      }
    });

    send({
      id: INITIALIZE_REQUEST_ID,
      method: 'initialize',
      params: { clientInfo: { name: 'dorkos', version: '0.0.0' } },
    });
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
  env?: NodeJS.ProcessEnv,
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
 * the same binary and auth-file identity. Failures never extend that stale
 * deadline, and a changed auth identity can never see the prior account's list.
 */
export class CodexModelCatalog {
  private readonly resolveBinary: () => Promise<string | null>;
  private readonly resolveAuthContext: () => Promise<string>;
  private readonly query: (binary: string) => Promise<ModelOption[]>;
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
    this.resolveAuthContext = options.resolveAuthContext ?? resolveCodexAuthContext;
    this.query = options.query ?? queryCodexModels;
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
    const key = `${binary}\u0000${await this.resolveAuthContext()}`;
    if (this.cache?.key === key && this.cache.expiresAt > this.now()) return this.cache.models;
    if (this.inFlight?.key === key) return this.inFlight.promise;

    const promise = this.refresh(binary, key);
    this.inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  private async refresh(binary: string, key: string): Promise<ModelOption[]> {
    try {
      const models = await this.query(binary);
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
