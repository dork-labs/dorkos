/** Live account facts for usage-paused chat delivery. Never changes a running account. */
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { isCreditsClaudeRoot } from '../../../runtimes/claude-code/credits-root.js';
import { billingAccountFor, peekBillingUsage } from '../../fleet/session-account.js';
import { getSessionLimitStore } from '../../fleet/session-limit-store.js';
import { queueKeyOf } from '../../resolution/session-key-registry.js';
import { peekProjector } from '../../session-state-projector.js';
import type { ChatUsagePause } from './chat-usage-recovery.js';

/**
 * Read a chat's current limit without changing its account or billing choice.
 *
 * @param sessionId - The existing authorized chat
 * @param cwd - Its resolved folder when already known
 */
export async function chatUsagePauseOf(
  sessionId: string,
  cwd?: string
): Promise<ChatUsagePause | null> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const id = queueKeyOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const folder =
    cwd ??
    runtime.getSessionCwd?.(id) ??
    runtimeRegistry.getNativeSessionCwd(id) ??
    (await runtime.findSession?.(id))?.cwd ??
    (await runtimeRegistry.getSessionAgentPath(id)) ??
    DEFAULT_CWD;
  const recorded = peekProjector(id)?.getStatus().limit ?? getSessionLimitStore()?.get(id)?.limit;
  const limit =
    recorded && (!recorded.resetsAt || !(Date.parse(recorded.resetsAt) <= Date.now()))
      ? recorded
      : undefined;
  const billing = await billingAccountFor(runtime, id, folder);
  const store = getAccountUsageStore();
  const subscription =
    runtime.type === 'claude-code' &&
    billing?.perToken === false &&
    billing.root !== undefined &&
    !isCreditsClaudeRoot(billing.root);
  const usage =
    store && billing && (runtime.type !== 'claude-code' || subscription)
      ? peekBillingUsage(store, billing)
      : null;
  if (!limit && usage?.state !== 'limited') return null;

  return {
    resetsAt: limit?.resetsAt ?? usage?.limit?.resetsAt ?? null,
  };
}
