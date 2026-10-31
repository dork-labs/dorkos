/**
 * An agent home inside a dotfiles `$HOME` repository whose own settings name a
 * program (a `credential.helper`), the case QA raised on #3216 (DOR-3343).
 *
 * Both halves of Security's ruling (2026-10-30): the agent still starts its
 * turn in its home and stays eligible for every account, as a folder in no
 * project; and a git read in that same folder is still refused, never run.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitRepoConfigUnsafeError, runSafeGit } from '@dorkos/shared/safe-git';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createProjectRootResolver, lookupProjectRoot } from '../resolve-project-root.js';
import { accountEligibility, projectOfFolder } from '../../core/usage/account-eligibility.js';
import { resolveSessionCwd } from '../../workspace/resolve-session-cwd.js';

let home: string;
let agentHome: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dotfiles-home-')));
  execFileSync('git', ['init', '-q'], { cwd: home });
  // A setting that names a program: git would run it as the server.
  execFileSync('git', ['config', '--local', 'credential.helper', 'store'], { cwd: home });
  agentHome = path.join(home, '.dork', 'agents', 'ana');
  mkdirSync(agentHome, { recursive: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('an agent home inside a dotfiles repository git will not read', () => {
  it('looks up as refused, not as a project and not as no repository', async () => {
    const resolver = createProjectRootResolver();
    await expect(resolver.lookup(agentHome)).resolves.toEqual({ kind: 'refused' });
  });

  it('is in no project for chat start and account eligibility, through the real registry', async () => {
    await expect(lookupProjectRoot(agentHome)).resolves.toEqual({ kind: 'refused' });
    const project = await projectOfFolder(agentHome);
    expect(project).toBeNull();
    const noRules = { get: () => undefined };
    expect(accountEligibility(noRules, 'claude-code', 'default', project)).toEqual({
      eligible: true,
    });
  });

  it('starts its agent’s turn in the home itself', async () => {
    const ensureWorkspace = vi.fn();
    const resolved = await resolveSessionCwd(
      { agentPath: agentHome },
      {
        readManifest: async () => ({ name: 'ana', workspace: { mode: 'home' } }) as AgentManifest,
        ensureWorkspace,
        sessionAgentPath: async () => null,
        validateAgentHome: async (candidate) => candidate,
        validateManagedCheckout: async (candidate) => candidate,
        canonicalize: async (agentPath) => agentPath,
        defaultCwd: home,
      }
    );
    expect(resolved.cwd).toBe(agentHome);
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it('still refuses a git read in that folder, and never runs it in the parent', async () => {
    await expect(runSafeGit(['status', '--porcelain=v1'], agentHome)).rejects.toBeInstanceOf(
      GitRepoConfigUnsafeError
    );
  });
});
