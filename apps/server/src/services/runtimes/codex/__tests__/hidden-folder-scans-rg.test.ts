/**
 * @vitest-environment node
 *
 * The exclusion keys against the real `rg` Codex ships, driven the way Codex
 * 0.163 drives it on Linux (`expand_unreadable_globs_with_ripgrep`): one
 * `rg --files` per scan root, the profile's globs in key order, run from `/`
 * (its file helper) and from a command's folder. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCodexVendoredBinary } from '../check-dependencies.js';
import { codexScanRoot, keepScansOutOfHiddenFolders } from '../policy/hidden-folder-scans.js';

const binary = resolveCodexVendoredBinary();
const rg = binary ? path.join(path.dirname(path.dirname(binary)), 'codex-path', 'rg') : null;
const GLOB = /[*?[\]{}]/;

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hidden-rg-')));
  home = path.join(root, 'home');
  for (const file of [
    '.claude.json',
    '.claude/backups/.claude.json.backup.1',
    '.claude/projects/x/backups/.claude.json.backup.2',
    'backups/.claude.json.backup.3',
    'code/some-repo/.claude/backups/.claude.json.backup.4',
  ]) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), '{}');
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Every file Codex would mask for these keys, scanning from `cwd`. */
function masked(keys: Record<string, string>, cwd: string): string[] {
  const byRoot = new Map<string, string[]>();
  for (const key of Object.keys(keys).sort()) {
    if (!GLOB.test(key)) continue;
    const scanRoot = codexScanRoot(key)!;
    byRoot.set(scanRoot, [...(byRoot.get(scanRoot) ?? []), key.slice(scanRoot.length + 1)]);
  }
  const files: string[] = [];
  for (const [scanRoot, globs] of byRoot) {
    if (!fs.existsSync(scanRoot)) continue;
    let out = '';
    try {
      out = execFileSync(
        rg!,
        [
          '--no-config',
          '--files',
          '--hidden',
          '--no-ignore',
          ...globs.flatMap((glob) => ['--glob', glob]),
          '--',
          scanRoot,
        ],
        { cwd, encoding: 'utf8' }
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      if (failure.status !== 1 || failure.stderr) throw error;
    }
    for (const line of out.split('\n').filter(Boolean))
      files.push(path.isAbsolute(line) ? line : path.join(scanRoot, line));
  }
  return [...new Set(files)].sort();
}

describe.skipIf(rg === null || !fs.existsSync(rg ?? ''))('the exclusions with Codex’s rg', () => {
  const profile = () => ({
    [`${home}/**/.claude.json*`]: 'deny' as const,
    [`${home}/.claude.json*`]: 'deny' as const,
    [`${home}/.claude/.credentials*`]: 'deny' as const,
    [path.join(home, '.claude', 'backups')]: 'deny' as const,
  });

  it.each([
    ['the file helper at /', () => '/'],
    ['a command in an unrelated folder', () => '/usr'],
    ['a command in a project below home', () => path.join(home, 'code', 'some-repo')],
  ])('skips only the hidden folder from %s', (_label, cwd) => {
    const hidden = path.join(home, '.claude', 'backups', '.claude.json.backup.1');
    const others = [
      path.join(home, '.claude.json'),
      path.join(home, '.claude', 'projects', 'x', 'backups', '.claude.json.backup.2'),
      path.join(home, 'backups', '.claude.json.backup.3'),
      path.join(home, 'code', 'some-repo', '.claude', 'backups', '.claude.json.backup.4'),
    ];
    // Without the skip, Codex masks the file inside the hidden folder: DOR-3949.
    expect(masked(profile(), cwd())).toContain(hidden);
    const files = masked(keepScansOutOfHiddenFolders(profile(), [], 'linux'), cwd());
    expect(files).not.toContain(hidden);
    for (const other of others) expect(files).toContain(other);
  });

  it.each([
    ['home', () => home],
    ['a folder above home', () => root],
  ])(
    'still masks the hidden file when rg runs from %s, so that command fails closed',
    (_label, cwd) => {
      const files = masked(keepScansOutOfHiddenFolders(profile(), [], 'linux'), cwd());
      expect(files).toContain(path.join(home, '.claude', 'backups', '.claude.json.backup.1'));
    }
  );

  // Security's M1 on #3541: from a command folder P, the key relative to `/`
  // also matches P + the hidden path. A copy of that path under a scan root
  // (an `rsync -R` backup, an extracted rootfs) keeps every mask instead.
  describe('with a copy of the home path under home', () => {
    let copy: string;
    beforeEach(() => {
      copy = path.join(home, 'chain', home.slice(1), '.claude', 'backups', '.claude.json.backup.5');
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, '{}');
    });

    it('adds no exclusion and drops no mask', () => {
      expect(keepScansOutOfHiddenFolders(profile(), [], 'linux')).toEqual(profile());
    });

    it.each([
      ['the copy’s own folder', () => path.join(home, 'chain')],
      ['the file helper at /', () => '/'],
      ['a command in a project below home', () => path.join(home, 'code', 'some-repo')],
    ])('keeps the copy masked from %s', (_label, cwd) => {
      const files = masked(keepScansOutOfHiddenFolders(profile(), [], 'linux'), cwd());
      expect(files).toContain(copy);
      expect(files).toContain(path.join(home, '.claude', 'backups', '.claude.json.backup.1'));
    });
  });
});
