/**
 * Where the runtime setup reads and this computer's own reads on the
 * capability mount read (`services/core/runtime-doors/runtime-read-capabilities.ts`
 * and `computer-read-capabilities.ts`, DOR-4978): the same services the hand
 * routes called, wired in by the composition layer so the front-door modules
 * never import runtime, session or memory code.
 *
 * @module routes/runtime-settings-reader
 */
import type { RuntimeSettingsReader } from '../services/core/runtime-doors/runtime-read-capabilities.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import { configManager } from '../services/core/config-manager.js';
import { findUnregisteredClaudeFolders } from '../services/runtimes/claude-code/accounts/found-claude-folders.js';
import {
  readOpenCodeDirectSetup,
  readRuntimeKeyStatus,
} from '../services/runtimes/connect/credentials.js';
import { doeCreditsInUse, peekDoeCreditsPick } from '../services/runtimes/doe/auto-model.js';
import { readAccountEligibility } from './runtimes-account-eligibility.js';
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import type { ComputerReader } from '../services/core/runtime-doors/computer-read-capabilities.js';
import { readerFor } from '../services/audit/audit-capabilities.js';
import { auditTrail } from '../services/audit/audit-trail.js';
import { readableSessionIds } from '../services/audit/session-visibility.js';
import { boundaryToolError } from '../services/core/directory/path-refusal.js';
import { getGitStatus } from '../services/core/git-status.js';
import { keepAwakeService } from '../services/core/keep-awake/index.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { memoryProviderStatus } from '../services/memory/registry.js';
import { autoModeStopStats } from '../services/observability/auto-mode-stops.js';
import { shellCheckStatus } from '../services/runtimes/claude-code/shell-guard/guard-service.js';
import { openRouterOAuthStore } from '../services/runtimes/opencode/providers/openrouter.js';
import {
  getSessionEventStore,
  peekProjector,
} from '../services/session/session-state-projector.js';
import { validateBoundary } from '../lib/boundary.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import { CapabilityToolError } from '../services/core/capabilities/capability-definition.js';
import { COMPUTER_READ_SENTENCES } from '../services/core/runtime-doors/runtime-read-refusals.js';

/**
 * The reader the running server serves the runtime setup reads from.
 *
 * @returns The reader.
 */
export function runtimeSettingsReader(): RuntimeSettingsReader {
  return {
    accountUsage: (runtime) => getAccountUsageStore()?.list(runtime) ?? null,
    foundAccounts: () => findUnregisteredClaudeFolders({ runtimes: configManager.get('runtimes') }),
    accountEligibility: readAccountEligibility,
    runtimeKeyStatus: (type) => readRuntimeKeyStatus(type),
    openCodeKeySetup: () => readOpenCodeDirectSetup(),
    doeInference: () => {
      const inference = configManager.get('runtimes').doe.inference;
      // Which format DorkOS picks a model in when nothing is configured: only while
      // credits are in use here, and with no request made.
      const autoProtocol = doeCreditsInUse() ? (peekDoeCreditsPick()?.protocol ?? null) : null;
      if (!inference) return { inference: null, hasKey: false, autoProtocol };
      // The key reference stays on the server.
      const { credentialRef, credentialEndpoint: _endpoint, ...metadata } = inference;
      return { inference: metadata, hasKey: Boolean(credentialRef), autoProtocol };
    },
  };
}

/**
 * One chat's live spine, as `GET /api/debug/sessions/{sessionId}` always
 * answered it: counts, states and ids, never the payloads, which carry text.
 *
 * @param sessionId - A chat id that parsed.
 */
async function chatSpine(sessionId: string) {
  const projector = peekProjector(sessionId);
  // `resolveSessionRuntime`, not `getSessionRuntimeType`, for the second half it
  // returns: an id nothing has bound resolves through the registry's legacy
  // inference to `claude-code`, and a room placeholder is exactly such an id
  // (DOR-1780). `bound: false` says the type is what this chat WOULD get.
  const resolution = await runtimeRegistry
    .resolveSessionRuntime(sessionId)
    .catch(() => null as { type: string; bound: boolean } | null);
  const runtime = resolution?.type ?? null;
  const lock = runtimeRegistry.has(runtime ?? '')
    ? (runtimeRegistry.get(runtime as string)?.getLockInfo(sessionId) ?? null)
    : null;
  // The `'record'`-mode rows a room-driven claude-code chat writes (DOR-784):
  // counts and the newest boundary only, since the payloads carry text.
  const recorded = getSessionEventStore()?.readAll(sessionId) ?? [];
  const byType: Record<string, number> = {};
  for (const event of recorded) byType[event.type] = (byType[event.type] ?? 0) + 1;
  return {
    sessionId,
    runtime,
    runtimeBound: resolution?.bound ?? null,
    ...(projector
      ? projector.debugCounters()
      : { lifecycle: null, seq: null, subscribers: null, waiters: null }),
    projectorLive: projector !== undefined,
    lockHeldBy: lock?.clientId ?? null,
    lockAcquiredAt: lock ? new Date(lock.acquiredAt).toISOString() : null,
    // The DTO carries the prompt itself; only the shape of the wait crosses.
    pendingInteractions: (projector?.getPendingInteractions() ?? []).map((pending) => ({
      kind: pending.type,
      toolName: 'toolName' in pending ? pending.toolName : undefined,
      startedAt: new Date(pending.startedAt).toISOString(),
      remainingMs: pending.remainingMs,
    })),
    durableEvents: { total: recorded.length, byType },
  };
}

/**
 * The reader the running server serves this computer's reads from.
 *
 * @returns The reader.
 */
export function computerReader(): ComputerReader {
  return {
    autoModeStops: autoModeStopStats,
    // The same read check as the session routes (spec `audit-trail` §3.4).
    mayReadChat: (context, chatId) =>
      readableSessionIds(readerFor({ accounts: auditTrail()?.accounts }, context), [chatId]).has(
        chatId
      ),
    chatSpine,
    requirements: async () => {
      // Every runtime concurrently: each probe is time-bounded, so one slow
      // runtime cannot stall the others.
      const entries = await Promise.all(
        runtimeRegistry.listRuntimes().map(async (runtime) => {
          const dependencies = await runtime.checkDependencies();
          const readiness = deriveRuntimeReadiness(runtime.type, dependencies);
          const provider = runtime.getConnectedProvider?.() ?? undefined;
          return [
            runtime.type,
            { dependencies, ...readiness, ...(provider ? { provider } : {}) },
          ] as const;
        })
      );
      return { runtimes: Object.fromEntries(entries) };
    },
    memory: memoryProviderStatus,
    shellCheck: shellCheckStatus,
    keepAwake: () => keepAwakeService.status(),
    gitStatus: async (dir) => {
      try {
        return await getGitStatus(dir ? await validateBoundary(dir) : DEFAULT_CWD);
      } catch (err) {
        const refused = boundaryToolError(err);
        if (refused) throw refused;
        // As the hand route did: the folder goes to the log, never into the answer.
        logger.error('[git] GET /status failed', { err, dir });
        throw new CapabilityToolError({
          code: 'GIT_STATUS_FAILED',
          error: COMPUTER_READ_SENTENCES.gitFailed,
        });
      }
    },
    openRouterSignIn: (state) => openRouterOAuthStore.status(state),
  };
}
