import type { AgentSession } from '../agent-types.js';

/** Create the original session-less introspection DATA at the caller's existing factory frontier. */
export function createClaudeIntrospectionSession(): AgentSession {
  return {
    eventQueue: [],
    pendingInteractions: new Map(),
    permissionMode: 'default',
    lastActivity: Date.now(),
    hasStarted: false,
  } as unknown as AgentSession;
}
