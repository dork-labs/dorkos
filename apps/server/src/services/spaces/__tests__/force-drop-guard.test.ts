import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Tests drop their throwaway databases through `dropTestDatabase` (`drop-test-database.ts`),
 * which waits for `pg_stat_activity` to drain before `WITH (FORCE)` (DOR-3696). A FORCE drop
 * straight after `Pool.end()` kills a connection still closing into an uncaught 57P01, and that
 * copy kept coming back in new tests.
 *
 * So any other string that force-drops a database needs `// force-drop: <key>` in the comment
 * lines directly above it, with the key and its reason in force-drop-allowlist.json. Strings are
 * found by parsing the TypeScript, so a comment that mentions FORCE is never flagged.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SCAN_ROOTS = ['apps/server/src', 'apps/space', 'apps/e2e'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);
const HELPER = 'apps/server/src/services/spaces/__tests__/drop-test-database.ts';
/** The helper, and the two tests whose fixtures spell out the drop it makes and the drops refused. */
const EXEMPT = new Set([
  HELPER,
  'apps/server/src/services/spaces/__tests__/drop-test-database.test.ts',
  'apps/server/src/services/spaces/__tests__/force-drop-guard.test.ts',
]);
const ALLOWLIST_PATH = fileURLToPath(new URL('./force-drop-allowlist.json', import.meta.url));
const MARKER = /^\s*\/\/\s*force-drop:\s*(\S*)\s*$/;
const FORCE_DROP = /\bDROP\s+DATABASE\b[\s\S]*\bWITH\s*\(\s*FORCE\s*\)/i;

/** The text of a string or template node, with each substitution as a placeholder. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('${…}');
  return undefined;
}

/** The 1-based line of every string or template in `text` that force-drops a database. */
function findForceDrops(text: string): number[] {
  // Most files never say FORCE; parsing only the ones that do keeps the tree scan fast.
  if (!/\bFORCE\b/i.test(text)) return [];
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const literal = literalText(node);
    if (literal !== undefined && FORCE_DROP.test(literal)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** The marker in the run of `//` comment lines directly above line `line` (1-based). */
function markerAbove(lines: readonly string[], line: number): RegExpExecArray | null {
  for (let index = line - 2; index >= 0 && /^\s*\/\//.test(lines[index]); index--) {
    const marker = MARKER.exec(lines[index]);
    if (marker) return marker;
  }
  return null;
}

/** Check one file: every FORCE drop carries a marker naming a key the allowlist gives a reason. */
function checkFile(
  path: string,
  text: string,
  allowlist: Record<string, string>
): { problems: string[]; used: string[] } {
  const lines = text.split('\n');
  const problems: string[] = [];
  const used: string[] = [];
  for (const line of findForceDrops(text)) {
    const where = `${path}:${line}`;
    const marker = markerAbove(lines, line);
    if (!marker) {
      problems.push(
        `${where} force-drops a database. Use dropTestDatabase() from ` +
          `drop-test-database.ts, or add a "// force-drop: <key>" marker with a reason.`
      );
      continue;
    }
    const key = marker[1];
    used.push(key);
    if (!(key in allowlist))
      problems.push(`${where} names "${key}", which is not in the allowlist`);
    else if (!allowlist[key]?.trim())
      problems.push(`${where} names "${key}", whose reason is empty`);
  }
  return { problems, used };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return SKIP_DIRECTORIES.has(name) ? [] : sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(name) ? [path] : [];
  });
}

const ALLOWLIST: Record<string, string> = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const BARE_DROP = '  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);';

describe('force-drop guard (DOR-3696)', () => {
  // Purpose: the tree keeps the rule, and every allowlisted key is still used somewhere.
  it('passes on the tree, and every allowlisted key is still in use', () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const root of SCAN_ROOTS) {
      for (const path of sourceFiles(join(REPO_ROOT, root))) {
        const file = relative(REPO_ROOT, path).replaceAll('\\', '/');
        if (EXEMPT.has(file)) continue;
        const result = checkFile(file, readFileSync(path, 'utf8'), ALLOWLIST);
        problems.push(...result.problems);
        for (const key of result.used) used.add(key);
      }
    }
    expect(problems).toEqual([]);
    expect(Object.keys(ALLOWLIST).filter((key) => !used.has(key))).toEqual([]);
    // A walk of three app trees: generous for a loaded CI runner, never a hang.
  }, 30_000);

  // Purpose: the helper the message points at really holds the one FORCE drop.
  it('finds the FORCE drop inside the helper', () => {
    expect(findForceDrops(readFileSync(join(REPO_ROOT, HELPER), 'utf8'))).toHaveLength(1);
  });

  // Purpose: a bare FORCE drop fails and names the helper, in each spelling it can take.
  it.each([
    ['a template', BARE_DROP],
    ['a plain string', "  await admin.query('DROP DATABASE IF EXISTS x WITH (FORCE)');"],
    ['lower case, split across lines', '  await q(`drop database if exists\n  x with ( force )`);'],
  ])('refuses %s', (_, source) => {
    const { problems } = checkFile('fixture.ts', source, ALLOWLIST);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('dropTestDatabase()');
  });

  // Purpose: the helper call, a plain drop, and a comment that names FORCE all pass.
  it.each([
    ['the helper', '  await dropTestDatabase(admin, dbName);'],
    ['a plain drop', '  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);'],
    ['a comment', '  // Never WITH (FORCE) after DROP DATABASE straight after db.end().'],
  ])('passes %s', (_, source) => {
    expect(checkFile('fixture.ts', source, ALLOWLIST).problems).toEqual([]);
  });

  // Purpose: the marker must name a real, reasoned key, directly above the drop.
  it('accepts a listed marker and refuses an unknown, empty, or distant one', () => {
    const allowlist = { listed: 'a reason', empty: '  ' };
    const check = (source: string) => checkFile('fixture.ts', source, allowlist).problems;
    expect(check(`  // force-drop: listed\n${BARE_DROP}`)).toEqual([]);
    expect(check(`  // force-drop: unknown\n${BARE_DROP}`)[0]).toContain('not in the allowlist');
    expect(check(`  // force-drop: empty\n${BARE_DROP}`)[0]).toContain('reason is empty');
    expect(check(`  // force-drop: listed\n\n${BARE_DROP}`)[0]).toContain('dropTestDatabase()');
  });
});
