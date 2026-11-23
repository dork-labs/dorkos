/**
 * The network-use scan behind the outbound-destination census (DOR-4990).
 *
 * `findNetworkUses` reads one file's syntax tree and names every network
 * primitive it uses, so comments, type positions and the browser scripts
 * inside template strings never count. What counts:
 *
 * - the global `fetch` called or passed as a value; `globalThis`, `window` or
 *   `self` `.fetch` / `['fetch']`; `const { fetch } = globalThis`. A parameter
 *   or local named `fetch` shadows the global and is not counted;
 * - `request`/`get`/`connect` on `node:http(s)`, `http2`, `net` or `tls`, under
 *   whatever name the file imports or requires them as, and named imports of
 *   those functions;
 * - `new WebSocket` (and the `ws` class under any name), `EventSource`,
 *   `XMLHttpRequest` and the MCP SDK's network client transports; Electron's
 *   `net.fetch`/`net.request` (named or through a default import) and
 *   `defaultSession.fetch`; `navigator.sendBeacon`;
 * - a value import of a module on the reviewed network list
 *   (`dependencies.json`, passed in as `networkModules`);
 * - a `socialProviders` option: a sign-in setup that reaches outside
 *   providers;
 * - a hard-coded Google Fonts address.
 *
 * One rule keeps calls to the app's own server out: {@link isSameOriginCall}.
 *
 * @module scripts/outbound-census/scan
 */
import ts from 'typescript';

/** The helpers whose call means a send is gated on the person's consent. */
export const CONSENT_HELPERS: ReadonlySet<string> = new Set([
  'isTelemetryDisabledByEnv',
  'resolveTelemetryConsent',
  'resolveTier1ChannelConsent',
]);

/** The module the consent helpers come from. */
export const CONSENT_MODULE = '@dorkos/shared/telemetry-consent';

/** Node modules whose `request`/`get`/`connect` is a network call. */
const NODE_NET_MODULE = /^(?:node:)?(?:https?|http2|net|tls)$/;
const NODE_NET_EXPORTS = new Set(['request', 'get', 'connect', 'createConnection']);
/** The names those modules are usually bound to, imported or required. */
const NODE_NET_NAMES = ['http', 'https', 'http2', 'net', 'tls'];
/** Objects whose `fetch` is the global one, in Node and in a browser. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);
/** Spellings of the browser's `navigator`. */
const NAVIGATOR = new Set([
  'navigator',
  'window.navigator',
  'globalThis.navigator',
  'self.navigator',
]);
/** Constructors that open a connection. */
const NETWORK_CONSTRUCTORS = [
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'StreamableHTTPClientTransport',
  'SSEClientTransport',
  'WebSocketClientTransport',
];
const THIRD_PARTY_HOST = /\bfonts\.googleapis\.com\b/;

/** Where the browser app lives; only there do its server-URL helpers mean "own server". */
const CLIENT_ROOT = 'apps/client/src/';

/**
 * The browser app's helpers that build a URL on the DorkOS server it is
 * connected to: `resolveApiBaseUrl()` and `extensionApiUrl()`, which wraps it,
 * and the Community pages' `tenantApiPath()`, which returns a same-origin path.
 */
const SERVER_URL_HELPERS = new Set(['extensionApiUrl', 'resolveApiBaseUrl', 'tenantApiPath']);

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

/** The module a string literal names, when it is a value import, a dynamic import or a require. */
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
 * The npm package a module specifier belongs to: `@scope/name` or `name`.
 *
 * @param specifier - An import's module specifier.
 */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The local names a file binds the network modules to, however it renames them. */
interface ImportedAliases {
  /** Names for `node:http(s)`, `net`, `tls` (and `ws` as a namespace). */
  netNamespaces: Set<string>;
  /** Constructor names that open a connection, including renamed `ws` classes. */
  constructors: Set<string>;
  /** Names Electron's `net` is reachable as: `net`, or `<default>.net`. */
  electronNet: Set<string>;
}

/**
 * The local names a file binds the network modules to: a default or namespace
 * import of `node:http(s)`, `net` or `tls` (and a `require` of one), the
 * `WebSocket` class from `ws`, and Electron's `net`, named or through a
 * default or namespace import of `electron`.
 *
 * @param sf - The parsed file.
 */
function importedAliases(sf: ts.SourceFile): ImportedAliases {
  const netNamespaces = new Set(NODE_NET_NAMES);
  const constructors = new Set(NETWORK_CONSTRUCTORS);
  const electronNet = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const namespace = bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : null;
      if (NODE_NET_MODULE.test(from)) {
        if (clause?.name) netNamespaces.add(clause.name.text);
        if (namespace) netNamespaces.add(namespace);
      }
      if (from === 'ws') {
        if (clause?.name) constructors.add(clause.name.text);
        if (namespace) netNamespaces.add(namespace);
        if (bindings && ts.isNamedImports(bindings))
          for (const spec of bindings.elements)
            if ((spec.propertyName ?? spec.name).text === 'WebSocket')
              constructors.add(spec.name.text);
      }
      if (from === 'electron') {
        if (clause?.name) electronNet.add(`${clause.name.text}.net`);
        if (namespace) electronNet.add(`${namespace}.net`);
        if (bindings && ts.isNamedImports(bindings))
          for (const spec of bindings.elements)
            if ((spec.propertyName ?? spec.name).text === 'net') electronNet.add(spec.name.text);
      }
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

/** Whether an expression is a call to one of {@link SERVER_URL_HELPERS}. */
function callsServerUrlHelper(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    SERVER_URL_HELPERS.has(node.expression.text)
  );
}

/**
 * Whether a call goes to the app's own server rather than outbound.
 *
 * - Its first argument is a same-origin path: a string starting with `/` but
 *   not `//`, or a template whose fixed start does (and is more than `/`
 *   alone, which an expression could turn into `//host`). Anywhere outside a
 *   browser, a relative path cannot reach the network at all.
 * - In the browser app only (`apps/client/src/`), a URL built by one of
 *   {@link SERVER_URL_HELPERS}, alone or at the start of a template: the
 *   DorkOS server the page is connected to.
 *
 * @param callee - The `fetch` (or constructor) being called.
 * @param file - The file's repo-relative path.
 */
function isSameOriginCall(callee: ts.Node, file: string): boolean {
  const call = callee.parent;
  if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== callee)
    return false;
  const first = call.arguments?.[0];
  if (first === undefined) return false;
  if (file.startsWith(CLIENT_ROOT)) {
    if (callsServerUrlHelper(first)) return true;
    if (
      ts.isTemplateExpression(first) &&
      first.head.text === '' &&
      first.templateSpans[0] !== undefined &&
      callsServerUrlHelper(first.templateSpans[0].expression)
    )
      return true;
  }
  const relative = (text: string) => text.startsWith('/') && !text.startsWith('//');
  if (ts.isStringLiteralLike(first)) return relative(first.text);
  if (ts.isTemplateExpression(first)) return relative(first.head.text) && first.head.text !== '/';
  return false;
}

/**
 * The network primitives one file uses, as `line: what`.
 *
 * @param file - The file's repo-relative path; sets the parser's file kind and
 *   whether the browser app's own-server rule applies.
 * @param source - The file's text.
 * @param networkModules - Packages whose value import is network use.
 */
export function findNetworkUses(
  file: string,
  source: string,
  networkModules: ReadonlySet<string>
): string[] {
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
      !isSameOriginCall(node, file)
    )
      at(node, 'fetch');
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression.getText(sf);
      const name = node.name.text;
      if (GLOBAL_OBJECTS.has(target) && name === 'fetch' && !isSameOriginCall(node, file))
        at(node, `${target}.fetch`);
      if (NAVIGATOR.has(target) && name === 'sendBeacon') at(node, `${target}.sendBeacon`);
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
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      GLOBAL_OBJECTS.has(node.initializer.getText(sf)) &&
      node.name.elements.some((el) => (el.propertyName ?? el.name).getText(sf) === 'fetch')
    )
      at(node, `fetch from ${node.initializer.getText(sf)}`);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      constructors.has(node.expression.text) &&
      !isSameOriginCall(node.expression, file)
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
      if (specifier !== null && networkModules.has(packageOf(specifier)))
        at(node, `import ${specifier}`);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'socialProviders')
      at(node, 'socialProviders (outside sign-in)');
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
 * Whether a file imports the consent module and calls one of its helpers.
 *
 * @param source - The file's text.
 * @param file - Used for the parser's file kind.
 */
export function callsConsentHelper(source: string, file: string): boolean {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
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
