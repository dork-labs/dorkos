/** Whether the agent behind a chat may use a named Agent browser profile. */
import { LocalBrowserError } from './errors.js';
import type { LocalBrowserProfileStore } from './profile-store.js';

/** The verified launch facts this check reads; it never reads an agent's own files. */
export interface LocalBrowserProfileAccessDeps {
  profiles: Pick<LocalBrowserProfileStore, 'isBound'>;
  resolveSessionRuntime(sessionId: string): Promise<{ type: string; bound: boolean }>;
  getSessionAgentPath(sessionId: string): Promise<string | null>;
  agentIdAtPath(agentPath: string): string | undefined;
  /** The folder's real path, or undefined when it can't be read. */
  realFolder(agentPath: string): string | undefined;
}

/** Answers once per tool call. A refusal throws, so nothing is allowed by accident. */
export type LocalBrowserProfileAccess = (profileId: string, sessionId: string) => Promise<void>;

/**
 * Build the check run before and after every agent tool call on a named profile.
 *
 * @param deps - The profile records and the session's launch facts.
 */
export function createLocalBrowserProfileAccess(
  deps: LocalBrowserProfileAccessDeps
): LocalBrowserProfileAccess {
  return async (profileId, sessionId) => {
    const runtime = await deps.resolveSessionRuntime(sessionId);
    // Codex and OpenCode don't honour the deny on the profiles folder yet.
    if (!runtime.bound || runtime.type !== 'claude-code')
      throw new LocalBrowserError(
        'profile_runtime',
        'Named browser profiles aren’t available for Codex or OpenCode agents yet.'
      );
    const agentPath = await deps.getSessionAgentPath(sessionId);
    const agentId = agentPath ? deps.agentIdAtPath(agentPath) : undefined;
    const folder = agentPath ? deps.realFolder(agentPath) : undefined;
    if (!agentId || !folder || !deps.profiles.isBound(profileId, agentId, folder))
      throw new LocalBrowserError(
        'profile_not_allowed',
        'This agent can’t use this browser profile. A person can add it.'
      );
  };
}
