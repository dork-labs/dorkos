import type { EndpointInfo } from './types.js';
import type { RelayGc, RelayGcSweepOptions } from './relay-gc.js';
import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { ReliabilityConfigSchema } from '@dorkos/shared/relay-schemas';
import { DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import { DEFAULT_CB_CONFIG, type CircuitBreakerManager } from './circuit-breaker.js';
import { DEFAULT_BP_CONFIG } from './backpressure.js';
import type { RelayPublishPipeline } from './relay-publish.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import { inferEndpointType, type BackpressureConfig, type RelayLogger } from './types.js';
import type { EndpointManagementDeps } from './relay-endpoint-management.js';
import { requireOriginalRelayCoreOwner } from './relay-core.js';
export interface OriginalRelayMaintenanceContext {
  configPath: string;
  publishPipeline: RelayPublishPipeline;
  circuitBreaker: CircuitBreakerManager;
  backpressureConfig: BackpressureConfig;
  deliveryPipeline: DeliveryPipeline;
  configWatcher: FSWatcher | null;
  loadReliabilityConfig: () => void;
  logger: RelayLogger;
  endpointDeps: EndpointManagementDeps;
  readonly dispatchInboxTtlMs: number;
  readonly closed: boolean;
  gc: RelayGc;
  unregisterEndpoint: (subject: string) => Promise<boolean>;
}
/** Load only the original constructor-owned reliability configuration. */
export function loadOriginalRelayReliability(ownerKey: object): void {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  try {
    const raw = fs.readFileSync(context.configPath, 'utf-8');
    const json: unknown = JSON.parse(raw);
    const obj = json as Record<string, unknown>;
    const parsed = ReliabilityConfigSchema.safeParse(obj.reliability);
    if (parsed.success) {
      context.publishPipeline.setRateLimitConfig({
        ...DEFAULT_RATE_LIMIT_CONFIG,
        ...parsed.data.rateLimit,
      });
      context.circuitBreaker.updateConfig({ ...DEFAULT_CB_CONFIG, ...parsed.data.circuitBreaker });
      context.backpressureConfig = { ...DEFAULT_BP_CONFIG, ...parsed.data.backpressure };
      context.deliveryPipeline.setBackpressureConfig(context.backpressureConfig);
    }
  } catch {
    // File doesn't exist or is invalid -- keep current config
  }
}

/** Start a chokidar watcher on the config file for hot-reload. */
export function startOriginalRelayConfigWatcher(ownerKey: object): void {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  context.configWatcher = chokidar.watch(context.configPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  context.configWatcher.on('change', () => context.loadReliabilityConfig());
  context.configWatcher.on('add', () => context.loadReliabilityConfig());

  // Without this handler a watcher failure (e.g. EMFILE) has nowhere to go
  // but the process-wide unhandled-error path. The relay keeps running on its
  // last-loaded reliability config; only hot-reload of external edits stops
  // working until the process restarts. Latched per distinct error code
  // rather than a single boolean: a benign EACCES must never suppress the
  // EMFILE storm that follows it. The Set lives in this per-instance closure,
  // so one relay's latch cannot silence another's.
  const seenCodes = new Set<string>();
  context.configWatcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
    if (seenCodes.has(code)) return;
    seenCodes.add(code);
    // Logged as an explicit object, never the bare Error: the server's NDJSON
    // reporter spreads what it is given, and `message`/`stack` are
    // non-enumerable on an Error, so they would vanish (DOR-832).
    context.logger.warn(
      `[watcher-error] RelayCore: ${context.configPath} — further ${code} errors from this watcher are suppressed`,
      {
        configPath: context.configPath,
        code,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        suppressingFurtherErrors: true,
      }
    );
  });
}

/** Sweep only the original constructor-owned inactive dispatch endpoints. */
export async function runOriginalRelayTtlSweep(ownerKey: object): Promise<string[]> {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  if (context.closed) return [];
  const now = Date.now();
  const registry = context.endpointDeps.endpointRegistry;
  const swept: string[] = [];
  for (const endpoint of registry.listEndpoints()) {
    if (inferEndpointType(endpoint.subject) === 'dispatch') {
      const lastActivity =
        registry.getLastActivityMs(endpoint.subject) ?? Date.parse(endpoint.registeredAt);
      if (now - lastActivity > context.dispatchInboxTtlMs) {
        await context.unregisterEndpoint(endpoint.subject).catch(() => undefined);
        swept.push(endpoint.subject);
      }
    }
  }
  return swept;
}

/** Drain the original endpoint through its constructor-owned dispatch pipeline. */
export async function drainOriginalRelayBacklog(
  ownerKey: object,
  endpoint: EndpointInfo
): Promise<void> {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  try {
    const messageIds = await context.endpointDeps.maildirStore.listNew(endpoint.hash);
    for (const messageId of messageIds) {
      await context.deliveryPipeline.dispatchToSubscribers(endpoint, messageId);
    }
  } catch {
    // Best-effort — stranded messages remain pollable via readInbox
  }
}

/** Run the original storage sweep with the original closed-state guard. */
export async function runOriginalRelayGcSweep(
  ownerKey: object,
  options?: RelayGcSweepOptions
): Promise<Awaited<ReturnType<RelayGc['sweep']>> | undefined> {
  const context = requireOriginalRelayCoreOwner(ownerKey);
  if (context.closed) return undefined;
  return context.gc.sweep(Date.now(), options);
}
