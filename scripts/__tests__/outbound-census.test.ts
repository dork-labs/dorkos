import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// A whole-tree parse, given the same budget as its sibling boundary scans.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Every place the shipped product's source can reach the network is on a
 * checked-in list (DOR-4990).
 *
 * The docs promise that `DO_NOT_TRACK=1` means DorkOS sends nothing it was not
 * asked to. That promise is only as good as our knowledge of every sender, so
 * this scan finds each file under {@link ROOTS} (the server, the browser app,
 * the desktop app and every shipped workspace package; see `shippedRoots`)
 * that uses a network primitive, and fails on any file that is not in
 * `scripts/outbound-census/census.json`. Each entry is one of two kinds:
 *
 * - `consent`: the file, or every file named in `gatedBy`, calls a helper from
 *   `@dorkos/shared/telemetry-consent`, so the kill switches stop it.
 * - `feature`: not telemetry. It says why it talks to the network and how a
 *   person turns it off (`reason`, `offSwitch`).
 *
 * What counts as a network primitive, read from the syntax tree so comments,
 * type positions and the browser scripts inside template strings never count:
 *
 * - the global `fetch` called or passed as a value, and `globalThis`, `window`
 *   or `self` `.fetch` / `['fetch']`; a parameter or local named `fetch`
 *   shadows the global and is not counted;
 * - `request`/`get`/`connect` on `node:http(s)`, `http2`, `net` or `tls`, under
 *   whatever name the file imports or requires them as, and named imports of
 *   those functions;
 * - `new WebSocket` (and the `ws` class under any name), `EventSource` and the
 *   MCP SDK's network client transports; Electron's `net.fetch`/`net.request`
 *   and `defaultSession.fetch`; `navigator.sendBeacon`;
 * - a value import of an HTTP client, the desktop updater, a trace exporter or
 *   a service SDK that makes its own requests (`NETWORK_MODULE`);
 * - a hard-coded Google Fonts address.
 *
 * One rule keeps the browser app's calls to its own server out:
 * `isSameOriginCall`. A call whose address is a same-origin path, or is built
 * by a helper that always names the connected DorkOS server, is not outbound.
 * Calls through a base URL variable are listed in the census instead, as the
 * app's own server.
 *
 * This is a static guard, not a proof: a call through an injected `fetch` is
 * caught where the global is wired in (so `packages/decisions` shows up as
 * `triage-wiring.ts` and `space-server.ts`), and a spawned program's own
 * network use (git, the runtimes) is out of its reach. The marketing site
 * (`apps/site`), the e2e and design-system apps and the dev-only packages are
 * not scanned.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CENSUS_PATH = 'scripts/outbound-census/census.json';

/** Workspace packages that never ship in the product: build, lint and test tooling. */
const DEV_ONLY_PACKAGES = new Set([
  'ci-steward',
  'eslint-config',
  'evals',
  'heavy-slot',
  'test-utils',
  'typescript-config',
]);

/**
 * The shipped product source this census covers: the server, the browser app,
 * the desktop shell, and the `src/` of every workspace package except the
 * dev-only ones. Not covered: the marketing site (`apps/site`, its own
 * deployment) and the test and catalog apps (`apps/e2e`, `apps/design-system`).
 */
function shippedRoots(): string[] {
  const packages = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !DEV_ONLY_PACKAGES.has(entry.name))
    .map((entry) => `packages/${entry.name}/src/`);
  return ['apps/server/src/', 'apps/client/src/', 'apps/desktop/src/', ...packages];
}
const ROOTS = shippedRoots();

/** The helpers whose call means a send is gated on the person's consent. */
const CONSENT_HELPERS = new Set([
  'isTelemetryDisabledByEnv',
  'resolveTelemetryConsent',
  'resolveTier1ChannelConsent',
]);
const CONSENT_MODULE = '@dorkos/shared/telemetry-consent';

/**
 * Modules whose (value) import alone means network use: HTTP clients, the
 * desktop updater, trace exporters and the service SDKs that make their own
 * requests (Slack, Telegram, Composio, S3, mail).
 */
const NETWORK_MODULE =
  /^(?:electron-updater|undici|axios|node-fetch|got|ky|@opentelemetry\/exporter-.+|@slack\/(?:web-api|bolt)|grammy|@composio\/core|@aws-sdk\/client-.+|nodemailer)$/;
/** Node modules whose `request`/`get`/`connect` is a network call. */
const NODE_NET_MODULE = /^(?:node:)?(?:https?|http2|net|tls)$/;
const NODE_NET_EXPORTS = new Set(['request', 'get', 'connect', 'createConnection']);
/** The names those modules are usually bound to, imported or required. */
const NODE_NET_NAMES = ['http', 'https', 'http2', 'net', 'tls'];
/** Objects whose `fetch` is the global one, in Node and in a browser. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);
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

/** Whether an import brings in types only, which cannot reach the network. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((spec) => spec.isTypeOnly)
  );
}

/** The module a string literal names, when it is an import, a dynamic import or a require. */
function moduleSpecifierOf(node: ts.StringLiteralLike): string | null {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent)) return isTypeOnlyImport(parent) ? null : node.text;
  if (ts.isExportDeclaration(parent)) return parent.isTypeOnly ? null : node.text;
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
  const { netNamespaces, constructors, electronNet } = importedAliases(sf);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'fetch' &&
      isGlobalFetchValue(node) &&
      !isSameOriginCall(node)
    )
      at(node, 'fetch');
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression.getText(sf);
      const name = node.name.text;
      if (GLOBAL_OBJECTS.has(target) && name === 'fetch' && !isSameOriginCall(node))
        at(node, `${target}.fetch`);
      if (target === 'navigator' && name === 'sendBeacon') at(node, 'navigator.sendBeacon');
      if (/(?:^|\.)defaultSession$/.test(target) && name === 'fetch') at(node, `${target}.fetch`);
      if (electronNet.has(target) && ['fetch', 'request'].includes(name))
        at(node, `${target}.${name} (electron)`);
      if (netNamespaces.has(target) && NODE_NET_EXPORTS.has(name)) at(node, `${target}.${name}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      GLOBAL_OBJECTS.has(node.expression.getText(sf)) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    )
      at(node, `${node.expression.getText(sf)}['fetch']`);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      constructors.has(node.expression.text) &&
      !isSameOriginCall(node.expression)
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

/**
 * The local names a file binds the network modules to, however it renames
 * them: a default or namespace import of `node:http(s)`, `net` or `tls` (and a
 * `require` of one), the `WebSocket` class from `ws`, and Electron's `net`.
 *
 * @param sf - The parsed file.
 */
function importedAliases(sf: ts.SourceFile): {
  netNamespaces: Set<string>;
  constructors: Set<string>;
  electronNet: Set<string>;
} {
  const netNamespaces = new Set(NODE_NET_NAMES);
  const constructors = new Set(NETWORK_CONSTRUCTORS);
  const electronNet = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (NODE_NET_MODULE.test(from)) {
        if (clause?.name) netNamespaces.add(clause.name.text);
        if (bindings && ts.isNamespaceImport(bindings)) netNamespaces.add(bindings.name.text);
      }
      if (from === 'ws') {
        if (clause?.name) constructors.add(clause.name.text);
        if (bindings && ts.isNamespaceImport(bindings)) netNamespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings))
          for (const spec of bindings.elements)
            if ((spec.propertyName ?? spec.name).text === 'WebSocket')
              constructors.add(spec.name.text);
      }
      if (from === 'electron' && bindings && ts.isNamedImports(bindings))
        for (const spec of bindings.elements)
          if ((spec.propertyName ?? spec.name).text === 'net') electronNet.add(spec.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments[0] &&
      ts.isStringLiteralLike(node.initializer.arguments[0]) &&
      NODE_NET_MODULE.test(node.initializer.arguments[0].text)
    )
      netNamespaces.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { netNamespaces, constructors, electronNet };
}

/**
 * The browser app's helpers that build a URL on the DorkOS server it is
 * connected to: `resolveApiBaseUrl()` and `extensionApiUrl()`, which wraps it,
 * and the Community pages' `tenantApiPath()`, which returns a same-origin path.
 */
const SERVER_URL_HELPERS = new Set(['extensionApiUrl', 'resolveApiBaseUrl', 'tenantApiPath']);

/** Whether an expression is a call to one of {@link SERVER_URL_HELPERS}. */
function callsServerUrlHelper(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    SERVER_URL_HELPERS.has(node.expression.text)
  );
}

/**
 * Whether a call goes to the app's own server rather than outbound: its first
 * argument is a same-origin path (a string or template starting with `/` but
 * not `//`), or a URL built by one of {@link SERVER_URL_HELPERS}, alone or at
 * the start of a template. In the browser app that is the DorkOS server the
 * page is connected to; anywhere else a relative path cannot reach the network.
 *
 * @param callee - The `fetch` (or constructor) being called.
 */
function isSameOriginCall(callee: ts.Node): boolean {
  const call = callee.parent;
  if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== callee)
    return false;
  const first = call.arguments?.[0];
  if (first === undefined) return false;
  if (callsServerUrlHelper(first)) return true;
  if (
    ts.isTemplateExpression(first) &&
    first.head.text === '' &&
    callsServerUrlHelper(first.templateSpans[0]!.expression)
  )
    return true;
  const text = ts.isStringLiteralLike(first)
    ? first.text
    : ts.isTemplateExpression(first)
      ? first.head.text
      : null;
  return text !== null && text.startsWith('/') && !text.startsWith('//');
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
  it('follows renamed imports and other spellings of the global', () => {
    const source = [
      "import web from 'node:https';",
      "import * as plain from 'http';",
      "import Socket, { WebSocket as Ws } from 'ws';",
      "import { net as electronNet } from 'electron';",
      "import type { Bot } from 'grammy';",
      "const raw = require('node:net');",
      'web.request(url);',
      'plain.get(url);',
      'new Socket(url);',
      'new Ws(url);',
      'electronNet.fetch(url);',
      'raw.connect(port);',
      "globalThis['fetch'](url);",
      'window.fetch(url);',
    ].join('\n');
    // The type-only `grammy` import on line 5 is not network use.
    expect(findNetworkUses('a.ts', source)).toEqual([
      '7: web.request',
      '8: plain.get',
      '9: new Socket',
      '10: new Ws',
      '11: electronNet.fetch (electron)',
      '12: raw.connect',
      "13: globalThis['fetch']",
      '14: window.fetch',
    ]);
  });

  it('treats a same-origin path as the app talking to its own server', () => {
    const source = [
      "fetch('/api/sessions');",
      'fetch(`/api/sessions/${id}`);',
      "new EventSource('/api/events');",
      "fetch('//cdn.example/x');",
      'fetch(`${base}/api/x`);',
      "fetch(extensionApiUrl('/extensions'));",
      'fetch(`${resolveApiBaseUrl()}/api/x`);',
    ].join('\n');
    expect(findNetworkUses('a.ts', source)).toEqual(['4: fetch', '5: fetch']);
  });

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
