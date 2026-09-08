/**
 * The disk reads that decide whether a projection may be called `native`.
 *
 * `buildPlan` is filesystem-free on purpose, so these loaders are the only place
 * the engine looks at `.claude/commands` and at each `claudeOnlySkills` entry's
 * declared path. Every false native this repo has had was one of them answering
 * a question nobody asked it, so each answer is pinned here directly rather than
 * only through a plan.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCommandsExist, scanClaudeOnlySkills } from '../engine.js';
import { parseHarnessManifest } from '../manifest/schema.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A fresh empty temp repo. */
function repo(): string {
  dir = mkdtempSync(join(tmpdir(), 'harness-engine-inputs-'));
  return dir;
}

/** Write `content` at `<repo>/<rel>`, creating parents. */
function write(root: string, rel: string, content = '# x\n'): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('claudeCommandsExist', () => {
  it('is false when .claude/commands does not exist at all', () => {
    expect(claudeCommandsExist(repo())).toBe(false);
  });

  it('is false when .claude/commands exists but is EMPTY', () => {
    // The case the plan used to call `native` with a straight face: a directory
    // is not a command, and Claude Code loads nothing from an empty one.
    const root = repo();
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    expect(claudeCommandsExist(root)).toBe(false);
  });

  it('is false when the directory holds files that are not commands', () => {
    const root = repo();
    write(root, '.claude/commands/README.txt');
    write(root, '.claude/commands/.gitignore', '*\n');
    expect(claudeCommandsExist(root)).toBe(false);
  });

  it('is true for a top-level .md', () => {
    const root = repo();
    write(root, '.claude/commands/review.md');
    expect(claudeCommandsExist(root)).toBe(true);
  });

  it('is true for a NESTED .md, which is how Claude Code namespaces a command', () => {
    // The recursive branch the TSDoc claims. `.claude/commands/adr/create.md` is
    // `/adr:create`, so a repo whose only commands are namespaced has commands —
    // a top-level-only check would call it command-less and say nothing about a
    // directory full of them.
    const root = repo();
    mkdirSync(join(root, '.claude', 'commands', 'adr'), { recursive: true });
    write(root, '.claude/commands/adr/create.md');
    expect(claudeCommandsExist(root)).toBe(true);
  });

  it('does not follow a symlinked subdirectory out of the repository', () => {
    // A question about THIS repo's commands is not a question about wherever a
    // link points.
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'));
    try {
      write(outside, 'secret.md');
      mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
      symlinkSync(outside, join(root, '.claude', 'commands', 'linked'));
      expect(claudeCommandsExist(root)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('scanClaudeOnlySkills', () => {
  /** A manifest with one entry, optionally overriding its declared `path`. */
  function manifest(name: string, path?: string) {
    return parseHarnessManifest({
      version: 1,
      claudeOnlySkills: [
        { name, path: path ?? `.claude/skills/${name}`, reason: 'kept Claude-only' },
      ],
    });
  }

  it('resolves the conventional path to a directory, and marks it the projection target', () => {
    const root = repo();
    write(root, '.claude/skills/secret/SKILL.md');
    expect(scanClaudeOnlySkills(root, manifest('secret')).get('secret')).toEqual({
      path: '.claude/skills/secret',
      kind: 'directory',
      atProjectionTarget: true,
    });
  });

  it('follows the entry’s OWN path when it names one elsewhere', () => {
    // Reading the entry's claim instead of assuming the convention is what stops
    // a real skill at `docs/skills/oddball` being reported as a stale entry.
    const root = repo();
    write(root, 'docs/skills/oddball/SKILL.md');
    expect(
      scanClaudeOnlySkills(root, manifest('oddball', 'docs/skills/oddball')).get('oddball')
    ).toEqual({ path: 'docs/skills/oddball', kind: 'directory', atProjectionTarget: false });
  });

  it('reports a symlink as a symlink, whatever it resolves to', () => {
    const root = repo();
    write(root, '.agents/skills/linked/SKILL.md');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      join('..', '..', '.agents', 'skills', 'linked'),
      join(root, '.claude/skills/linked')
    );
    expect(scanClaudeOnlySkills(root, manifest('linked')).get('linked')?.kind).toBe('symlink');
  });

  it('reports a dangling symlink as a symlink too, not as missing', () => {
    // It is still not a skill kept as a real directory, which is the only thing
    // the entry is allowed to claim.
    const root = repo();
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(join('..', '..', 'nowhere'), join(root, '.claude/skills/dangling'));
    expect(scanClaudeOnlySkills(root, manifest('dangling')).get('dangling')?.kind).toBe('symlink');
  });

  it('reports a directory with no SKILL.md as missing, because nothing would load it', () => {
    const root = repo();
    mkdirSync(join(root, '.claude', 'skills', 'empty'), { recursive: true });
    expect(scanClaudeOnlySkills(root, manifest('empty')).get('empty')?.kind).toBe('missing');
  });

  it('reports nothing there as missing', () => {
    expect(scanClaudeOnlySkills(repo(), manifest('ghost')).get('ghost')).toEqual({
      path: '.claude/skills/ghost',
      kind: 'missing',
      atProjectionTarget: true,
    });
  });

  it('returns one entry per manifest entry, so nothing is silently skipped', () => {
    const root = repo();
    const three = parseHarnessManifest({
      version: 1,
      claudeOnlySkills: ['a', 'b', 'c'].map((name) => ({
        name,
        path: `.claude/skills/${name}`,
        reason: 'kept Claude-only',
      })),
    });
    write(root, '.claude/skills/a/SKILL.md');
    const resolved = scanClaudeOnlySkills(root, three);
    expect(resolved.size).toBe(3);
    expect([...resolved.keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});
