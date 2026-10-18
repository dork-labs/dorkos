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
/** Where a table name starts: after a keyword that names a table, or after a comma join. */
const TABLE_START = String.raw`(?:\b(?:FROM|JOIN|UPDATE|INTO|USING)\s+(?:ONLY\s+)?|,\s*)`;
/**
 * One reference to the `members` table, quoted, schema-qualified or not, and the alias after it
 * when there is one. Group 1 is the alias, or a keyword {@link NOT_AN_ALIAS} rules out.
 */
const MEMBERS_REF = new RegExp(
  String.raw`${TABLE_START}(?:"?public"?\s*\.\s*)?"?members"?(?![\w"])(?:\s+(?:AS\s+)?"?([a-z_]\w*)"?)?`,
  'gi'
);
/** Words that may follow a table name but are never its alias. */
const NOT_AN_ALIAS =
  /^(?:WHERE|ON|SET|GROUP|ORDER|LEFT|RIGHT|INNER|FULL|CROSS|JOIN|USING|LIMIT|FOR|RETURNING|UNION|VALUES|HAVING|OFFSET|AND|OR|WINDOW|EXCEPT|INTERSECT)$/i;
/** A statement part that ends where a table name would start, so the table is named at run time. */
const TABLE_AT_RUN_TIME = /\b(?:FROM|JOIN|UPDATE|INTO|USING)\s+(?:ONLY\s+)?$/i;

/**
 * Whether the statement filters `alias` by member kind: `m.kind='person'`, `m.kind<>'agent'`,
 * `m.kind IN ('person',…)`. Only the two values count, so another table's `kind` column (an
 * erasure request's) does not. An unaliased `members` is filtered by a bare `kind=…` too.
 */
function filtersKind(statement: string, alias: string | null): boolean {
  const owner = alias === null ? String.raw`(?:members\.)?` : String.raw`${alias}\.`;
  return new RegExp(
    String.raw`(?:^|[^\w.])${owner}kind\s*(?:(?:=|<>|!=)\s*|IN\s*\(\s*)'(?:person|agent)'`,
    'i'
  ).test(statement);
}

/** Every alias `statement` gives the `members` table, `null` for an unaliased reference. */
function membersAliases(statement: string): Array<string | null> {
  return [...statement.matchAll(MEMBERS_REF)].map(([, alias]) =>
    alias && !NOT_AN_ALIAS.test(alias) ? alias : null
  );
}

/**
 * One string, template or concatenation that touches `members`, by the line it starts on.
 * `dynamic` means a table is named at run time, so the guard cannot tell whether it is
 * `members` and asks for a marker.
 */
interface Found {
  line: number;
  statement: string;
  aliases: Array<string | null>;
  dynamic: boolean;
}

/** The text of a string or template node, with each substitution as a placeholder. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ${…} ');
  return undefined;
}

/**
 * Every string literal, template or `+` concatenation in `text` that touches `members` or names
 * a table at run time. SQL `--` comments are dropped first, so a kind named in one never counts.
 */
function findMemberStatements(text: string): Found[] {
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const found: Found[] = [];
  const add = (node: ts.Node, raw: string, dynamic: boolean) => {
    const statement = raw.replace(/--[^\n]*/g, '');
    const aliases = membersAliases(statement);
    if (!aliases.length && !dynamic) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ line: line + 1, statement, aliases, dynamic });
  };
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      // Every part but the last is followed by a substitution.
      add(
        node,
        literalText(node)!,
        parts.slice(0, -1).some((part) => TABLE_AT_RUN_TIME.test(part))
      );
      node.templateSpans.forEach((span) => ts.forEachChild(span, visit));
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      TABLE_AT_RUN_TIME.test(literalText(node.left) ?? '')
    )
      add(node, literalText(node.left)!, true);
    const text = literalText(node);
    if (text !== undefined) add(node, text, false);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The marker in the run of `//` comment lines directly above line `line` (1-based), so it can sit
 * beside another guard's marker (`// content-change: …`, which must be the line right above).
 */
function markerAbove(lines: readonly string[], line: number): RegExpExecArray | null {
  for (let index = line - 2; index >= 0 && /^\s*\/\//.test(lines[index]); index--) {
    const marker = MARKER.exec(lines[index]);
    if (marker) return marker;
  }
  return null;
}

/**
 * Check one file: in every statement each `members` alias is filtered by kind, or the line
 * comments directly above the statement carry a marker naming a key the allowlist gives a non-empty
 * reason for. A statement that names a table at run time always needs the marker.
 */
function checkFile(
  path: string,
  text: string,
  allowlist: Record<string, string>
): { problems: string[]; used: string[] } {
  const lines = text.split('\n');
  const problems: string[] = [];
  const used: string[] = [];
  for (const { line, statement, aliases, dynamic } of findMemberStatements(text)) {
    if (!dynamic && aliases.every((alias) => filtersKind(statement, alias))) continue;
    const marker = markerAbove(lines, line);
    const where = `${path}:${line} (${statement.replace(/\s+/g, ' ').slice(0, 90)})`;
    if (!marker) {
      problems.push(
        dynamic
          ? `${where} names a table at run time without a "// member-kind: <key>" marker`
          : `${where} reads members without a kind or a "// member-kind: <key>" marker`
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
    // The probe shapes a review got past the first version of this guard.
    ['a comma join', "query('SELECT 1 FROM agents a, members m WHERE m.id=a.owner_member_id')"],
    [
      'a delete using members',
      "query('DELETE FROM bans b USING members m WHERE m.id=b.member_id')",
    ],
    [
      'a kind only in a SQL comment',
      "query(`SELECT id FROM members -- kind='person'\n WHERE id=$1`)",
    ],
    [
      'a second alias without its own filter',
      "query(`SELECT 1 FROM members m JOIN members o ON o.id=m.id WHERE m.kind='person'`)",
    ],
    ['a table named by concatenation', "query('SELECT id FROM ' + table + ' WHERE id=$1')"],
    ['a table named by interpolation', 'query(`SELECT id FROM ${table} WHERE id=$1`)'],
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
    [
      'a filter for every alias',
      "query(`SELECT 1 FROM members m JOIN members o ON o.kind='agent' WHERE m.kind='person'`)",
    ],
    ['an unaliased filter', 'query("UPDATE members SET active=false WHERE kind=\'person\'")'],
    ['a substitution that is not a table', 'query(`SELECT a,${COLUMNS} FROM agents WHERE id=$1`)'],
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
