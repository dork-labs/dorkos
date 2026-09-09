/**
 * The symlink type the apply stage asks Windows for.
 *
 * POSIX ignores the third argument to `symlinkSync`; Windows does not, and the
 * two directory shapes it offers are not interchangeable. A **directory symlink**
 * is the real thing — git commits it as a link, mode 120000 — and creating one
 * needs Developer Mode or an administrator. A **junction** needs no privilege,
 * and git commits the files inside it instead of the link (DOR-1883). So the
 * engine asks a one-time capability probe and takes the real link where it can
 * (`apply/windows-links.ts`).
 *
 * Either way the decision has to FOLLOW the source: a skill source that is
 * itself a symlink to a directory is still a directory link.
 *
 * `process.platform` is redefined rather than the module mocked, so the real
 * `applyPlan` runs and the assertion is on the argument the real call carried;
 * the probe is substituted, which is what lets both of its answers be driven
 * from a POSIX machine.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from '../apply.js';
import { canSymlinkDirs, setDirSymlinkProbe } from '../windows-links.js';
import type { ProjectionPlan } from '../../plan/types.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) };
});

let repo = '';
const realPlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  // The machine most people are on: no Developer Mode, so a junction is all
  // Windows will make. The cases that need the other answer say so.
  setDirSymlinkProbe(() => false);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  setDirSymlinkProbe(undefined);
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

/** A plan with one skill symlink from `.agents/skills/<name>` into `.claude/skills`. */
function linkPlan(name: string): ProjectionPlan {
  return {
    actions: [
      {
        kind: 'symlink',
        artifact: 'skill',
        harness: 'claude-code',
        provenance: 'authored',
        name,
        source: `.agents/skills/${name}`,
        target: `.claude/skills/${name}`,
      },
    ],
    drops: [],
    warnings: [],
    notEnabled: [],
  };
}

/** The symlink type argument the apply stage passed for the single link it made. */
function requestedType(): unknown {
  expect(vi.mocked(symlinkSync)).toHaveBeenCalledTimes(1);
  return vi.mocked(symlinkSync).mock.calls[0][2];
}

/** Stage a repository holding one authored skill as a real directory. */
function stageSkill(tag: string, name: string): void {
  repo = mkdtempSync(join(tmpdir(), `harness-symtype-${tag}-`));
  mkdirSync(join(repo, '.agents', 'skills', name), { recursive: true });
  writeFileSync(join(repo, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
}

describe('the Windows symlink type', () => {
  it('AP-06: asks for a real directory symlink when this machine may make one', () => {
    // The whole of DOR-1883: with the privilege, git commits mode 120000 and a
    // link committed from Windows is still a link. The engine used to ask for a
    // junction here whatever the machine could do.
    setDirSymlinkProbe(() => true);
    stageSkill('privileged', 'plain');

    applyPlan(repo, linkPlan('plain'));

    expect(requestedType()).toBe('dir');
  });

  it('AP-06: falls back to a junction when the source is a real directory and the privilege is not there', () => {
    stageSkill('real', 'plain');

    applyPlan(repo, linkPlan('plain'));

    expect(requestedType()).toBe('junction');
  });

  it('AP-06: asks for a directory link when the source is itself a symlink to a directory', () => {
    // A skill kept elsewhere in the repo and linked into `.agents/skills`. The
    // source is a link, but what it names is a DIRECTORY, so Windows still needs
    // a directory link — reading the link itself instead of what it points at
    // asks for a file link and fails with EPERM off Developer Mode.
    repo = mkdtempSync(join(tmpdir(), 'harness-symtype-link-'));
    mkdirSync(join(repo, 'vendor', 'shared'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'shared', 'SKILL.md'), '# shared\n');
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    symlinkSync('../../vendor/shared', join(repo, '.agents', 'skills', 'linked'));
    vi.mocked(symlinkSync).mockClear();

    applyPlan(repo, linkPlan('linked'));

    expect(requestedType()).toBe('junction');
  });

  it('AP-06: asks for a file link when the source is a file', () => {
    repo = mkdtempSync(join(tmpdir(), 'harness-symtype-file-'));
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'note'), 'not a dir\n');

    applyPlan(repo, linkPlan('note'));

    // Nothing was probed on the way: a file link is not the decision the probe
    // answers, and a run of file sources must not pay for one.
    expect(requestedType()).toBe('file');
  });

  it('AP-06: never asks the machine anything on POSIX, where the type argument is ignored', () => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    const probe = vi.fn(() => true);
    setDirSymlinkProbe(probe);
    stageSkill('posix', 'plain');

    applyPlan(repo, linkPlan('plain'));

    expect(requestedType()).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('AP-06: asks the machine once, however many links a plan makes', () => {
    const probe = vi.fn(() => false);
    setDirSymlinkProbe(probe);
    stageSkill('memo', 'plain');
    mkdirSync(join(repo, '.agents', 'skills', 'second'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'second', 'SKILL.md'), '# second\n');

    applyPlan(repo, {
      ...linkPlan('plain'),
      actions: [...linkPlan('plain').actions, ...linkPlan('second').actions],
    });

    expect(vi.mocked(symlinkSync)).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    // And the answer is remembered for the process, not for the plan.
    expect(canSymlinkDirs()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
