/**
 * Which accounts may work in which projects (spec `flow-multiproject` §8.2-§8.3):
 * the two rules, how they combine, how they read stored config, and the four
 * plain refusal sentences.
 *
 * The rule is pure apart from the canonical-path step, so the truth table runs
 * on `readEligibilityRules` + `judgeEligibility` with an identity `canonical`;
 * the canonicalization cases use real temporary folders and the real step.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { notAllowedReason } from '../account-ranking.js';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import {
  AccountNotAllowedError,
  accountEligibility,
  assertAccountEligible,
  describeAccountRefusal,
  warnMalformedAccountRules,
  eligibleAccountIds,
  judgeEligibility,
  onlyProjectsOf,
  projectOfFolder,
  projectRefFor,
  readEligibilityRules,
  refusalFor,
  type EligibilityConfigReader,
} from '../account-eligibility.js';

const CLIENT_APP = '/projects/client-app';
const DORKOS = '/projects/dorkos';
const CLIENT: ProjectRef = { root: CLIENT_APP, name: 'client-app' };
const DORK: ProjectRef = { root: DORKOS, name: 'dorkos' };

const identity = (dir: string) => dir;

/** A config reader over one stored `runtimes.claudeCode` block. */
function config(claudeCode: unknown): EligibilityConfigReader {
  return { get: () => ({ claudeCode }) };
}

describe('judgeEligibility: the truth table (spec §8.2, N6)', () => {
  /**
   * Build the rules for one account `work` and one project `dorkos`.
   *
   * @param own - `work`'s own rule: null = any project, or its list.
   * @param projectAllow - `dorkos`'s rule: undefined = no entry, or its allow list.
   */
  function rules(own: string[] | null, projectAllow?: string[]) {
    return readEligibilityRules(
      {
        accounts: [{ id: 'work', path: '/a/work', onlyProjects: own }],
        ...(projectAllow ? { projectAccounts: { [DORKOS]: { allow: projectAllow } } } : {}),
      },
      identity
    );
  }

  it.each([
    // own rule        project entry          project   eligible  reason
    [null, undefined, DORKOS, true, undefined],
    [null, ['work'], DORKOS, true, undefined],
    [null, ['other'], DORKOS, false, 'project-allowlist'],
    [[DORKOS], undefined, DORKOS, true, undefined],
    [[DORKOS], ['work'], DORKOS, true, undefined],
    [[DORKOS], ['other'], DORKOS, false, 'project-allowlist'],
    [[CLIENT_APP], undefined, DORKOS, false, 'only-projects'],
    [[CLIENT_APP], ['work'], DORKOS, false, 'only-projects'],
    [[CLIENT_APP], ['other'], DORKOS, false, 'only-projects'],
    [null, undefined, null, true, undefined],
    [null, ['other'], null, true, undefined],
    [[DORKOS], undefined, null, false, 'only-projects'],
    [[DORKOS], ['work'], null, false, 'only-projects'],
  ] as const)(
    'own %j × project entry %j × project %s → eligible %s (%s)',
    (own, allow, project, eligible, reason) => {
      // Purpose: an account works in a project only when BOTH rules allow it,
      // and a restricted account never serves "no project".
      const verdict = judgeEligibility(
        rules(own === null ? null : [...own], allow ? [...allow] : undefined),
        'work',
        project
      );
      expect(verdict.eligible).toBe(eligible);
      if (!verdict.eligible) expect(verdict.reason).toBe(reason);
    }
  );

  it('names the roots an account is kept to in an only-projects verdict', () => {
    // Purpose: the refusal names where the account may work, so the list must travel.
    const verdict = judgeEligibility(rules([CLIENT_APP]), 'work', DORKOS);
    expect(verdict).toEqual({
      eligible: false,
      reason: 'only-projects',
      allowedRoots: [CLIENT_APP],
    });
  });

  it("judges Main (`default`) by defaultAccountOnlyProjects, never by a row's rule", () => {
    // Purpose: Main has no registry row; its rule lives at the block level.
    const r = readEligibilityRules(
      {
        accounts: [{ id: 'work', path: '/a/work', onlyProjects: null }],
        defaultAccountOnlyProjects: [CLIENT_APP],
      },
      identity
    );
    expect(judgeEligibility(r, 'default', CLIENT_APP).eligible).toBe(true);
    expect(judgeEligibility(r, 'default', DORKOS)).toMatchObject({
      eligible: false,
      reason: 'only-projects',
    });
    expect(judgeEligibility(r, 'default', null).eligible).toBe(false);
    expect(judgeEligibility(r, 'work', DORKOS).eligible).toBe(true);
  });

  it("holds Main to a project's allow list like any other account", () => {
    // Purpose: the project rule lists ids, and `default` is Main's id there.
    const r = readEligibilityRules(
      { projectAccounts: { [DORKOS]: { allow: ['work'] } } },
      identity
    );
    expect(judgeEligibility(r, 'default', DORKOS)).toEqual({
      eligible: false,
      reason: 'project-allowlist',
    });
    expect(judgeEligibility(r, 'default', CLIENT_APP).eligible).toBe(true);
  });

  it('treats an unregistered id as having no own rule, but still applies the project rule', () => {
    // Purpose: an id with no row has nothing keeping it anywhere; only the project decides.
    const r = readEligibilityRules(
      { accounts: [], projectAccounts: { [DORKOS]: { allow: ['work'] } } },
      identity
    );
    expect(judgeEligibility(r, 'ghost', CLIENT_APP).eligible).toBe(true);
    expect(judgeEligibility(r, 'ghost', null).eligible).toBe(true);
    expect(judgeEligibility(r, 'ghost', DORKOS).eligible).toBe(false);
  });

  it('keeps a list that names no project to no project at all', () => {
    // Purpose: `[]` is "in no project", not "any project".
    const r = rules([]);
    expect(judgeEligibility(r, 'work', DORKOS)).toMatchObject({
      eligible: false,
      reason: 'only-projects',
    });
    expect(judgeEligibility(r, 'work', null).eligible).toBe(false);
  });
});

describe('readEligibilityRules: stored shapes', () => {
  it('reads absence as no rules at all', () => {
    // Purpose: an install the migration has not reached must keep launching anywhere.
    for (const block of [undefined, null, 'nonsense', [], {}]) {
      const r = readEligibilityRules(block, identity);
      expect(r.onlyProjectsById.size).toBe(0);
      expect(r.defaultOnlyProjects).toBeNull();
      expect(r.projectAllow.size).toBe(0);
    }
  });

  it('reads hand-edited bad shapes as no rule rather than failing', () => {
    // Purpose: a mangled config.json degrades to "allowed", never a thrown launch.
    const r = readEligibilityRules(
      {
        accounts: [
          'not-a-row',
          { path: '/no/id' },
          { id: 'work', onlyProjects: 'client-app' },
          { id: 'other', onlyProjects: { root: DORKOS } },
        ],
        defaultAccountOnlyProjects: 'client-app',
        projectAccounts: {
          [DORKOS]: { allow: 'work' },
          [CLIENT_APP]: 'work',
          '/projects/mixed': { allow: ['work', 42, null] },
        },
      },
      identity
    );
    expect(r.onlyProjectsById.get('work')).toBeNull();
    expect(r.onlyProjectsById.get('other')).toBeNull();
    expect(r.defaultOnlyProjects).toBeNull();
    expect(r.projectAllow.has(DORKOS)).toBe(false);
    expect(r.projectAllow.has(CLIENT_APP)).toBe(false);
    expect(r.projectAllow.get('/projects/mixed')).toEqual(['work']);
    expect(judgeEligibility(r, 'work', DORKOS).eligible).toBe(true);
    expect(judgeEligibility(r, 'default', null).eligible).toBe(true);
  });

  it('keeps the first row for a duplicated id', () => {
    // Purpose: a doubled id must not let a later row loosen the first one's rule.
    const r = readEligibilityRules(
      {
        accounts: [
          { id: 'work', onlyProjects: [CLIENT_APP] },
          { id: 'work', onlyProjects: null },
        ],
      },
      identity
    );
    expect(r.onlyProjectsById.get('work')).toEqual([CLIENT_APP]);
  });
});

describe('canonical roots', () => {
  let dir: string;
  let realRoot: string;
  let linkRoot: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dorkos-eligibility-'));
    await mkdir(path.join(dir, 'real', 'client-app'), { recursive: true });
    realRoot = await realpath(path.join(dir, 'real', 'client-app'));
    linkRoot = path.join(dir, 'link-to-client-app');
    await symlink(realRoot, linkRoot);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('matches a stored root with a trailing slash to the canonical project root', () => {
    // Purpose: a person's hand-typed `/x/` must not silently lock the account out of `/x`.
    const cfg = config({ accounts: [{ id: 'work', onlyProjects: [`${realRoot}/`] }] });
    const project = { root: realRoot, name: 'client-app' };
    expect(accountEligibility(cfg, 'claude-code', 'work', project)).toEqual({ eligible: true });
  });

  it('matches a stored symlinked root to the canonical project root, on both rules', () => {
    // Purpose: macOS `/tmp` and `/var` are symlinks; a rule written through one still holds.
    const cfg = config({
      accounts: [{ id: 'work', onlyProjects: [linkRoot] }],
      projectAccounts: { [`${linkRoot}/`]: { allow: ['work'] } },
    });
    const project = { root: realRoot, name: 'client-app' };
    expect(accountEligibility(cfg, 'claude-code', 'work', project)).toEqual({ eligible: true });
    expect(accountEligibility(cfg, 'claude-code', 'other', project)).toMatchObject({
      eligible: false,
      reason: 'project-allowlist',
    });
  });

  it('canonicalizes through the injected step', () => {
    // Purpose: every root in both rules goes through `canonical`, not just some of them.
    const r = readEligibilityRules(
      {
        accounts: [{ id: 'work', onlyProjects: ['A', 'a'] }],
        defaultAccountOnlyProjects: ['B'],
        projectAccounts: { C: { allow: ['work'] } },
      },
      (d) => `/canon/${d.toLowerCase()}`
    );
    expect(r.onlyProjectsById.get('work')).toEqual(['/canon/a']);
    expect(r.defaultOnlyProjects).toEqual(['/canon/b']);
    expect([...r.projectAllow.keys()]).toEqual(['/canon/c']);
  });
});

describe('accountEligibility / eligibleAccountIds / onlyProjectsOf', () => {
  const cfg = config({
    accounts: [
      { id: 'work', onlyProjects: [CLIENT_APP] },
      { id: 'personal', onlyProjects: null },
      { id: 'spare' },
    ],
    defaultAccountOnlyProjects: [DORKOS],
    projectAccounts: { [DORKOS]: { allow: ['default', 'spare'] } },
  });

  it('names the allowed projects of an only-projects verdict', () => {
    // Purpose: the verdict carries ProjectRefs a sentence can name, falling back to the basename.
    expect(accountEligibility(cfg, 'claude-code', 'work', DORK)).toEqual({
      eligible: false,
      reason: 'only-projects',
      allowedProjects: [{ root: CLIENT_APP, name: 'client-app' }],
    });
  });

  it('carries the project in a project-allowlist verdict', () => {
    // Purpose: the sentence names the project whose rule refused.
    expect(accountEligibility(cfg, 'claude-code', 'personal', DORK)).toEqual({
      eligible: false,
      reason: 'project-allowlist',
      project: DORK,
    });
  });

  it('always allows accounts of a runtime with no rules', () => {
    // Purpose: only Claude Code has account rules; Codex ids must never be filtered.
    expect(accountEligibility(cfg, 'codex', 'work', DORK)).toEqual({ eligible: true });
    expect(eligibleAccountIds(cfg, 'codex', ['work', 'default'], null)).toEqual([
      'work',
      'default',
    ]);
  });

  it('keeps the eligible subset in the order given', () => {
    // Purpose: callers pass a ranking; filtering must not reorder it.
    expect(
      eligibleAccountIds(cfg, 'claude-code', ['spare', 'work', 'personal', 'default'], DORK)
    ).toEqual(['spare', 'default']);
    expect(
      eligibleAccountIds(cfg, 'claude-code', ['default', 'personal', 'work', 'spare'], CLIENT)
    ).toEqual(['personal', 'work', 'spare']);
    expect(
      eligibleAccountIds(cfg, 'claude-code', ['work', 'spare', 'default', 'personal'], null)
    ).toEqual(['spare', 'personal']);
  });

  it('reads an unreadable config as no rules', () => {
    // Purpose: a settings read failure degrades to "allowed", never a failed launch.
    const broken: EligibilityConfigReader = {
      get: () => {
        throw new Error('not initialized');
      },
    };
    expect(accountEligibility(broken, 'claude-code', 'work', DORK)).toEqual({ eligible: true });
  });

  it("lists an account's projects by name, Main's included, and null for any project", () => {
    // Purpose: Settings shows "Only for …" from this.
    expect(onlyProjectsOf(cfg, 'work')).toEqual([{ root: CLIENT_APP, name: 'client-app' }]);
    expect(onlyProjectsOf(cfg, 'default')).toEqual([{ root: DORKOS, name: 'dorkos' }]);
    expect(onlyProjectsOf(cfg, 'personal')).toBeNull();
    expect(onlyProjectsOf(cfg, 'unregistered')).toBeNull();
  });

  it('names an unknown root by its folder, in the characters a project name may hold', () => {
    // Purpose: a rule naming a project the registry has not seen still reads as a name.
    expect(projectRefFor('/some/where/my app')).toEqual({
      root: '/some/where/my app',
      name: 'my-app',
    });
  });

  it('reads an empty, relative or missing folder as no project', async () => {
    // Purpose: several callers pass `''`; that must be "no project", never a throw.
    await expect(projectOfFolder('')).resolves.toBeNull();
    await expect(projectOfFolder(undefined)).resolves.toBeNull();
    await expect(projectOfFolder(null)).resolves.toBeNull();
    await expect(projectOfFolder('relative/dir')).resolves.toBeNull();
  });
});

describe('the refusal (spec §8.3)', () => {
  it('names the account and where it may work, for a named account', () => {
    // Purpose: spec §8.3 "Named account" sentence, word for word.
    expect(
      describeAccountRefusal(DORK, 'Work', {
        reason: 'only-projects',
        allowedProjects: [CLIENT],
      })
    ).toBe(
      "Work can't be used in dorkos. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes."
    );
  });

  it('names the project whose allow list leaves the account out', () => {
    // Purpose: spec §8.3 "Project allowlist" sentence.
    expect(
      describeAccountRefusal(DORK, 'Work', { reason: 'project-allowlist', project: DORK })
    ).toBe(
      "dorkos isn't set to use Work. Pick another account, or remove dorkos's account limit in Settings → Runtimes."
    );
  });

  it('says nothing may work in the project when no account is eligible', () => {
    // Purpose: spec §8.3 "Nothing eligible" sentence.
    expect(describeAccountRefusal(DORK, null, { reason: 'none-eligible' })).toBe(
      'No account is allowed to work in dorkos. Choose which accounts it may use in Settings → Runtimes.'
    );
  });

  it("says the folder isn't in a project for a restricted account", () => {
    // Purpose: spec §8.3 "No project" sentence.
    expect(
      describeAccountRefusal(null, 'Work', { reason: 'only-projects', allowedProjects: [CLIENT] })
    ).toBe(
      "Work is set to work only in client-app, and this folder isn't in a project. Pick another account."
    );
  });

  it('joins several allowed projects as a person would read them', () => {
    // Purpose: "a, b and c", not a comma dump.
    expect(
      describeAccountRefusal(DORK, 'Work', {
        reason: 'only-projects',
        allowedProjects: [
          CLIENT,
          { root: '/p/api', name: 'client-api' },
          { root: '/p/x', name: 'x' },
        ],
      })
    ).toContain('only in client-app, client-api and x.');
  });

  it('says "not used in any project" for an account kept to none', () => {
    // Purpose: one wording for an empty list, the same as the Settings row and
    // the pickers show.
    expect(
      describeAccountRefusal(DORK, 'Work', { reason: 'only-projects', allowedProjects: [] })
    ).toBe(
      'Work is not used in any project. Pick another account, or change this in Settings → Runtimes.'
    );
    expect(notAllowedReason({ reason: 'only-projects', allowedProjects: [] }, DORK)).toBe(
      'Not used in any project'
    );
  });

  it('carries code, project and account id in the 409 body', () => {
    // Purpose: every surface keys off `account_not_allowed_here`; the body must carry it.
    const error = refusalFor(
      config({ accounts: [{ id: 'work', label: 'Work', onlyProjects: [CLIENT_APP] }] }),
      'work',
      DORK,
      { eligible: false, reason: 'only-projects', allowedProjects: [CLIENT] }
    );
    expect(error).toBeInstanceOf(AccountNotAllowedError);
    expect(error.status).toBe(409);
    expect(error.toBody()).toEqual({
      error: error.message,
      message: error.message,
      code: 'account_not_allowed_here',
      project: DORK,
      accountId: 'work',
    });
    // The account is named as the person calls it (its label), not by its id.
    expect(error.message.startsWith("Work can't be used in dorkos.")).toBe(true);
  });

  it('calls Main by name and carries a null account for none-eligible', () => {
    // Purpose: `default` reads as "Main"; a none-eligible refusal names no account.
    const cfg = config({ defaultAccountOnlyProjects: [CLIENT_APP] });
    expect(() => assertAccountEligible(cfg, 'claude-code', 'default', DORK)).toThrow(
      "Main can't be used in dorkos."
    );
    const none = new AccountNotAllowedError(DORK, null, { reason: 'none-eligible' });
    expect(none.toBody()).toMatchObject({ accountId: null, project: DORK });
    expect(none.code).toBe('account_not_allowed_here');
  });

  it('does nothing for an eligible account', () => {
    // Purpose: the assertion is silent on the allowed path.
    expect(() => assertAccountEligible(config({}), 'claude-code', 'work', DORK)).not.toThrow();
  });
});

describe('malformed hand-edited rules', () => {
  // Purpose: a rule dropped as malformed is said once at boot, naming each path,
  // and a well-formed config says nothing.
  it('warns once, naming each malformed rule', () => {
    const warn = vi.fn();
    const config = {
      get: () => ({
        claudeCode: {
          defaultAccountOnlyProjects: 'client-app',
          accounts: [
            { id: 'work', onlyProjects: [''] },
            { id: 'ok', onlyProjects: null },
          ],
          projectAccounts: { '/w/a': {}, '/w/b': { allow: ['work'] } },
        },
      }),
    };
    expect(warnMalformedAccountRules(config, warn)).toEqual([
      'runtimes.claudeCode.defaultAccountOnlyProjects',
      'runtimes.claudeCode.accounts.0.onlyProjects',
      'runtimes.claudeCode.projectAccounts["/w/a"]',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);

    const quiet = vi.fn();
    warnMalformedAccountRules(
      { get: () => ({ claudeCode: { projectAccounts: { '/w/b': { allow: ['work'] } } } }) },
      quiet
    );
    expect(quiet).not.toHaveBeenCalled();
  });
});
