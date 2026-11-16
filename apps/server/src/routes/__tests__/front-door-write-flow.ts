/** Trace known access writes through held callbacks and explicit narrowing branches. */
import ts from 'typescript';

const HELD = new Set(['runFrontDoorWrite', 'runAccountWrite']);
const WRITES = new Set([
  'start',
  'startLink',
  'selectMode',
  'trustSource',
  'link',
  'updatePin',
  'assignSeat',
  'openBillingPage',
  'requestAccountExport',
  'requestAccountDeletion',
  'setCreditsDefault',
  'startCommunity',
  'startMove',
  'retry',
  'begin',
  'takeClaimLink',
  'keepCommunity',
  'restoreCommunity',
  'signOutSession',
  'signOutOtherSessions',
  'applyGuardedConfigWrite',
  'setChoice',
  'rotateMcpLocalToken',
]);
type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const compact = (text: string) => text.replace(/\s+/g, '').replaceAll('"', "'");

/** Resolve a helper in its lexical block, never another route's same-named helper. */
function localFunction(name: string, from: ts.Node): Fn | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          value &&
          (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        )
          return value;
      }
    }
  }
  return undefined;
}

/** The exported function a small route module delegates its handler to. */
export function exportedHandler(source: ts.SourceFile, name: string): Fn {
  const fn = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!fn) throw new Error(`${source.fileName}: missing delegated handler ${name}`);
  return fn;
}

/**
 * Known lasting writes must execute inside a held callback, unless an explicit
 * narrowing condition dominates the call. Merely mentioning a hold elsewhere
 * in a handler does not protect a write before it or in another branch.
 */
export function unguardedWrites(
  handlers: readonly ts.Node[],
  narrowing: readonly string[],
  delegates: ReadonlyMap<string, Fn>
): string[] {
  const violations: string[] = [];
  const allowed = new Set(narrowing.map(compact));

  function invoke(fn: Fn, guarded: boolean, conditions: readonly string[], seen: ReadonlySet<Fn>) {
    if (!fn.body || seen.has(fn)) return;
    walk(fn.body, guarded, conditions, new Set([...seen, fn]));
  }
  function resolve(expression: ts.Expression): Fn | undefined {
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    return localFunction(expression.text, expression) ?? delegates.get(expression.text);
  }
  function argument(
    node: ts.Node,
    guarded: boolean,
    conditions: readonly string[],
    seen: ReadonlySet<Fn>
  ) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      invoke(node, guarded, conditions, seen);
    else walk(node, guarded, conditions, seen);
  }
  function walk(
    node: ts.Node,
    guarded: boolean,
    conditions: readonly string[],
    seen: ReadonlySet<Fn>
  ): void {
    // A declared callback does nothing until a call above invokes it.
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return;
    if (ts.isIfStatement(node)) {
      walk(node.expression, guarded, conditions, seen);
      walk(node.thenStatement, guarded, [...conditions, compact(node.expression.getText())], seen);
      if (node.elseStatement) walk(node.elseStatement, guarded, conditions, seen);
      return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : '';
      if (HELD.has(name)) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) {
            walk(arg, guarded, conditions, seen);
            continue;
          }
          for (const property of arg.properties) {
            if (property.name?.getText() !== 'run') {
              walk(property, guarded, conditions, seen);
              continue;
            }
            const value = ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? property.name
                : undefined;
            const fn = value && resolve(value);
            if (!fn) violations.push('unresolved held callback');
            else invoke(fn, true, conditions, seen);
          }
        }
        return;
      }
      const writes = WRITES.has(name) || compact(expression.getText()) === 'configManager.set';
      if (writes && !guarded && !conditions.some((condition) => allowed.has(condition))) {
        violations.push(expression.getText());
      }
      if (ts.isIdentifier(expression)) {
        const fn = resolve(expression);
        if (fn) invoke(fn, guarded, conditions, seen);
      }
      for (const arg of node.arguments) argument(arg, guarded, conditions, seen);
      return;
    }
    ts.forEachChild(node, (child) => walk(child, guarded, conditions, seen));
  }
  for (const handler of handlers) {
    if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
      invoke(handler, false, [], new Set());
    else walk(handler, false, [], new Set());
  }
  return violations;
}
