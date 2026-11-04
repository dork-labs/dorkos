/**
 * The shell guard as one launch registers it (DOR-3300), kept apart so the launch stays short.
 *
 * @module services/runtimes/claude-code/shell-guard/shell-guard-launch
 */
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { expandTilde } from '../../../../lib/boundary.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import { createShellRefusalRecorder, type AuditToolHookOptions } from '../audit-tool-hooks.js';
import { resolveClaudeRootSet } from '../claude-config-dir.js';
import type { CeilingedMode } from '../turn-permission.js';
import { goingOnWithoutCheck, guardHost } from './guard-service.js';
import { createShellPathGuardHook } from './shell-path-guard.js';

/** What a launch knows that the guard needs. */
export interface ShellGuardLaunch {
  /** The turn's working folder. */
  cwd: string;
  /** The launch's Claude Code account folder. */
  accountRoot: string;
  /** The environment the launch's shell starts with. */
  env: Readonly<Record<string, string | undefined>>;
  /** The agent registry, when this runtime has one. */
  registry?: Partial<Pick<AgentRegistryPort, 'listWithPaths'>> | null;
  /** The agent's home, when a person opened it to this agent's own shell. */
  openHome?: string;
  /** The session and turn a refusal is recorded against. */
  audit: AuditToolHookOptions;
}

/**
 * The `PreToolUse` registration: on the tools that take a shell command, with folders read at call time, so a warm process
 * sees an agent registered after it started.
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param launch - What this launch knows.
 */
export function shellGuardMatcher(
  session: CeilingedMode<PermissionModeId>,
  launch: ShellGuardLaunch
): HookCallbackMatcher {
  const { cwd, accountRoot, env, registry, openHome, audit } = launch;
  return {
    matcher: 'Bash|Monitor|PowerShell',
    hooks: [
      createShellPathGuardHook(session, {
        roots: () => ({
          cwd,
          dorkHome: resolveDorkHome(),
          home: expandTilde('~'),
          accounts: [...new Set([accountRoot, ...resolveClaudeRootSet()])],
          env,
          agentHomes: () => registry?.listWithPaths?.().map((agent) => agent.projectPath) ?? [],
          ...(openHome ? { openHome } : {}),
        }),
        check: (command, roots, reads) => guardHost().check(command, roots, reads),
        goingOnWithoutCheck,
        recordRefusal: createShellRefusalRecorder(audit),
        log: logger,
      }),
    ],
  };
}
