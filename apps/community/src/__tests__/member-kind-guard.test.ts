import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The rule agents-as-members keeps (specs/server-merge/03-agents-as-members.md, decision 10): a
 * `members` row is a person or an agent, so every SQL statement that reads or writes `members`
 * says which kinds it wants. Either the statement names `kind` itself (`m.kind='person'`), or the
 * line directly above the string that holds it says why it can only ever reach people:
 * `// member-kind: <key>`, with the key and its reason in member-kind-allowlist.json.
 *
 * The statement is found by parsing the TypeScript, so a comment that mentions the table is
 * never flagged, and a statement split across lines or built from a template is still one
 * string. The main risk this guards against is a new list of people that starts listing agents.
 */

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWLIST_PATH = fileURLToPath(new URL('./member-kind-allowlist.json', import.meta.url));
const MARKER = /^\s*\/\/\s*member-kind:\s*(\S*)\s*$/;
/** A read or write of the `members` table, quoted, schema-qualified or not. */
const TOUCHES_MEMBERS =
  /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?members"?(?![\w"])/i;
/**
 * The statement names a member kind: `kind='person'`, `m.kind<>'agent'`, `kind IN ('person',…)`.
 * Only the two values count, so another table's `kind` column (an erasure request's) does not.
 */
const NAMES_KIND = /(?:^|[^\w])(?:\w+\.)?kind\s*(?:(?:=|<>|!=)\s*|IN\s*\(\s*)'(?:person|agent)'/i;

/** One string or template that touches `members`, by the line it starts on. */
interface Found {
  line: number;
  statement: string;
}

/** Every string literal or template in `text` that touches `members`. */
function findMemberStatements(text: string): Found[] {
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    let statement: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) statement = node.text;
    else if (ts.isTemplateExpression(node))
      statement = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        ' ${…} '
      );
    if (statement !== undefined && TOUCHES_MEMBERS.test(statement)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, statement });
    }
    // A template's own spans are strings too; the template as a whole was checked above.
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else node.templateSpans.forEach((span) => ts.forEachChild(span, visit));
  };
  visit(source);
  return found;
}

/**
 * Check one file: every statement names a kind or carries a marker, directly above the line it
 * starts on, naming a key the allowlist gives a non-empty reason for.
 */
function checkFile(
  path: string,
  text: string,
  allowlist: Record<string, string>
): { problems: string[]; used: string[] } {
  const lines = text.split('\n');
  const problems: string[] = [];
  const used: string[] = [];
  for (const { line, statement } of findMemberStatements(text)) {
    if (NAMES_KIND.test(statement)) continue;
    const marker = MARKER.exec(lines[line - 2] ?? '');
    const where = `${path}:${line} (${statement.replace(/\s+/g, ' ').slice(0, 90)})`;
    if (!marker) {
      problems.push(`${where} reads members without a kind or a "// member-kind: <key>" marker`);
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
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const ALLOWLIST: Record<string, string> = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));

describe('member-kind guard (DOR-2876)', () => {
  // Purpose: the tree keeps the rule, and every allowlisted key is still used somewhere.
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
  });

  // Purpose: each spelling a statement can take is found, so a reformat cannot hide one.
  it.each([
    ['a one-line read', "query('SELECT id FROM members WHERE id=$1')"],
    ['a join split across lines', 'query(`SELECT 1 FROM agents a\n  JOIN\n  members m ON true`)'],
    ['a quoted, qualified table', 'query(\'UPDATE public."members" SET active=false\')'],
    ['an insert', "query('INSERT INTO members(id) VALUES($1)')"],
    ['a template with a value in it', 'query(`SELECT id FROM members WHERE ${where}`)'],
    ['a constant', "const SQL = 'SELECT 1 FROM members m WHERE m.id=$1';"],
  ])('catches %s', (_, source) => {
    expect(findMemberStatements(source)).toHaveLength(1);
    expect(checkFile('fixture.ts', source, ALLOWLIST).problems).toHaveLength(1);
  });

  // Purpose: what does not touch the table, or already names a kind, is not flagged.
  it.each([
    ['a comment', '// SELECT id FROM members\nconst x = 1;'],
    ['a similarly named table', "query('SELECT 1 FROM channel_members WHERE member_id=$1')"],
    ['a column list naming the table', "const tables = ['members', 'agents'];"],
    ['a statement that names a kind', "query(`SELECT id FROM members m WHERE m.kind='person'`)"],
  ])('passes %s', (_, source) => {
    expect(checkFile('fixture.ts', source, ALLOWLIST).problems).toEqual([]);
  });

  // Purpose: the marker must name a real, reasoned key, directly above the string.
  it('accepts a listed marker and refuses a missing, unknown, empty, or distant one', () => {
    const statement = "  await client.query('SELECT 1 FROM members WHERE user_id=$1');";
    const allowlist = { listed: 'a reason', empty: '  ' };
    const check = (source: string) => checkFile('fixture.ts', source, allowlist).problems;
    expect(check(`  // member-kind: listed\n${statement}`)).toEqual([]);
    expect(check(statement)[0]).toContain('without a kind');
    expect(check(`  // member-kind: unknown\n${statement}`)[0]).toContain('not in the allowlist');
    expect(check(`  // member-kind: empty\n${statement}`)[0]).toContain('reason is empty');
    expect(check(`  // member-kind: listed\n\n${statement}`)[0]).toContain('without a kind');
  });
});
