/** Person-only sharing admission, using permanent chat provenance and the live turn. */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import type { OutsideTurnCheck } from '../handoff-guards/outside-turn-reason.js';

interface BrowserSharePolicyDeps {
  state(
    sessionId: string
  ): Promise<Pick<LocalBrowserState, 'sessionId'> & { profile?: { agentId: string | null } }>;
  agentForSession(sessionId: string): Promise<string | undefined>;
  resolveSessionRuntime(sessionId: string): Promise<{ type: string; bound: boolean }>;
  outsideTurn: OutsideTurnCheck;
  runtime(
    type: string
  ): Pick<AgentRuntime, 'getLockInfo'> & Partial<Pick<AgentRuntime, 'getInternalSessionId'>>;
}

/** Both the initial share and the step-up commit run this policy. */
export function createBrowserSharePolicy(deps: BrowserSharePolicyDeps) {
  return async (agentId: string, sessionId?: string): Promise<boolean> => {
    if (!sessionId) return false;
    const state = await deps.state(sessionId);
    if (
      state.sessionId !== sessionId ||
      state.profile?.agentId !== agentId ||
      (await deps.agentForSession(sessionId)) !== agentId
    )
      return false;
    const runtime = await deps.resolveSessionRuntime(state.sessionId);
    if (!runtime.bound) return false;
    const marked = await deps.outsideTurn(state.sessionId);
    if (marked === 'stranger_chat') return false;
    const rt = deps.runtime(runtime.type);
    const key = rt.getInternalSessionId?.(state.sessionId) ?? state.sessionId;
    return rt.getLockInfo(key) === null || marked === null;
  };
}
