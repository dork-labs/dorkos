/**
 * A plain folder agent home (no git anywhere, as every `~/.dork/agents/<name>`
 * is) is untouched by the audited git runner (DOR-3343, QA's question on
 * #3216): its project lookup is "no project" with no refusal, every account
 * stays eligible for it, and a turn for its agent starts in it without git.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createProjectRootResolver } from '../resolve-project-root.js';
import { accountEligibility } from '../../core/usage/account-eligibility.js';
import { resolveSessionCwd } from '../../workspace/resolve-session-cwd.js';

let base: string;
let home: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'plain-agent-home-')));
  home = path.join(base, '.dork', 'agents', 'ana');
  mkdirSync(home, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('a plain folder agent home', () => {
  it('is in no project, and looking it up refuses nothing', async () => {
    const runGit = vi.fn(
      (await import('@dorkos/shared/safe-git')).runSafeGit as (
        ...args: Parameters<typeof import('@dorkos/shared/safe-git').runSafeGit>
      ) => Promise<string>
    );
    const resolver = createProjectRootResolver({ runGit });
    await expect(resolver.resolve(home)).resolves.toBeNull();
    // git ran and answered "no repository"; the audit did not refuse first.
    expect(runGit).toHaveBeenCalledTimes(1);
    await expect(runGit.mock.results[0]!.value).rejects.toMatchObject({ code: 128 });
  });

  it('keeps every account eligible, as a folder in no project always was', () => {
    const noRules = { get: () => undefined };
    expect(accountEligibility(noRules, 'claude-code', 'default', null)).toEqual({
      eligible: true,
    });
    expect(accountEligibility(noRules, 'claude-code', 'e2e-alpha', null)).toEqual({
      eligible: true,
    });
  });

  it('starts its agent’s turn in the home itself, never making a workspace', async () => {
    const ensureWorkspace = vi.fn();
    const resolved = await resolveSessionCwd(
      { agentPath: home },
      {
        // The schema's default binding, which every plain agent home carries.
        readManifest: async () => ({ name: 'ana', workspace: { mode: 'home' } }) as AgentManifest,
        ensureWorkspace,
        sessionAgentPath: async () => null,
        validateAgentHome: async (candidate) => candidate,
        validateManagedCheckout: async (candidate) => candidate,
        canonicalize: async (agentPath) => agentPath,
        defaultCwd: base,
      }
    );
    expect(resolved.cwd).toBe(home);
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });
});
