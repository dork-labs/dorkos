/**
 * Every `HttpTransport` method that still sends its own request, rather than
 * calling the generated API client, is listed in `hand-written-census.json`
 * under its reason (DOR-5473):
 *
 * - `no-operation`: the route (`METHOD /path`) has no operationId
 * - `document-wrong`: the API document gets the call wrong (`operationId: the gap`)
 * - `multipart-or-stream`: a multipart body, a stream or a socket
 * - `own-header-or-cache`: a header, cache rule or fetch the client can't express
 * - `waits-to-move`: nothing stops it moving to the operationId it names
 *
 * A method is hand-written when it reaches the network through anything but
 * the generated client: `fetchJSON` and its siblings, `fetch`, a socket, or a
 * local helper that does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HttpTransport } from '../http-transport';
import census from './hand-written-census.json';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSPORT = path.resolve(HERE, '..');
const ROUTES = path.resolve(
  HERE,
  '../../../../../../../../packages/api-client/src/generated/operation-routes.ts'
);
const HTTP_HELPERS = new Set(['fetchJSON', 'fetchNoContent', 'fetchResponse', 'fetchAllPages']);
const GLOBALS = new Set(['fetch', 'EventSource', 'WebSocket', 'XMLHttpRequest']);

/** Every non-test `.ts` file in the transport folder, parsed, by its relative path. */
function sources(dir = TRANSPORT): Array<[string, ts.SourceFile]> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(file);
    if (!entry.name.endsWith('.ts')) return [];
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(TRANSPORT, file);
    return [[rel, ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)]];
  });
}

/** Every identifier a node mentions. */
function names(node: ts.Node, out = new Set<string>()): Set<string> {
  if (ts.isIdentifier(node)) out.add(node.text);
  ts.forEachChild(node, (child) => void names(child, out));
  return out;
}

/** A function's name and body, for named functions and object members. */
function asFunction(node: ts.Node): [string, ts.Node] | undefined {
  const fn = (n: ts.Node | undefined) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  if (ts.isFunctionDeclaration(node) && node.name) return [node.name.text, node];
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && fn(node.initializer))
    return [node.name.text, node.initializer!];
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return [node.name.text, node];
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && fn(node.initializer))
    return [node.name.text, node.initializer];
  return undefined;
}

/** Each `file#method` of the transport that reaches the network by hand. */
function handWritten(): string[] {
  const files = sources();
  const imports = new Map<string, Map<string, [string, string]>>();
  const reaching = new Map<string, Set<string>>(files.map(([rel]) => [rel, new Set()]));
  for (const [rel, source] of files) {
    const own = new Map<string, [string, string]>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      const bindings = statement.importClause?.namedBindings;
      if (!from.startsWith('.') || !bindings || !ts.isNamedImports(bindings)) continue;
      const target = path.relative(TRANSPORT, path.resolve(TRANSPORT, path.dirname(rel), from));
      for (const el of bindings.elements)
        own.set(el.name.text, [`${target}.ts`, (el.propertyName ?? el.name).text]);
    }
    imports.set(rel, own);
  }
  const reaches = (rel: string, body: ts.Node) =>
    [...names(body)].some((name) => {
      if (GLOBALS.has(name) || reaching.get(rel)!.has(name)) return true;
      const [from, original] = imports.get(rel)!.get(name) ?? [];
      if (from === 'http-client.ts') return HTTP_HELPERS.has(original!);
      return from !== undefined && (reaching.get(from)?.has(original!) ?? false);
    });
  const functions = files.flatMap(([rel, source]) => {
    const found: Array<[string, string, ts.Node]> = [];
    const visit = (node: ts.Node) => {
      const fn = asFunction(node);
      if (fn && !/^create\w*Methods$/.test(fn[0])) found.push([rel, ...fn]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
  // A helper that reaches the network makes every caller reach it: repeat until nothing changes.
  for (let grew = true; grew;) {
    grew = false;
    for (const [rel, name, body] of functions) {
      if (rel === 'api-client.ts' || reaching.get(rel)!.has(name) || !reaches(rel, body)) continue;
      reaching.get(rel)!.add(name);
      grew = true;
    }
  }
  const transport = new HttpTransport('/api') as unknown as Record<string, unknown>;
  const keys = functions
    .filter(([rel, name]) => typeof transport[name] === 'function' && reaching.get(rel)!.has(name))
    .map(([rel, name]) => `${rel}#${name}`);
  return [...new Set(keys)].sort();
}

/** The generated client's operations, by id, with each method and path. */
const operations = [
  ...fs
    .readFileSync(ROUTES, 'utf8')
    .matchAll(/"([^"]+)": \{ method: "([A-Z]+)", path: "([^"]+)" \}/g),
].map(([, id, method, route]) => ({ id: id!, method: method!, route: route! }));

/** Whether two paths are the same route, any parameter matching any segment. */
function sameRoute(a: string, b: string): boolean {
  const segments = (p: string) => p.split('/').map((s) => (/^(\{.*\}|\*)$/.test(s) ? '*' : s));
  const [x, y] = [segments(a), segments(b)];
  return x.length === y.length && x.every((s, i) => s === '*' || y[i] === '*' || s === y[i]);
}

const listed = Object.values(census).flatMap((group) => Object.keys(group));

describe('the hand-written transport census', () => {
  it('lists every hand-written method, and only those', () => {
    const found = handWritten();
    expect(
      found.filter((key) => !listed.includes(key)),
      'hand-written, no reason'
    ).toEqual([]);
    expect(
      listed.filter((key) => !found.includes(key)),
      'no longer hand-written'
    ).toEqual([]);
  });

  it('names no route that now has an operationId, and only operationIds that exist', () => {
    const stale = Object.entries(census['no-operation']).flatMap(([key, request]) => {
      const [method, route] = request.split(' ');
      const now = operations.find((op) => op.method === method && sameRoute(op.route, route!));
      return now ? [`${key}: ${request} is now ${now.id}`] : [];
    });
    const named = [census['document-wrong'], census['waits-to-move']].flatMap((group) =>
      Object.entries(group).map(([key, reason]) => [key, reason.split(':')[0]!])
    );
    const missing = named.filter(([, id]) => !operations.some((op) => op.id === id));
    expect([...stale, ...missing.map(([key, id]) => `${key}: no ${id}`)]).toEqual([]);
  });
});
