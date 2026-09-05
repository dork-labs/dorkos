/**
 * Tests for docs-coverage-map.mjs (DOR-1646, following DOR-558).
 *
 * Like the other files here it is a standalone Node module, not part of any
 * workspace, so it is tested with Node's built-in runner rather than Vitest.
 * Run it directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/docs-coverage-map.test.ts
 *
 * ## What is worth testing here
 *
 * `splitPatterns` shreds a table cell into regexes on paren-depth-0 pipes, and
 * `--match` swallows a pattern that will not compile — it returns false and
 * moves on, because it runs inside a Stop hook where throwing would cost the
 * whole turn's docs reminder. Those two facts together are how DOR-558's bug
 * lived silently: a cell that split badly produced fragments the regex engine
 * refused, the affected guide simply stopped being suggested, and nothing
 * anywhere said so. So the splitter gets pinned, and the modes that WRITE the
 * map get a compile check they cannot pass without.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPatterns, invalidPatterns } from '../docs-coverage-map.mjs';

const scriptDir = join(import.meta.dirname, '..');
const repoRoot = join(scriptDir, '..', '..');

/**
 * A throwaway repo holding a copy of the script and the INDEX.md it should
 * parse.
 *
 * The script resolves both `contributing/INDEX.md` and the JSON it writes from
 * its OWN location, so the only way to point `--regen` at a different table is
 * to stand up the same shape somewhere else. Worth it: the alternative is
 * breaking the real INDEX.md for the length of a test and hoping the restore
 * runs.
 *
 * @param indexBody - What `contributing/INDEX.md` should contain.
 * @returns The fake root and the path `--regen` would write.
 */
function fakeRepo(indexBody: string): { root: string; script: string; jsonPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-coverage-map-'));
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'contributing'), { recursive: true });
  const script = join(root, '.claude', 'scripts', 'docs-coverage-map.mjs');
  copyFileSync(join(scriptDir, 'docs-coverage-map.mjs'), script);
  writeFileSync(join(root, 'contributing', 'INDEX.md'), indexBody);
  return { root, script, jsonPath: join(root, '.claude', 'scripts', 'docs-coverage-map.json') };
}

/**
 * A Guide Coverage Map holding one row with this pattern cell.
 *
 * @param patternCell - The cell exactly as INDEX.md writes it: EVERY pipe is
 *   escaped as `\|`, whether it separates two patterns or belongs inside one
 *   alternation, because an unescaped pipe would end the markdown cell. That
 *   escaping is the table's, not the regex's; `parseTable` resolves it back to
 *   a literal pipe, and only then does `splitPatterns` decide which pipes were
 *   separators.
 */
function indexWith(patternCell: string): string {
  return [
    '## Guide Coverage Map',
    '',
    '| Guide | Description | Patterns |',
    '| ----- | ----------- | -------- |',
    `| \`testing.md\` | How tests work | \`${patternCell}\` |`,
    '',
    '## Pattern Syntax',
    '',
  ].join('\n');
}

/** A map shaped like the real one, carrying the patterns under test. */
function mapWith(patterns: string[]) {
  return {
    internalGuides: [{ guide: 'testing.md', description: '', patterns }],
    externalDocs: [],
  };
}

test('splitPatterns splits a cell on its separator pipes', () => {
  assert.deepEqual(splitPatterns('apps/server/src/|packages/relay/'), [
    'apps/server/src/',
    'packages/relay/',
  ]);
});

test('splitPatterns keeps an alternation whole', () => {
  // The pipe inside the parens belongs to THAT regex; splitting there would
  // leave `commands/(agent` and `task)`, neither of which compiles.
  assert.deepEqual(splitPatterns('commands/(agent|task|activity)'), [
    'commands/(agent|task|activity)',
  ]);
});

test('splitPatterns separates around an alternation, not inside it', () => {
  assert.deepEqual(splitPatterns('docs/|commands/(agent|task)|packages/cli/'), [
    'docs/',
    'commands/(agent|task)',
    'packages/cli/',
  ]);
});

test('splitPatterns handles nested parens', () => {
  assert.deepEqual(splitPatterns('src/((a|b)|c)|d'), ['src/((a|b)|c)', 'd']);
});

test('splitPatterns treats an unmatched closing paren as depth zero', () => {
  // Rather than going negative and swallowing every later pipe into one
  // fragment. The cell is malformed either way; `invalidPatterns` is what
  // reports it, and it can only do that if the split still produces the pieces.
  assert.deepEqual(splitPatterns('a)|b'), ['a)', 'b']);
});

test('splitPatterns returns one empty pattern for an empty cell', () => {
  assert.deepEqual(splitPatterns(''), ['']);
});

test('invalidPatterns is empty for a map whose patterns all compile', () => {
  assert.deepEqual(invalidPatterns(mapWith(['apps/server/src/', 'commands/(agent|task)'])), []);
});

test('invalidPatterns reports a fragment the regex engine refuses', () => {
  const bad = invalidPatterns(mapWith(['commands/(agent']));

  assert.equal(bad.length, 1);
  assert.equal(bad[0].owner, 'contributing/testing.md');
  assert.equal(bad[0].pattern, 'commands/(agent');
  assert.match(bad[0].reason, /group|Unterminated|Invalid/i);
});

test('invalidPatterns reports an empty pattern, which is skipped and covers nothing', () => {
  const bad = invalidPatterns(mapWith(['apps/server/src/', '']));

  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /empty/);
});

test('invalidPatterns names the external doc a bad pattern came from', () => {
  const bad = invalidPatterns({
    internalGuides: [],
    externalDocs: [{ doc: 'docs/api/index.mdx', description: '', patterns: ['a['] }],
  });

  assert.equal(bad.length, 1);
  assert.equal(bad[0].owner, 'docs/api/index.mdx');
});

test('the committed map contains no pattern that can never match', () => {
  // The artifact `--match` actually reads. Generated, so this should always be
  // true — and it is true only because nothing has broken it yet, which is the
  // whole reason to assert it.
  const map = JSON.parse(readFileSync(join(scriptDir, 'docs-coverage-map.json'), 'utf8'));

  assert.deepEqual(invalidPatterns(map), []);
});

test('--regen refuses to write a map containing a pattern that cannot compile', () => {
  // The wiring, not just the checker: before this, `--regen` wrote whatever
  // INDEX.md said and `--match` swallowed the consequences one file at a time.
  const { script, jsonPath } = fakeRepo(indexWith('commands/(agent'));

  const run = spawnSync(process.execPath, [script, '--regen'], { encoding: 'utf8' });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /can never match/);
  assert.match(run.stderr, /contributing\/testing\.md/);
  // Nothing written — a refusal that still emits the broken artifact is not one.
  assert.equal(existsSync(jsonPath), false);
});

test('--regen writes the map when every pattern compiles', () => {
  const { script, jsonPath } = fakeRepo(indexWith('commands/(agent\\|task)\\|docs/'));

  const run = spawnSync(process.execPath, [script, '--regen'], { encoding: 'utf8' });

  assert.equal(run.status, 0);
  const written = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(written.internalGuides[0].patterns, ['commands/(agent|task)', 'docs/']);
});

test('--check fails on a broken pattern the JSON and INDEX.md agree about', () => {
  // In sync and still broken, which is the only version of this that the drift
  // comparison cannot already catch: the JSON is written from the same table,
  // so `--check` has to be looking at the patterns themselves to say anything.
  // (`--print` is how the JSON is produced here — `--regen` now refuses.)
  const { script, jsonPath } = fakeRepo(indexWith('commands/(agent'));
  const printed = execFileSync(process.execPath, [script, '--print'], { encoding: 'utf8' });
  writeFileSync(jsonPath, printed);

  const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /can never match/);
  assert.doesNotMatch(run.stderr, /DRIFT/);
});

test('--match still prints guides and docs for a changed file', () => {
  // The modes call process.exit, so they only run when this file is EXECUTED,
  // never when it is imported the way the tests above import it. Get that
  // backwards and the Stop hook prints nothing at all — a silent failure of
  // exactly the kind this script exists to prevent — so the guard is spawned
  // for real rather than reasoned about.
  const out = execFileSync(
    process.execPath,
    [join(scriptDir, 'docs-coverage-map.mjs'), '--match', 'apps/server/src/routes/sessions.ts'],
    { cwd: repoRoot, encoding: 'utf8' }
  );

  assert.match(out, /^GUIDE:contributing\/.+$/m);
});
