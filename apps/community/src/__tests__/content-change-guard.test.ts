import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The invariant every content change keeps (specs/community-single-item-delete): a change to
 * what an existing entry shows bumps the content version first and then writes one
 * `entry_redactions` row for that entry, in the same transaction. `content-removal.ts` does
 * that. Any other statement that changes entries, their mentions, or which entry a file
 * belongs to must say, on the line before it, which reviewed exception it is:
 * `// content-change: <key>`, with the key and its reason in content-change-allowlist.json.
 */

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWLIST_PATH = fileURLToPath(new URL('./content-change-allowlist.json', import.meta.url));
/** The one module that may change content without a marker: it keeps the invariant itself. */
const EXEMPT = 'content-removal.ts';
const MARKER = /^\s*\/\/\s*content-change:\s*(\S*)\s*$/;

/** A table name, with or without quotes and a schema prefix, and nothing after it. */
const table = (names: string) => `(?:"?public"?\\s*\\.\\s*)?"?(?:${names})"?(?![\\w"])`;

const STATEMENTS = [
  new RegExp(`\\bUPDATE\\s+${table('entries|entry_mentions')}`, 'gi'),
  new RegExp(`\\bDELETE\\s+FROM\\s+${table('entries|attachments|entry_mentions')}`, 'gi'),
  new RegExp(`\\bINSERT\\s+INTO\\s+${table('entry_mentions')}`, 'gi'),
  // A table named at run time could be any of the above.
  /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+\$\{/gi,
];
/** `UPDATE attachments [[AS] alias] SET <clause>`: counted only when the clause sets entry_id. */
const ATTACHMENT_UPDATE = new RegExp(
  `\\bUPDATE\\s+${table('attachments')}(?:\\s+(?:AS\\s+)?(?!SET\\b)"?\\w+"?)?\\s+SET\\b([\\s\\S]*?)(?=\\bWHERE\\b|\\bFROM\\b|\\bRETURNING\\b|[\`';]|$)`,
  'gi'
);
const SETS_ENTRY_ID = /(?:^|[\s,])(?:"?\w+"?\s*\.\s*)?"?entry_id"?\s*=/i;

/** One content-changing statement found in a source text, by the line it starts on. */
interface Found {
  line: number;
  statement: string;
}

/** Find every content-changing statement in `text`, case- and whitespace-insensitively. */
function findContentChanges(text: string): Found[] {
  const found: Found[] = [];
  const at = (index: number, statement: string) =>
    found.push({ line: text.slice(0, index).split('\n').length, statement });
  for (const pattern of STATEMENTS)
    for (const match of text.matchAll(pattern)) at(match.index, match[0]);
  for (const match of text.matchAll(ATTACHMENT_UPDATE))
    if (SETS_ENTRY_ID.test(match[1])) at(match.index, match[0].split('\n')[0]);
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Check one file: every statement needs a marker on the line before it naming a key the
 * allowlist gives a non-empty reason for. Returns the problems and the keys the file used.
 */
function checkFile(
  path: string,
  text: string,
  allowlist: Record<string, string>
): { problems: string[]; used: string[] } {
  if (path === EXEMPT) return { problems: [], used: [] };
  const lines = text.split('\n');
  const problems: string[] = [];
  const used: string[] = [];
  for (const { line, statement } of findContentChanges(text)) {
    const marker = MARKER.exec(lines[line - 2] ?? '');
    const where = `${path}:${line} (${statement.replace(/\s+/g, ' ')})`;
    if (!marker) {
      problems.push(`${where} changes content without a "// content-change: <key>" marker`);
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
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const ALLOWLIST: Record<string, string> = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));

describe('content-change guard (AC-11)', () => {
  // Purpose: the tree keeps the invariant: every content change outside content-removal.ts is
  // a reviewed exception, and every exception in the allowlist is still used somewhere.
  it('passes on the source tree, and every allowlisted key is still in use', () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const path of sourceFiles(SOURCE_ROOT)) {
      const result = checkFile(
        relative(SOURCE_ROOT, path).replaceAll('\\', '/'),
        readFileSync(path, 'utf8'),
        ALLOWLIST
      );
      problems.push(...result.problems);
      for (const key of result.used) used.add(key);
    }
    expect(problems).toEqual([]);
    expect(Object.keys(ALLOWLIST).filter((key) => !used.has(key))).toEqual([]);
    for (const [key, reason] of Object.entries(ALLOWLIST))
      expect([key, reason.trim()]).not.toEqual([key, '']);
  });

  // Purpose: each spelling a statement can take is caught, so a rename or reformat cannot slip
  // a content change past the guard; each would pass unseen with a naive substring match.
  it.each([
    ['lower case with an upper-case table', "query('update ENTRIES set text=$1')"],
    ['a quoted table with an alias', 'query(`UPDATE "entries" e SET text=$1`)'],
    ['a schema prefix', "query('UPDATE public.entries SET text=$1')"],
    ['a statement split across lines', 'query(`UPDATE\n     entries\n   SET text=$1`)'],
    ['an aliased file rebind', "query('UPDATE attachments AS a SET entry_id=$1 WHERE a.id=$2')"],
    ['a quoted, qualified file rebind', 'query(`UPDATE "attachments" f SET f."entry_id"=$1`)'],
    ['a mention insert', "query('INSERT INTO entry_mentions(entry_id) VALUES($1)')"],
    ['a delete split across lines', 'query(`DELETE FROM\n  attachments WHERE id=$1`)'],
    ['a mention update', "query('UPDATE entry_mentions SET position=1')"],
    ['a table named at run time', 'query(`DELETE FROM ${table} WHERE community_id=$1`)'],
  ])('catches %s', (_, source) => {
    expect(findContentChanges(source)).toHaveLength(1);
    expect(checkFile('fixture.ts', source, ALLOWLIST).problems).toHaveLength(1);
  });

  // Purpose: statements that change nothing an entry shows are not flagged, so the guard does
  // not train people to add markers everywhere.
  it.each([
    [
      'a file cleanup counter',
      "query('UPDATE attachments SET cleanup_attempts=1 WHERE entry_id IS NULL')",
    ],
    ['a read', "query('SELECT entry_id FROM attachments WHERE id=$1')"],
    ['a similarly named table', "query('UPDATE entries_archive SET text=$1')"],
  ])('ignores %s', (_, source) => {
    expect(findContentChanges(source)).toEqual([]);
  });

  // Purpose: the marker must name a real, reasoned exception, directly above the statement.
  it('accepts a listed marker and refuses a missing, unknown, empty, or distant one', () => {
    const statement = "  await client.query('UPDATE entries SET text=$1');";
    const allowlist = { listed: 'a reason', empty: '  ' };
    const check = (source: string) => checkFile('fixture.ts', source, allowlist).problems;
    expect(check(`  // content-change: listed\n${statement}`)).toEqual([]);
    expect(check(statement)[0]).toContain('without a');
    expect(check(`  // content-change: unknown\n${statement}`)[0]).toContain(
      'not in the allowlist'
    );
    expect(check(`  // content-change: empty\n${statement}`)[0]).toContain('reason is empty');
    expect(check(`  // content-change: listed\n\n${statement}`)[0]).toContain('without a');
    // content-removal.ts keeps the invariant itself.
    expect(checkFile(EXEMPT, statement, allowlist).problems).toEqual([]);
  });
});
