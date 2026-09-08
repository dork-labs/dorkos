/**
 * What occupies a symlink target, and how each platform compares the link it
 * finds there against the plan.
 *
 * Two contract rows meet in this file, and both are about a person being told
 * something true rather than something shaped right:
 *
 * - **AP-16** — on a case-insensitive volume an existing `.claude/skills/Foo`
 *   occupies the path a planned `foo` link wants. Every `stat`-shaped probe
 *   agrees something is there, so the engine correctly refuses to write; what it
 *   used to leave out was the one fact that explains the refusal to somebody
 *   looking at a directory they believe is called something else.
 * - **AP-06 on Windows** — a Windows directory link is a JUNCTION, whose stored
 *   target is always absolute. The link-text comparison the engine has always
 *   made answers "drifted" for every junction, forever. The Windows branch is
 *   exercised for real by `.github/workflows/harness-windows.yml`; here it is
 *   pinned by passing the comparison explicitly, so the behaviour is tested on
 *   every platform rather than only where it happens to run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import {
  blockingSymlinkOccupant,
  linkCheckFor,
  linkMatchesPlan,
  SYMLINKS_OFF_REASON,
  SYMLINK_DIRECTORY_REASON,
  SYMLINK_FILE_REASON,
} from '../symlink-occupants.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A fresh temp dir for one case. */
function temp(): string {
  dir = mkdtempSync(join(tmpdir(), 'harness-symlink-occupants-'));
  return dir;
}

/**
 * Whether the volume the tests run on tells `a` and `A` apart.
 *
 * Asked of a real temp dir rather than assumed from the platform: macOS is
 * case-insensitive by default and case-SENSITIVE when the volume was formatted
 * that way, and the AP-16 shape cannot exist on the latter.
 */
function volumeIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'harness-case-probe-'));
  try {
    writeFileSync(join(probe, 'a'), '');
    return existsSync(join(probe, 'A'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const CASE_INSENSITIVE = volumeIsCaseInsensitive();

describe('blockingSymlinkOccupant', () => {
  it('is silent for an absent target and for a link of either kind', () => {
    const root = temp();
    symlinkSync('../elsewhere', join(root, 'live-ish'));
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    symlinkSync('../nowhere', join(root, 'dead'));

    expect(blockingSymlinkOccupant(join(root, 'absent'), '../src')).toBeUndefined();
    expect(blockingSymlinkOccupant(join(root, 'live-ish'), '../src')).toBeUndefined();
    expect(blockingSymlinkOccupant(join(root, 'dead'), '../src')).toBeUndefined();
  });

  it('names a real directory and a real file, so a conflict line says what is in the way', () => {
    const root = temp();
    mkdirSync(join(root, 'a-dir'));
    writeFileSync(join(root, 'a-file'), 'something of mine\n');

    expect(blockingSymlinkOccupant(join(root, 'a-dir'), '../src')).toBe(SYMLINK_DIRECTORY_REASON);
    expect(blockingSymlinkOccupant(join(root, 'a-file'), '../src')).toBe(SYMLINK_FILE_REASON);
  });

  it('calls a file holding exactly the link text a checkout with symlinks turned off', () => {
    const root = temp();
    writeFileSync(join(root, 'skill'), '../../.agents/skills/skill');

    expect(blockingSymlinkOccupant(join(root, 'skill'), '../../.agents/skills/skill')).toBe(
      SYMLINKS_OFF_REASON
    );
  });

  it('recognises the same file on Windows, where the plan spells the text with backslashes', () => {
    // git writes the symlink blob with POSIX separators on every platform, while
    // `path.relative` spells the plan's link text with backslashes on Windows.
    // Comparing raw would answer "no" on the one platform this case is about.
    const root = temp();
    writeFileSync(join(root, 'skill'), '../../.agents/skills/skill');

    expect(blockingSymlinkOccupant(join(root, 'skill'), '..\\..\\.agents\\skills\\skill')).toBe(
      SYMLINKS_OFF_REASON
    );
  });

  it('does not mistake a real file that merely starts with the link text', () => {
    const root = temp();
    writeFileSync(
      join(root, 'skill'),
      `../../.agents/skills/skill\n${'my own notes\n'.repeat(500)}`
    );

    expect(blockingSymlinkOccupant(join(root, 'skill'), '../../.agents/skills/skill')).toBe(
      SYMLINK_FILE_REASON
    );
  });

  it('names the case difference when the entry on disk differs only in case (AP-16)', (ctx) => {
    if (!CASE_INSENSITIVE) {
      ctx.skip('this volume tells "Foo" and "foo" apart, so the AP-16 shape cannot exist on it');
    }
    const root = temp();
    mkdirSync(join(root, 'Foo'));

    const reason = blockingSymlinkOccupant(join(root, 'foo'), '../src');
    expect(reason).toContain(SYMLINK_DIRECTORY_REASON);
    expect(reason).toContain('named "Foo"');
    expect(reason).toContain('does not tell "Foo" and "foo" apart');
  });

  it('says nothing about case when the name on disk matches exactly', () => {
    const root = temp();
    mkdirSync(join(root, 'foo'));

    expect(blockingSymlinkOccupant(join(root, 'foo'), '../src')).toBe(SYMLINK_DIRECTORY_REASON);
  });
});

describe('linkCheckFor', () => {
  it('compares link text everywhere but Windows, which compares where the link resolves', () => {
    expect(linkCheckFor('darwin')).toBe('link-text');
    expect(linkCheckFor('linux')).toBe('link-text');
    expect(linkCheckFor('win32')).toBe('resolved-target');
  });
});

describe('linkMatchesPlan', () => {
  it('accepts an absolute link on Windows, which is the only kind a junction can be', () => {
    // A junction's stored target is always absolute — Node resolves the relative
    // text against the link's parent before Windows ever sees it. A link-text
    // comparison therefore reports every junction as drifted forever, which is
    // `--check` never going clean and `--fix` recreating every link every run.
    const root = temp();
    const source = join(root, 'src');
    const target = join(root, 'link');
    mkdirSync(source);
    symlinkSync(source, target); // absolute text, exactly what a junction stores

    expect(linkMatchesPlan(target, source, 'src', 'resolved-target')).toBe(true);
    expect(linkMatchesPlan(target, source, 'src', 'link-text')).toBe(false);
  });

  it('accepts the relative text POSIX stores, and rejects a link to somewhere else', () => {
    const root = temp();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'other'));
    symlinkSync('src', join(root, 'link'));
    symlinkSync('other', join(root, 'wrong'));

    expect(linkMatchesPlan(join(root, 'link'), join(root, 'src'), 'src', 'link-text')).toBe(true);
    expect(linkMatchesPlan(join(root, 'link'), join(root, 'src'), 'src', 'resolved-target')).toBe(
      true
    );
    expect(linkMatchesPlan(join(root, 'wrong'), join(root, 'src'), 'src', 'link-text')).toBe(false);
    expect(linkMatchesPlan(join(root, 'wrong'), join(root, 'src'), 'src', 'resolved-target')).toBe(
      false
    );
  });

  it('answers false rather than throwing for a dead link', () => {
    const root = temp();
    symlinkSync('nowhere', join(root, 'dead'));

    expect(linkMatchesPlan(join(root, 'dead'), join(root, 'nowhere'), 'nowhere', 'link-text')).toBe(
      true // the text is right; the source is simply not there yet
    );
    expect(
      linkMatchesPlan(join(root, 'dead'), join(root, 'nowhere'), 'nowhere', 'resolved-target')
    ).toBe(false);
  });
});

describe('a differently-cased directory at a skill link target (AP-16, end to end)', () => {
  /** Stage a one-skill repo whose Claude Code projection is `.claude/skills/foo`. */
  function stageRepo(): string {
    const root = temp();
    writeJsonAt(join(root, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code'],
    });
    writeFileAt(join(root, 'AGENTS.md'), '# Project\n');
    writeFileAt(join(root, '.agents', 'skills', 'foo', 'SKILL.md'), '# foo\n');
    return root;
  }

  it('tells the person the name on disk is cased differently, in both --check and --fix', (ctx) => {
    if (!CASE_INSENSITIVE) {
      ctx.skip('this volume tells "Foo" and "foo" apart, so the AP-16 shape cannot exist on it');
    }
    const root = stageRepo();
    mkdirSync(join(root, '.claude', 'skills', 'Foo'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'Foo', 'SKILL.md'), '# mine\n');

    const drift = checkPlan(root, project(root));
    expect(drift.blocked.map((a) => a.target)).toEqual(['.claude/skills/foo']);
    expect(drift.blocked[0]?.reason).toContain('named "Foo"');
    expect(drift.clean).toBe(false);

    const { conflicts } = applyPlan(root, project(root), { sweepOrphans: true });
    expect(conflicts.map((a) => a.target)).toEqual(['.claude/skills/foo']);
    expect(conflicts[0]?.reason).toContain('named "Foo"');
    // Never destroyed, whatever it is called.
    expect(existsSync(join(root, '.claude', 'skills', 'Foo', 'SKILL.md'))).toBe(true);
  });
});
