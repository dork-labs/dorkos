import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// A whole-tree parse, given the same budget as its sibling boundary scans.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Every place the product can reach the network is on a checked-in list
 * (DOR-4990).
 *
 * The docs promise that `DO_NOT_TRACK=1` means DorkOS sends nothing it was not
 * asked to. That promise is only as good as our knowledge of every sender, so
 * this scan finds each file in the shipped server, CLI, shared package and
 * desktop shell that uses a network primitive, and fails on any file that is
 * not in `scripts/outbound-census/census.json`. Each entry is one of two kinds:
 *
 * - `consent`: the file, or every file named in `gatedBy`, calls a helper from
 *   `@dorkos/shared/telemetry-consent`, so the kill switches stop it.
 * - `feature`: not telemetry. It says why it talks to the network and how a
 *   person turns it off (`reason`, `offSwitch`).
 *
 * What counts as a network primitive, read from the syntax tree so comments and
 * the browser scripts inside template strings never count: the global `fetch`
 * used as a value or called, `globalThis.fetch`, Electron's
 * `defaultSession.fetch` and `net.fetch`/`net.request`, `http(s).request/get`,
 * `net`/`tls` `connect`, `new WebSocket`/`EventSource` and the MCP SDK's
 * network client transports, a named `request`/`get`/`connect` import from
 * `node:http(s)`, `net` or `tls`, an import of an HTTP client or updater
 * package, and a hard-coded Google Fonts address (a page this server serves
 * loads from it).
 *
 * This is a static guard, not a proof: a call through an injected `fetch`
 * parameter is caught where the global is wired in, and a spawned program's
 * own network use (git, the runtimes) is out of its reach.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CENSUS_PATH = 'scripts/outbound-census/census.json';

/** The shipped product source this census covers. */
const ROOTS = [
  'apps/server/src/',
  'packages/cli/src/',
  'packages/shared/src/',
  'apps/desktop/src/main/',
];

/** The helpers whose call means a send is gated on the person's consent. */
const CONSENT_HELPERS = new Set([
  'isTelemetryDisabledByEnv',
  'resolveTelemetryConsent',
  'resolveTier1ChannelConsent',
]);
const CONSENT_MODULE = '@dorkos/shared/telemetry-consent';

/** Modules whose import alone means network use. */
const NETWORK_MODULE =
  /^(?:electron-updater|undici|axios|node-fetch|got|ky|@opentelemetry\/exporter-.+)$/;
/** Node modules whose named `request`/`get`/`connect` import is a network call. */
const NODE_NET_MODULE = /^(?:node:)?(?:https?|http2|net|tls)$/;
const NODE_NET_EXPORTS = new Set(['request', 'get', 'connect', 'createConnection']);
/** Constructors that open a connection. */
const NETWORK_CONSTRUCTORS = new Set([
  'WebSocket',
  'EventSource',
  'StreamableHTTPClientTransport',
  'SSEClientTransport',
  'WebSocketClientTransport',
]);
const THIRD_PARTY_HOST = /\bfonts\.googleapis\.com\b/;

/** One census entry, as `census.json` holds it. */
interface CensusEntry {
  file: string;
  destination: string;
  class: 'consent' | 'feature';
  reason?: string;
  offSwitch?: string;
  gatedBy?: string[];
}

function isTestPath(file: string): boolean {
  return (
    file.includes('/__tests__/') ||
    file.includes('/__mocks__/') ||
    file.includes('/__fixtures__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    file.includes('/test-utils/')
  );
}

/** Whether a binding name (plain or destructured) declares `fetch`. */
function bindsFetch(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === 'fetch';
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsFetch(element.name)
  );
}

/** Whether a block's own statements declare a local `fetch` (a `const`, `let` or function). */
function declaresFetch(statements: ts.NodeArray<ts.Statement>): boolean {
  return statements.some(
    (statement) =>
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((decl) => bindsFetch(decl.name))) ||
      (ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetch')
  );
}

/** Whether an enclosing parameter or local declaration named `fetch` shadows the global. */
function shadowedLocally(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at) && at.parameters.some((param) => bindsFetch(param.name))) return true;
    if ((ts.isBlock(at) || ts.isSourceFile(at)) && declaresFetch(at.statements)) return true;
  }
  return false;
}

/** Whether a `fetch` identifier is the global in a value position, not a name or a type. */
function isGlobalFetchValue(node: ts.Identifier): boolean {
  if (shadowedLocally(node)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent))
    return false;
  const named =
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isParameter(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isGetAccessor(parent) ||
    ts.isSetAccessor(parent);
  return !(named && (parent as { name?: ts.Node }).name === node);
}

/** The module a string literal names, when it is an import, a dynamic import or a require. */
function moduleSpecifierOf(node: ts.StringLiteralLike): string | null {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return node.text;
  if (
    ts.isCallExpression(parent) &&
    (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))
  )
    return node.text;
  return null;
}

/**
 * The network primitives one file uses, as `line: what`.
 *
 * @param file - Used for the parser's file kind.
 * @param source - The file's text.
 */
function findNetworkUses(file: string, source: string): string[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch' && isGlobalFetchValue(node))
      at(node, 'fetch');
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression.getText(sf);
      const name = node.name.text;
      if (target === 'globalThis' && name === 'fetch') at(node, 'globalThis.fetch');
      if (/(?:^|\.)defaultSession$/.test(target) && name === 'fetch') at(node, `${target}.fetch`);
      if (target === 'net' && ['fetch', 'request', 'connect', 'createConnection'].includes(name))
        at(node, `net.${name}`);
      if (
        ['http', 'https', 'http2'].includes(target) &&
        ['request', 'get', 'connect'].includes(name)
      )
        at(node, `${target}.${name}`);
      if (target === 'tls' && name === 'connect') at(node, 'tls.connect');
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      NETWORK_CONSTRUCTORS.has(node.expression.text)
    )
      at(node, `new ${node.expression.text}`);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (
        NODE_NET_MODULE.test(node.moduleSpecifier.text) &&
        bindings &&
        ts.isNamedImports(bindings)
      )
        for (const spec of bindings.elements)
          if (NODE_NET_EXPORTS.has((spec.propertyName ?? spec.name).text))
            at(spec, `${spec.name.text} from ${node.moduleSpecifier.text}`);
    }
    if (ts.isStringLiteralLike(node)) {
      const specifier = moduleSpecifierOf(node);
      if (specifier !== null && NETWORK_MODULE.test(specifier)) at(node, `import ${specifier}`);
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      THIRD_PARTY_HOST.test(node.text)
    )
      at(node, 'fonts.googleapis.com');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Whether a file imports the consent module and calls one of its helpers. */
function callsConsentHelper(source: string, file: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let imports = false;
  let calls = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === CONSENT_MODULE
    )
      imports = true;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CONSENT_HELPERS.has(node.expression.text)
    )
      calls = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imports && calls;
}

/** Shipped source under {@link ROOTS}, as git sees it (tracked and new). */
function shippedSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts'],
    { cwd: ROOT, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(
      (file) =>
        file.length > 0 &&
        ROOTS.some((root) => file.startsWith(root)) &&
        !file.includes('/node_modules/') &&
        !file.includes('/dist/') &&
        !isTestPath(file) &&
        existsSync(path.join(ROOT, file))
    );
}

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

const census = JSON.parse(read(CENSUS_PATH)) as CensusEntry[];
const byFile = new Map(census.map((entry) => [entry.file, entry]));

describe('outbound destination census (DOR-4990)', () => {
  const senders = new Map<string, string[]>();
  for (const file of shippedSources()) {
    const uses = findNetworkUses(file, read(file));
    if (uses.length > 0) senders.set(file, uses);
  }

  it('finds the senders it is meant to find', () => {
    // A scan that matched nothing would pass every other check here.
    expect(senders.has('apps/server/src/services/core/update-checker.ts')).toBe(true);
    expect(senders.has('apps/desktop/src/main/auto-updater.ts')).toBe(true);
  });

  it('lists every file that reaches the network', () => {
    const missing = [...senders.keys()].filter((file) => !byFile.has(file));
    expect(
      missing.map((file) => `${file}\n    ${senders.get(file)!.join('\n    ')}`),
      `These files reach the network but are not in ${CENSUS_PATH}. Add one entry per file ` +
        `with "file", "destination" and "class": "consent" when the send is gated on ` +
        `${CONSENT_MODULE} (the file, or each file in "gatedBy", must call one of ` +
        `${[...CONSENT_HELPERS].join(', ')}), or "feature" with a one-line "reason" and ` +
        `its "offSwitch" when it is not telemetry.`
    ).toEqual([]);
  });

  it('lists no file that no longer reaches the network', () => {
    const stale = census.map((entry) => entry.file).filter((file) => !senders.has(file));
    expect(stale, `Remove these entries from ${CENSUS_PATH}.`).toEqual([]);
  });

  it('lists each file once, in order', () => {
    const files = census.map((entry) => entry.file);
    expect(files).toEqual([...new Set(files)].sort());
  });

  it.each(census.filter((entry) => entry.class === 'consent'))(
    '$file is gated on the shared consent helper',
    (entry) => {
      for (const gate of entry.gatedBy ?? [entry.file])
        expect(callsConsentHelper(read(gate), gate), `${gate} must call a consent helper`).toBe(
          true
        );
    }
  );

  it.each(census.filter((entry) => entry.class === 'feature'))(
    '$file says why it is not telemetry and how to turn it off',
    (entry) => {
      expect(entry.reason?.trim()).toBeTruthy();
      expect(entry.offSwitch?.trim()).toBeTruthy();
      expect(entry.gatedBy).toBeUndefined();
    }
  );

  it('accepts only the two classes, each with a destination', () => {
    for (const entry of census) {
      expect(['consent', 'feature']).toContain(entry.class);
      expect(entry.destination.trim()).toBeTruthy();
    }
  });
});

describe('the network-use scan', () => {
  it('ignores comments, names, types and browser scripts in strings', () => {
    const source = [
      '// await fetch(url)',
      'type F = typeof fetch;',
      'const o = { fetch: 1 };',
      'class C { async fetch(x: string) { return this.fetch(x); } }',
      "const page = `<script>fetch('/api/x')</script>`;",
      'function f(fetch: F) { return fetch(url); }',
      'function g() { const { fetch } = deps; return fetch(url); }',
    ].join('\n');
    expect(findNetworkUses('a.ts', source)).toEqual([]);
  });

  it('finds a call, a default value and a socket', () => {
    const source = [
      'await fetch(url);',
      'const f = deps.fetch ?? fetch;',
      'new WebSocket(url);',
      "import { request } from 'node:https';",
    ].join('\n');
    expect(findNetworkUses('a.ts', source)).toEqual([
      '1: fetch',
      '2: fetch',
      '3: new WebSocket',
      '4: request from node:https',
    ]);
  });
});
