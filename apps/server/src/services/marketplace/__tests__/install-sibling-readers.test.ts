/**
 * Guard: every reader of an install root or a skills root skips the install
 * engine's own siblings through the one shared predicate (DOR-2273).
 *
 * A crash-left backup is a full copy of the previous install, valid manifest
 * and skills included. A reader that lists it shows a second Shape, a second
 * agent claiming the same id, or — in a skills root — a second live schedule.
 * Each reader fixed in DOR-2273 had simply never been told about backups, and
 * DOR-2245 adds more kinds of sibling. So this reads the source: a file that
 * lists a directory AND names one of those roots must call
 * `isInstallSiblingName` or be allow-listed below with the reason it is not
 * reading installs; and nothing may spell a marker of its own, because a
 * private copy silently misses the next kind.
 *
 * The root-naming test is a heuristic on purpose — it errs towards flagging,
 * and a false positive costs one allow-list line with a reason.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/** Source trees whose readers can meet an install root or a skills root. */
const SOURCE_TREES = [
  'apps/server/src',
  ...readdirSync(path.join(REPO_ROOT, 'packages')).map((pkg) => `packages/${pkg}/src`),
];

/**
 * Reads a directory's entries: lists it, or watches it (a watcher's events
 * reach a handler without passing through any scanner).
 */
const LISTS_A_DIRECTORY = /\breaddir(Sync)?\(|\bchokidar\.watch\(|\bfs\.watch\(/;

/** Names an install root or a skills root (a task root is a skills root). */
const NAMES_AN_INSTALL_OR_SKILLS_ROOT =
  /['"](plugins|agents|shapes|skills)['"]|INSTALL_ROOT|installRootsUnder|projectScopeRoot|AGENTS_SKILLS_DIR|GLOBAL_SKILLS_DIR|SkillsRoot\(|\bTaskRoot\b|SKILL_FILENAME/;

/** Central skills readers that name no root themselves but read every skills root. */
const CENTRAL_READERS = ['packages/skills/src/scanner.ts', 'packages/harness/src/scan/scanner.ts'];

/** Files the heuristic flags that do not read installs, and why. */
const NOT_READING_INSTALLS: Record<string, string> = {
  'apps/server/src/services/marketplace/lib/validate-package-schedules.ts':
    'reads the contents of the package being installed, not an install root',
  'apps/server/src/services/marketplace/flows/install-skill-pack.ts':
    'reads the contents of the package being installed',
  'apps/server/src/services/marketplace/permission-preview.ts':
    'reads the contents of the package being previewed',
  'apps/server/src/services/marketplace/flows/uninstall.ts':
    'reads the staged copy of the package it is removing',
  'packages/marketplace/src/package-validator.ts': 'reads the contents of a package',
  'apps/server/src/services/rooms/repo/room-worktree-manager.ts':
    'reads a room worktree, and names the skills dir only to recognise projection symlinks',
  'apps/server/src/services/shapes/shape-schedule-service.ts':
    'lists a directory only to ask whether it is empty before removing it',
  'apps/server/src/services/harness/skills-watcher.ts':
    'lists a skills root only to notice change; a sibling appearing triggers a projection, whose scanner skips it',
};

/** Every non-test TypeScript source file under the given trees, repo-relative. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(REPO_ROOT, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      const childRel = `${rel}/${name}`;
      if (statSync(path.join(REPO_ROOT, childRel)).isDirectory()) walk(childRel);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
        files.push(childRel);
      }
    }
  };
  for (const tree of SOURCE_TREES) walk(tree);
  return files;
}

describe('install sibling readers', () => {
  const files = sourceFiles();
  const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('finds the source it guards', () => {
    // A path mistake would make every check below vacuous.
    expect(files).toContain('apps/server/src/services/marketplace/installed-scanner.ts');
    expect(files.length).toBeGreaterThan(200);
  });

  it('every reader of an install or skills root skips install siblings', () => {
    const bypassing = files.filter((rel) => {
      if (rel in NOT_READING_INSTALLS) return false;
      const source = read(rel);
      const isReader =
        CENTRAL_READERS.includes(rel) ||
        (LISTS_A_DIRECTORY.test(source) && NAMES_AN_INSTALL_OR_SKILLS_ROOT.test(source));
      return isReader && !source.includes('isInstallSiblingName');
    });
    expect(bypassing).toEqual([]);
  });

  it('keeps no allow-list entry for a file that no longer needs one', () => {
    for (const rel of Object.keys(NOT_READING_INSTALLS)) {
      const source = read(rel);
      expect(
        LISTS_A_DIRECTORY.test(source) && NAMES_AN_INSTALL_OR_SKILLS_ROOT.test(source),
        rel
      ).toBe(true);
    }
  });

  it('spells no marker outside the shared definition', () => {
    // A private copy of a marker misses every kind added after it.
    const privateCopies = files.filter((rel) => {
      if (rel === 'packages/shared/src/marketplace-schemas.ts') return false;
      const source = read(rel);
      return (
        /['"`]\.dorkos-bak-['"`]/.test(source) ||
        /\.includes\(\s*MARKETPLACE_BACKUP_DIR_MARKER/.test(source)
      );
    });
    expect(privateCopies).toEqual([]);
  });
});
