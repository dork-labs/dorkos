/**
 * The Windows link capability, and the one thing a person is told when it is
 * missing.
 *
 * Every case here runs on the machine you are reading this on. `process.platform`
 * is redefined rather than the module mocked, so the real `applyPlan` and the
 * real `checkPlan` run and the assertions are about what they actually did; the
 * capability probe is substituted, which is what lets both branches of a
 * Windows-only decision be driven from POSIX.
 *
 * A junction is staged as what a junction IS on disk: a link whose stored text
 * is ABSOLUTE (this module's header, and `linkCheckFor`'s, on why that is the
 * discriminator). The `windows-latest` leg is what proves the staging matches a
 * junction Windows really made — see `j10-clone-without-symlinks.test.ts`.
 *
 * @module apply/__tests__/windows-links
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, checkPlan } from '../apply.js';
import {
  JUNCTION_COMMIT_WARNING,
  canSymlinkDirs,
  isJunctionAt,
  setDirSymlinkProbe,
} from '../windows-links.js';
import type { ProjectionPlan } from '../../plan/types.js';

const realPlatform = process.platform;
const staged: string[] = [];

/** Pretend to be the platform under test for the duration of one case. */
function pretendPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  pretendPlatform('win32');
});

afterEach(() => {
  pretendPlatform(realPlatform);
  setDirSymlinkProbe(undefined);
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository with `n` authored skills and a plan that links each into `.claude/skills`. */
function stageRepo(tag: string, names: readonly string[]): { repo: string; plan: ProjectionPlan } {
  const repo = mkdtempSync(join(tmpdir(), `harness-junction-${tag}-`));
  staged.push(repo);
  for (const name of names) {
    mkdirSync(join(repo, '.agents', 'skills', name), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });
  return {
    repo,
    plan: {
      actions: names.map((name) => ({
        kind: 'symlink' as const,
        artifact: 'skill' as const,
        harness: 'claude-code' as const,
        provenance: 'authored' as const,
        name,
        source: `.agents/skills/${name}`,
        target: `.claude/skills/${name}`,
      })),
      drops: [],
      warnings: [],
      notEnabled: [],
    },
  };
}

/**
 * Put a junction at a skill's projection target: a link whose stored text is
 * absolute, which is what Windows stores for one and what every predicate under
 * test reads.
 */
function stageJunction(repo: string, name: string): void {
  symlinkSync(join(repo, '.agents', 'skills', name), join(repo, '.claude', 'skills', name));
}

/** Make `repo` look like a git checkout, which is what the warning is about. */
function stageGitDir(repo: string): void {
  mkdirSync(join(repo, '.git'), { recursive: true });
}

describe('the Windows directory-link capability', () => {
  it('AP-06: the probe setter is not on the package surface', async () => {
    // It decides what kind of link every sync in the process makes. Tests reach
    // it by importing the module; a consumer reaching it through the barrel
    // could set it once and poison every projection after that.
    const barrel = await import('../../index.js');

    expect(Object.keys(barrel)).toContain('JUNCTION_COMMIT_WARNING');
    expect(Object.keys(barrel)).not.toContain('setDirSymlinkProbe');
  });

  it('AP-06: the probe answers yes or no and never throws', () => {
    // The real probe, on the real filesystem this suite is running on. It is the
    // only assertion here that does not substitute one, and the Windows leg runs
    // it against Windows: whatever it says, it says it without a stack trace.
    expect(typeof canSymlinkDirs()).toBe('boolean');
  });

  it('AP-06: a junction is recognised by its absolute stored text, on any platform', () => {
    const { repo } = stageRepo('recognise', ['alpha']);
    stageJunction(repo, 'alpha');
    const junction = join(repo, '.claude', 'skills', 'alpha');
    expect(isJunctionAt(junction)).toBe(true);

    // A relative link is the real thing, and the same path with POSIX rules is
    // nothing at all — the predicate never speaks about a machine it is not on.
    rmSync(junction, { force: true });
    symlinkSync(join('..', '..', '.agents', 'skills', 'alpha'), junction);
    expect(isJunctionAt(junction)).toBe(false);

    stageJunction(repo, 'beta-as-junction');
    pretendPlatform(realPlatform);
    expect(isJunctionAt(join(repo, '.claude', 'skills', 'beta-as-junction'))).toBe(false);
  });
});

describe('what a person is told about committing junctions', () => {
  it('AP-06: warns once per run when junctions sit in a git repository', () => {
    const { repo, plan } = stageRepo('warn', ['alpha', 'beta']);
    stageJunction(repo, 'alpha');
    stageJunction(repo, 'beta');
    stageGitDir(repo);

    // Two links, ONE sentence: the fact is about the machine, not about a path.
    expect(applyPlan(repo, plan).warnings).toEqual([JUNCTION_COMMIT_WARNING]);
  });

  it('AP-06: --check says exactly what --fix says, so nobody commits on the quieter answer', () => {
    const { repo, plan } = stageRepo('check', ['alpha']);
    stageJunction(repo, 'alpha');
    stageGitDir(repo);

    expect(checkPlan(repo, plan).warnings).toEqual([JUNCTION_COMMIT_WARNING]);
    // And it is not drift: the link resolves where the plan says, so a Windows
    // machine without Developer Mode still goes clean.
    expect(checkPlan(repo, plan).drifted).toEqual([]);
    expect(checkPlan(repo, plan).clean).toBe(true);
  });

  it('AP-06: says nothing outside a git repository, where there is nothing to commit', () => {
    const { repo, plan } = stageRepo('nogit', ['alpha']);
    stageJunction(repo, 'alpha');

    expect(applyPlan(repo, plan).warnings).toEqual([]);
    expect(checkPlan(repo, plan).warnings).toEqual([]);
  });

  it('AP-06: says nothing when the links are real symlinks', () => {
    const { repo, plan } = stageRepo('real', ['alpha']);
    stageGitDir(repo);

    // Written by the engine itself, on a machine that may make real links.
    setDirSymlinkProbe(() => true);
    expect(applyPlan(repo, plan).warnings).toEqual([]);
    expect(checkPlan(repo, plan).warnings).toEqual([]);
  });

  it('AP-06: says nothing on POSIX, where no link is ever a junction', () => {
    const { repo, plan } = stageRepo('posix', ['alpha']);
    stageJunction(repo, 'alpha');
    stageGitDir(repo);
    pretendPlatform(realPlatform);

    expect(applyPlan(repo, plan).warnings).toEqual([]);
    expect(checkPlan(repo, plan).warnings).toEqual([]);
  });
});
