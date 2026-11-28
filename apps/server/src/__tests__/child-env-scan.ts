/**
 * The scanner behind `child-env-census.test.ts`: finds every call that starts
 * a child process and says whether its environment comes from
 * `childEnvironment` (or a wrapper built on it).
 *
 * A start is a call to `spawn`, `spawnSync`, `execFile`, `execFileSync`,
 * `exec`, `execSync` or `fork` imported from `child_process` (or a
 * `promisify` of one), `pty.spawn` from `node-pty`, or `new
 * StdioClientTransport`. Its environment is helper-built when an `env:`
 * property in one of its object arguments calls `childEnvironment(` or a
 * listed wrapper. Anything else, including a start with no `env:` (which
 * inherits the whole `process.env`), is a site the census JSON must name.
 *
 * @module __tests__/child-env-scan
 */
import ts from 'typescript';

/** Source text without its comments, so a comment naming `process.env` is not a read. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const CHILD_PROCESS_STARTS = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
]);

/** A start whose environment is not helper-built. */
export interface UnlistedStart {
  /** Its line, for messages. */
  readonly line: number;
  /**
   * What the census matches a row against: the callee and the `env:` it
   * passes (`spawn env: options.env`), `(none)` when it passes none, or the
   * start's name and what it was passed into when it escapes as a value.
   */
  readonly site: string;
}

/** What the scanner found in one file. */
export interface FileScan {
  /** Starts whose environment is not helper-built. */
  readonly unlisted: readonly UnlistedStart[];
  /** Starts whose environment is helper-built. */
  readonly helperBuilt: number;
  /** `env:` properties that read `process.env`, as `line: text`. */
  readonly processEnvLeaks: readonly string[];
}

/**
 * Scan one source file.
 *
 * @param fileName - For TypeScript's parser.
 * @param source - The file's text.
 * @param helpers - `childEnvironment` and the wrapper names that count as helper-built.
 */
export function scanChildStarts(
  fileName: string,
  source: string,
  helpers: readonly string[]
): FileScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  let stdioTransport: string | null = null;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (from === 'node:child_process' || from === 'child_process' || from === 'node-pty') {
      if (clause.name) namespaces.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings) && from !== 'node-pty')
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (CHILD_PROCESS_STARTS.has(imported)) direct.add(element.name.text);
        }
    }
    if (from.includes('@modelcontextprotocol/sdk/client/stdio')) {
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === 'StdioClientTransport')
            stdioTransport = element.name.text;
    }
  }

  const isStartCallee = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return direct.has(callee.text);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
      return namespaces.has(callee.expression.text) && CHILD_PROCESS_STARTS.has(callee.name.text);
    // promisify(execFile)(...)
    if (ts.isCallExpression(callee)) return isPromisifyOfStart(callee);
    return false;
  };
  const isPromisifyOfStart = (call: ts.CallExpression): boolean =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'promisify' &&
    call.arguments.length === 1 &&
    isStartCallee(call.arguments[0]!);

  // const run = promisify(execFile), and const { exec } = await import('node:child_process')
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      /^(await\s+)?(import|require)\(['"](node:)?child_process['"]\)$/.test(
        node.initializer.getText(file)
      )
    )
      for (const element of node.name.elements) {
        const imported = (element.propertyName ?? element.name).getText(file);
        if (CHILD_PROCESS_STARTS.has(imported) && ts.isIdentifier(element.name))
          direct.add(element.name.text);
      }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isPromisifyOfStart(node.initializer)
    )
      direct.add(node.name.text);
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(file);

  const helperCall = new RegExp(`\\b(${helpers.join('|')})\\(`);
  const unlisted: UnlistedStart[] = [];
  const flat = (node: ts.Node): string =>
    withoutComments(node.getText(file)).replace(/\s+/g, ' ').trim();
  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const processEnvLeaks: string[] = [];
  let helperBuilt = 0;
  const where = (node: ts.Node): string => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return `${line + 1}: ${node.getText(file).split('\n')[0]!.slice(0, 80)}`;
  };
  const envOf = (args: readonly ts.Expression[]): ts.Expression | null => {
    for (const arg of args) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const property of arg.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'env')
          return property.initializer;
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'env')
          return property.name;
      }
    }
    return null;
  };

  const escapes = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ((ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isParameter(parent) ||
        ts.isPropertyAssignment(parent)) &&
        parent.name === node)
    )
      return false;
    if (ts.isCallExpression(parent) && parent.expression === node) return false;
    if (ts.isCallExpression(parent) && isPromisifyOfStart(parent)) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent)) return false;
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'env' &&
      /\bprocess\.env\b/.test(withoutComments(node.initializer.getText(file)))
    )
      processEnvLeaks.push(where(node));
    const start =
      (ts.isCallExpression(node) && isStartCallee(node.expression)) ||
      (ts.isNewExpression(node) &&
        stdioTransport !== null &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === stdioTransport);
    if (start) {
      const args = (node as ts.CallExpression | ts.NewExpression).arguments ?? [];
      const env = envOf(args);
      const callee = (node as ts.CallExpression | ts.NewExpression).expression;
      if (env && helperCall.test(env.getText(file))) helperBuilt += 1;
      else
        unlisted.push({
          line: lineOf(node),
          site: `${flat(callee)} env: ${env ? flat(env) : '(none)'}`,
        });
    }
    // A start passed on as a value (a default spawner, a cast) starts children
    // the scanner can't follow: it counts as a site to name.
    if (ts.isIdentifier(node) && direct.has(node.text) && escapes(node))
      unlisted.push({
        line: lineOf(node),
        site: `${node.text} as a value: ${flat(node.parent).slice(0, 80)}`,
      });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { unlisted, helperBuilt, processEnvLeaks };
}
