import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The `os.homedir()` carve-outs are written down once, and match the lint
 * (DOR-4940).
 *
 * The call ban (Hard Rule 3) lives in `apps/server/eslint.config.js` as the
 * `no-restricted-properties` block, whose `ignores` exempt whole files; a file
 * may instead disable the rule on one line. `.claude/rules/dork-home.md` is the
 * one list of those exemptions people read: AGENTS.md and REVIEW.md only point
 * at it, after they once disagreed about how many there were. This census
 * holds the table's first column equal to the block's `ignores` plus every
 * file with an inline disable, so neither side can gain or lose a carve-out
 * alone. `scripts/test-homedir-guard.sh` proves what the rule does to each.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const RULES_FILE = '.claude/rules/dork-home.md';
const RULE = 'no-restricted-properties';

interface FlatBlock {
  ignores?: string[];
  rules?: Record<string, unknown>;
}

/** The server's flat ESLint config, as ESLint loads it. */
const serverEslintConfig = (
  (await import(pathToFileURL(path.join(ROOT, 'apps/server/eslint.config.js')).href)) as {
    default: FlatBlock[];
  }
).default;

/** The ESLint `ignores` of the block that sets the homedir call ban. */
function callBanIgnores(): string[] {
  const blocks = serverEslintConfig.filter((block) => {
    const setting = block.rules?.[RULE];
    return Array.isArray(setting) && JSON.stringify(setting).includes('"property":"homedir"');
  });
  expect(blocks, 'expected exactly one homedir call-ban block').toHaveLength(1);
  return blocks[0]?.ignores ?? [];
}

/** Server source files that disable the call ban on a line, relative to `apps/server`. */
function inlineDisables(): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-l', '-E', `eslint-disable(-next)?(-line)? ${RULE}`, '--', 'src'],
    { cwd: path.join(ROOT, 'apps/server'), encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

/** The `Where` column of the carve-out table, as globs relative to `apps/server`. */
function documentedCarveOuts(): string[] {
  const text = readFileSync(path.join(ROOT, RULES_FILE), 'utf8');
  const start = text.indexOf('**The carve-outs, in full.**');
  expect(start, `${RULES_FILE} lost its "The carve-outs, in full." table`).toBeGreaterThan(-1);
  const lines = text.slice(start).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  const end = lines.findIndex((line, i) => i > first && !line.startsWith('|'));
  return lines
    .slice(first + 2, end) // past the header and divider
    .flatMap((row) => [...(row.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)])
    .map((match) => `src/${match[1]}`);
}

describe('the os.homedir() carve-out census', () => {
  const ignores = callBanIgnores();
  const inline = inlineDisables();
  const documented = documentedCarveOuts();

  it('read both sides, so it cannot pass on nothing', () => {
    expect(ignores).toContain('src/lib/dork-home.ts');
    expect(inline).toContain('src/lib/boundary.ts');
    expect(documented.length).toBeGreaterThanOrEqual(5);
  });

  it(`the ${RULES_FILE} table equals the lint's exemptions`, () => {
    const enforced = [...new Set([...ignores, ...inline])].sort();
    expect(
      [...new Set(documented)].sort(),
      `Add or remove the row in ${RULES_FILE}, or the exemption in apps/server/eslint.config.js.`
    ).toEqual(enforced);
  });

  it('every carve-out names a file that exists', () => {
    const missing = documented
      .filter((entry) => !entry.includes('*'))
      .filter((file) => !existsSync(path.join(ROOT, 'apps/server', file)));
    expect(missing).toEqual([]);
  });
});
