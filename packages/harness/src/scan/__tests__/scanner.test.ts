import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAuthoredSkills, scanSkillDirs, AGENTS_SKILLS_DIR } from '../scanner.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Create `<dir>/.agents/skills/<name>/SKILL.md` — a real, authored skill dir. */
function writeSkillDir(name: string): string {
  const abs = join(dir, AGENTS_SKILLS_DIR, name);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'SKILL.md'), `# ${name}\n`);
  return abs;
}

/**
 * Create a real skill directory OUTSIDE `.agents/skills` and link it in under
 * `linkName`, the way a person keeps skills in a shared folder and links them
 * into the repo. The link text is relative, like the engine's own.
 */
function linkSkillDir(realName: string, linkName: string): void {
  const real = join(dir, 'elsewhere', realName);
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'SKILL.md'), `# ${realName}\n`);
  mkdirSync(join(dir, AGENTS_SKILLS_DIR), { recursive: true });
  symlinkSync(join('..', '..', 'elsewhere', realName), join(dir, AGENTS_SKILLS_DIR, linkName));
}

/** The absolute `.agents/skills` root of the current temp repo. */
function skillsRoot(): string {
  return join(dir, AGENTS_SKILLS_DIR);
}

describe('listAuthoredSkills', () => {
  it('SRC-01: derives one entry per immediate skill dir containing SKILL.md', () => {
    // Skills a + b have SKILL.md; dir c and a stray file must be ignored.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    for (const name of ['a', 'b']) {
      mkdirSync(join(dir, '.agents', 'skills', name), { recursive: true });
      writeFileSync(join(dir, '.agents', 'skills', name, 'SKILL.md'), '# skill\n');
    }
    mkdirSync(join(dir, '.agents', 'skills', 'c'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'stray.txt'), 'x');

    expect(listAuthoredSkills(dir).skills).toEqual([
      { name: 'a', sourceDir: '.agents/skills/a' },
      { name: 'b', sourceDir: '.agents/skills/b' },
    ]);
  });

  it('returns an empty array when .agents/skills is absent', () => {
    // A repo with no skills root yields no skills and does not throw.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    expect(listAuthoredSkills(dir).skills).toEqual([]);
  });

  it('SK-13: skips a `<pkg>__<skill>` SYMLINK — that is a managed installed projection, not authored', () => {
    // The managed-projection predicate is `__` AND symlink: the engine only ever
    // writes a projection as a symlink, so this is the shape the authored scan
    // must not re-derive. (A real `__` directory is authored — see below.)
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('authored');
    linkSkillDir('projected', 'acme__projected');

    expect(listAuthoredSkills(dir).skills).toEqual([
      { name: 'authored', sourceDir: '.agents/skills/authored' },
    ]);
  });

  it('SK-13: finds an authored skill whose source directory is a symlink', () => {
    // `.agents/skills/x -> ../../elsewhere/x` is a skill a person authored
    // somewhere else and linked in. Codex follows it natively, so a scan that
    // skips it makes DorkOS strictly worse than nothing (DOR-1844).
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('authored');
    linkSkillDir('notes', 'notes');

    expect(listAuthoredSkills(dir).skills).toEqual([
      { name: 'authored', sourceDir: '.agents/skills/authored' },
      { name: 'notes', sourceDir: '.agents/skills/notes' },
    ]);
  });

  it('SK-13: finds a real directory whose name contains `__` — `__` alone does not mean managed', () => {
    // Only the engine writes `__` projections, and it writes them as symlinks.
    // A real directory named `my__helper` is something a person authored, so it
    // is scanned and projected like any other authored skill.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('my__helper');

    expect(listAuthoredSkills(dir).skills).toEqual([
      { name: 'my__helper', sourceDir: '.agents/skills/my__helper' },
    ]);
  });
});

describe('scanSkillDirs', () => {
  it('skips a dangling symlink without throwing', () => {
    // A link whose target was moved or deleted is not a skill. It must not
    // become a phantom entry, and it must not take the whole scan down with it.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('authored');
    mkdirSync(join(dir, AGENTS_SKILLS_DIR), { recursive: true });
    symlinkSync(join('..', '..', 'elsewhere', 'gone'), join(skillsRoot(), 'dangling'));

    expect(scanSkillDirs(skillsRoot(), AGENTS_SKILLS_DIR)).toEqual([
      { name: 'authored', sourceDir: '.agents/skills/authored' },
    ]);
  });

  it('SK-13: hides a `<pkg>__<skill>` symlink by default and returns it with includeManagedProjections', () => {
    // The two callers differ on purpose. The authored planning scan must not
    // re-derive what it already projected; the readers that mirror what Codex
    // sees in `.agents/skills` must include it, because Codex does.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('authored');
    linkSkillDir('projected', 'acme__projected');

    expect(scanSkillDirs(skillsRoot(), AGENTS_SKILLS_DIR)).toEqual([
      { name: 'authored', sourceDir: '.agents/skills/authored' },
    ]);
    expect(
      scanSkillDirs(skillsRoot(), AGENTS_SKILLS_DIR, { includeManagedProjections: true })
    ).toEqual([
      { name: 'acme__projected', sourceDir: '.agents/skills/acme__projected' },
      { name: 'authored', sourceDir: '.agents/skills/authored' },
    ]);
  });

  it('SK-13: skips a `__` symlink whose target directory has no SKILL.md, either way', () => {
    // `includeManagedProjections` lifts the managed-projection filter, never the
    // "must directly contain SKILL.md" rule.
    dir = mkdtempSync(join(tmpdir(), 'harness-scan-'));
    writeSkillDir('authored');
    mkdirSync(join(dir, 'elsewhere', 'empty'), { recursive: true });
    symlinkSync(join('..', '..', 'elsewhere', 'empty'), join(skillsRoot(), 'acme__empty'));

    const authoredOnly = [{ name: 'authored', sourceDir: '.agents/skills/authored' }];
    expect(scanSkillDirs(skillsRoot(), AGENTS_SKILLS_DIR)).toEqual(authoredOnly);
    expect(
      scanSkillDirs(skillsRoot(), AGENTS_SKILLS_DIR, { includeManagedProjections: true })
    ).toEqual(authoredOnly);
  });
});
