/** Whether the agent behind a chat may use a named Agent browser profile. */
import { declaresGuard, type RuntimeGuards } from '@dorkos/shared/agent-runtime';
import { LocalBrowserError } from './errors.js';
import type { LocalBrowserProfileStore } from './profile-store.js';
import type { LocalBrowserOpen, LocalBrowserProfileChoice } from '@dorkos/shared/local-browser';

/** The verified launch facts this check reads; it never reads an agent's own files. */
export interface LocalBrowserProfileAccessDeps {
  profiles: Pick<LocalBrowserProfileStore, 'isBound'>;
  resolveSessionRuntime(sessionId: string): Promise<{ type: string; bound: boolean }>;
  /** The safety guards a runtime declares, or undefined for one this server doesn't have. */
  guardsOf(runtimeType: string): RuntimeGuards | undefined;
  getSessionAgentPath(sessionId: string): Promise<string | null>;
  agentIdAtPath(agentPath: string): string | undefined;
  /** The folder's real path, or undefined when it can't be read. */
  realFolder(agentPath: string): string | undefined;
}

/** Answers once per tool call. A refusal throws, so nothing is allowed by accident. */
export type LocalBrowserProfileAccess = (profileId: string, sessionId: string) => Promise<void>;
/** Capture synchronous proof from the host's current launch facts, never from client state. */
export type LocalBrowserProfileProof = (
  profileId: string,
  sessionId: string,
  agentId?: string
) => () => void;

/** Admission facts for the selected profile; no profile data is read here. */
export class BrowserProfileAccessGate {
  select?: (input: LocalBrowserOpen) => Promise<LocalBrowserProfileChoice>;
  exists?: (id: string) => boolean;
  private access?: LocalBrowserProfileAccess;
  private proof?: LocalBrowserProfileProof;
  use(
    access: LocalBrowserProfileAccess,
    exists: (id: string) => boolean,
    proof?: LocalBrowserProfileProof
  ): void {
    this.access = access;
    this.exists = exists;
    this.proof = proof;
  }

  capture(profileId: string, sessionId: string, agentId?: string): (() => void) | undefined {
    return this.proof?.(profileId, sessionId, agentId);
  }

  async require(profileId: string | null, sessionId: string): Promise<void> {
    if (!this.access)
      throw new LocalBrowserError('profile_not_allowed', 'This agent can’t use this profile.');
    await this.access(profileId ?? 'default', sessionId);
  }
}

/**
 * What an agent reads when its chat's runtime is not one DorkOS can confirm keeps its file tools
 * off the saved sign-ins (DOR-3596's `protectedPaths` guard, DOR-4678): true both for a runtime
 * that declares no such guard and for a chat whose runtime is only inferred, never launched.
 */
export const PROFILE_RUNTIME_MESSAGE =
  'Named browser profiles need a runtime DorkOS confirms keeps file tools out of saved ' +
  'sign-ins. It can’t confirm this chat’s runtime does.';

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
    // A profile holds live sign-ins, so its runtime must keep file tools off the profiles folder
    // and put a shell read of it to a person below Full. Read from what the runtime declares,
    // which fails closed (DOR-3596).
    assertProfileRuntime(deps.guardsOf, runtime);
    const agentPath = await deps.getSessionAgentPath(sessionId);
    requireProfileBinding(deps, profileId, agentPath);
  };
}

/** Shared by asynchronous tool guards and the synchronous pre-dispatch proof. */
export function assertProfileRuntime(
  guardsOf: LocalBrowserProfileAccessDeps['guardsOf'],
  runtime: { type: string; bound: boolean }
): void {
  if (!runtime.bound || !declaresGuard({ guards: guardsOf(runtime.type) }, 'protectedPaths'))
    throw new LocalBrowserError('profile_runtime', PROFILE_RUNTIME_MESSAGE);
}

type BindingDeps = Pick<LocalBrowserProfileAccessDeps, 'profiles' | 'agentIdAtPath' | 'realFolder'>;
/** Always reads the current signature and real folder; no cached grant is sufficient. */
export function requireProfileBinding(
  deps: BindingDeps,
  profileId: string,
  agentPath: string | null
) {
  const agentId = agentPath ? deps.agentIdAtPath(agentPath) : undefined;
  const folder = agentPath ? deps.realFolder(agentPath) : undefined;
  if (!agentId || !folder || !deps.profiles.isBound(profileId, agentId, folder))
    throw new LocalBrowserError(
      'profile_not_allowed',
      'This agent can’t use this browser profile. A person can add it.'
    );
  return { agentId, folder };
}

/** An existing server binding, read synchronously without runtime discovery or inference. */
export function createLocalBrowserProfileProof(
  deps: BindingDeps & {
    sessionFacts(id: string): { runtime: string | null; agentPath: string | null } | undefined;
    guardsOf: LocalBrowserProfileAccessDeps['guardsOf'];
  }
): LocalBrowserProfileProof {
  return (profileId, sessionId, expectedAgent) => {
    const facts = deps.sessionFacts(sessionId);
    if (!facts || !expectedAgent)
      throw new LocalBrowserError(
        'profile_not_allowed',
        'This browser is unavailable. Open it again.'
      );
    const birth = Object.freeze({ ...facts });
    const binding = requireProfileBinding(deps, profileId, birth.agentPath);
    const proof = () => {
      const current = deps.sessionFacts(sessionId);
      if (!current || current.runtime !== birth.runtime || current.agentPath !== birth.agentPath)
        throw new LocalBrowserError(
          'profile_not_allowed',
          'This browser is unavailable. Open it again.'
        );
      assertProfileRuntime(deps.guardsOf, {
        type: current.runtime ?? '',
        bound: !!current.runtime,
      });
      const live = requireProfileBinding(deps, profileId, current.agentPath);
      if (live.agentId !== expectedAgent || live.folder !== binding.folder)
        throw new LocalBrowserError(
          'profile_not_allowed',
          'This browser is unavailable. Open it again.'
        );
    };
    proof();
    return proof;
  };
}
