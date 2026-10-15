import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';
import {
  conversationTokens,
  PluginReloadSessionGoneError,
} from '../messaging/plugin-reload-policy.js';

/** Recheck the original held reload through its actual runtime key and original live query. */
export async function recheckHeldReload(ownerKey: object, sessionId: string): Promise<boolean> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const { session, queryObj } = facet.reloadableSession(sessionId);
  const contextTokens = conversationTokens(session);
  const asked = await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd, {
    holdOnCacheImpact: true,
    sessionId,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  });
  return !asked.held;
}

/** Apply the original held reload through its actual runtime key without holding cache impact. */
export async function applyHeldReload(ownerKey: object, sessionId: string): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const { session, queryObj } = facet.reloadableSession(sessionId);
  await facet.cache.reloadPlugins(queryObj, session.cwd, facet.cwd);
}

/** Resolve the original current or last query through its actual runtime key. */
export function resolveReloadableSession(
  ownerKey: object,
  sessionId: string
): { session: AgentSession; queryObj: Query } {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const session = facet.sessionStore.findSession(sessionId);
  const queryObj = session?.activeQuery ?? session?.lastQuery;
  if (!session || !queryObj) {
    // Its own error type, because the scheduler drops a wait on THIS and
    // keeps one on a control request that merely went unanswered.
    throw new PluginReloadSessionGoneError(sessionId);
  }
  return { session, queryObj };
}
