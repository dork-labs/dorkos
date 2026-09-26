import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// A whole-repo scan that parses every file it reads, sized like its sibling
// composio-sdk-import-boundary.test.ts (see that file for how the budget was
// measured); parsing costs more than a regex, so the budget is doubled.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Every link into a conversation is built by one of two helpers (DOR-2077):
 * `@dorkos/shared/session-link` (`sessionPath`, for the server and the desktop
 * shell) and the client's `shared/lib/session-link` (`toSession` for a
 * navigation, `sessionHref` for a string). Before them, roughly forty sites
 * spelled `/session?session=…` out by hand, and one shipped the id without the
 * path.
 *
 * This scan fails on a session address built anywhere else in shipped source:
 *
 * - a string or template piece that starts `/session?`, or carries `?session=`
 *   or `&session=` — a hand-built URL;
 * - `to: '/session'` (or `to: SESSION_ROUTE`) as an object property, type
 *   member or JSX attribute — a hand-built navigation.
 *
 * It reads the syntax tree, not the text, so a comment that describes a URL is
 * never a violation, and an identifier that merely contains "session" is never
 * one either. Tests are out of scope: asserting the address a link produced is
 * what a test is for.
 */

/** The helpers themselves, and the file that defines the route they point at. */
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/shared/src/session-link.ts': 'the shared builder',
  'apps/client/src/layers/shared/lib/session-link.ts': 'the client builder',
  // Defines `/session` and its loader redirects to itself with a function of
  // the previous search; it uses `SESSION_ROUTE`, never a literal.
  'apps/client/src/router.tsx': 'the route definition',
};

/** Source roots that ship. */
const ROOTS = ['apps/client/src/', 'apps/server/src/', 'apps/desktop/src/', 'packages/'];

function isTestPath(path: string): boolean {
  return (
    path.includes('/__tests__/') ||
    path.includes('/__mocks__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    path.includes('/test-utils/')
  );
}

/** Whether a piece of literal text is (part of) a hand-built session URL. */
function isHandBuiltUrl(text: string): boolean {
  return text.startsWith('/session?') || /[?&]session=/.test(text);
}

/** Whether a node is the session route written out as a navigation target. */
function isSessionRouteValue(node: ts.Node | undefined): boolean {
  if (node === undefined) return false;
  if (ts.isStringLiteralLike(node)) return node.text === '/session';
  if (ts.isIdentifier(node)) return node.text === 'SESSION_ROUTE';
  if (ts.isLiteralTypeNode(node)) return isSessionRouteValue(node.literal);
  if (ts.isJsxExpression(node)) return isSessionRouteValue(node.expression);
  return false;
}

/** Whether a property / attribute name is `to`. */
function isToName(name: ts.Node): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'to';
}

/**
 * Every hand-built session address in one file, as `line: snippet`.
 *
 * @param path - Used for the parser's file kind and in the report.
 * @param source - The file's text.
 */
function findHandBuiltSessionLinks(path: string, source: string): string[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const report = (node: ts.Node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${path}:${line + 1}: ${node.getText(file).slice(0, 80)}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      isHandBuiltUrl(node.text)
    ) {
      report(node);
    } else if (
      (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) &&
      isToName(node.name) &&
      isSessionRouteValue(ts.isPropertyAssignment(node) ? node.initializer : node.type)
    ) {
      report(node);
    } else if (
      ts.isJsxAttribute(node) &&
      isToName(node.name) &&
      isSessionRouteValue(node.initializer)
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('session link boundary (DOR-2077)', () => {
  it('finds no session address built outside the session-link helpers', () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(
        (path) =>
          path.length > 0 &&
          ROOTS.some((root) => path.startsWith(root)) &&
          !path.includes('/node_modules/') &&
          !path.includes('/dist/') &&
          !isTestPath(path) &&
          !(path in ALLOWED) &&
          existsSync(path)
      );
    expect(files.length).toBeGreaterThan(500);

    const violations = files.flatMap((path) =>
      findHandBuiltSessionLinks(path, readFileSync(path, 'utf8'))
    );
    expect(violations).toEqual([]);
  });

  it('recognises each spelling the scan must catch, and nothing else', () => {
    // Purpose: prove the matcher can fail, so an empty violation list means
    // something. The route is split so this file cannot trip its own scan.
    const route = ['/', 'session'].join('');
    const hits = (source: string) => findHandBuiltSessionLinks('x.tsx', source).length > 0;

    expect(hits(`const a = '${route}?session=abc';`)).toBe(true);
    expect(hits('const a = `' + route + '?session=${id}`;')).toBe(true);
    expect(hits('const a = `${origin}?session=${id}`;')).toBe(true);
    expect(hits('const a = `' + route + '?dir=${d}&session=${id}`;')).toBe(true);
    expect(hits(`navigate({ to: '${route}', search: { session: id } });`)).toBe(true);
    expect(hits(`navigate({ to: SESSION_ROUTE, search: { session: id } });`)).toBe(true);
    expect(hits(`type T = { to: '${route}'; search: S };`)).toBe(true);
    expect(hits(`const x = <Link to="${route}" />;`)).toBe(true);

    // Comments, API paths, comparisons and look-alike params are not links.
    expect(hits(`// opens ${route}?session=abc`)).toBe(false);
    expect(hits('const u = `/sessions/${id}/messages`;')).toBe(false);
    expect(hits(`if (pathname === '${route}') go();`)).toBe(false);
    expect(hits('const u = `/api/test?sessionId=${id}`;')).toBe(false);
    expect(hits(`navigate(toSession({ session: id }));`)).toBe(false);
  });
});
