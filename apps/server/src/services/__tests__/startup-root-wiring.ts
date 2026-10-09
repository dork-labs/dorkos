/** Inspect exact root promise ownership; never imports or boots production index. */
import ts from 'typescript';
import { expect } from 'vitest';
function walk(node: ts.Node): ts.Node[] {
  const result = [node];
  ts.forEachChild(node, (child) => {
    result.push(...walk(child));
  });
  return result;
}
function directCall(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name &&
    !node.questionDotToken
  );
}
function originalVariable(source: ts.SourceFile, factory: string) {
  const statements = source.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.declarationList.declarations.some(
        (declaration) => declaration.initializer && directCall(declaration.initializer, factory)
      )
    );
  expect(statements).toHaveLength(1);
  expect(statements[0].declarationList.flags & ts.NodeFlags.Const).not.toBe(0);
  const declarations = statements[0].declarationList.declarations;
  expect(declarations).toHaveLength(1);
  const declaration = declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !directCall(declaration.initializer, factory)
  )
    throw new Error('Missing original root factory');
  expect(declaration.initializer.arguments).toHaveLength(0);
  expect(walk(source).filter((node) => directCall(node, factory))).toHaveLength(1);
  const name = declaration.name.text;
  expect(
    walk(source).filter(
      (node) =>
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name
    )
  ).toHaveLength(1);
  return { name, statement: statements[0] };
}
export function originalStartupCatch(source: ts.SourceFile): ts.ArrowFunction {
  const original = originalVariable(source, 'start');
  const calls = walk(source)
    .filter(ts.isCallExpression)
    .filter(
      (node) =>
        ts.isPropertyAccessExpression(node.expression) &&
        !node.expression.questionDotToken &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === original.name &&
        node.expression.name.text === 'catch' &&
        !node.questionDotToken
    );
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call.arguments).toHaveLength(1);
  expect(
    source.statements.some(
      (statement) => ts.isExpressionStatement(statement) && statement.expression === call
    )
  ).toBe(true);
  const callback = call.arguments[0];
  if (!ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
    throw new Error('Missing original startup callback');
  expect(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(
    true
  );
  const captures = source.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(ts.isCallExpression)
    .filter(
      (node) =>
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'captureStartup'
    );
  expect(captures).toHaveLength(1);
  const capture = captures[0];
  if (
    !ts.isPropertyAccessExpression(capture.expression) ||
    !directCall(capture.expression.expression, 'readPrivateBrowserAcceptance')
  )
    throw new Error('Missing original private owner capture');
  expect(capture.arguments).toHaveLength(1);
  expect(capture.arguments[0].getText(source)).toBe(original.name);
  expect(capture.pos).toBeGreaterThan(original.statement.pos);
  expect(capture.end).toBeLessThan(call.pos);
  return callback;
}
export function originalStartupCleanup(source: ts.SourceFile) {
  const callback = originalStartupCatch(source);
  if (!ts.isBlock(callback.body)) throw new Error('Missing callback block');
  const statements = callback.body.statements;
  const admission = statements[0];
  expect(
    ts.isExpressionStatement(admission) &&
      ts.isCallExpression(admission.expression) &&
      admission.expression.expression.getText(source) === 'mainRequestAdmission.close' &&
      admission.expression.arguments.length === 0
  ).toBe(true);
  const joined = statements[1];
  if (!ts.isVariableStatement(joined)) throw new Error('Missing captured original projection join');
  expect(joined.declarationList.flags & ts.NodeFlags.Const).not.toBe(0);
  expect(joined.declarationList.declarations).toHaveLength(1);
  const declaration = joined.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !directCall(declaration.initializer, 'joinOriginalProjectionStartupFailure')
  )
    throw new Error('Missing exact original projection join');
  const projection = originalVariable(source, 'readOriginalProcessNativeProjection');
  expect(declaration.initializer.arguments).toHaveLength(2);
  expect(declaration.initializer.arguments[0].getText(source)).toBe(projection.name);
  expect(callback.parameters).toHaveLength(1);
  expect(declaration.initializer.arguments[1].getText(source)).toBe(
    callback.parameters[0].name.getText(source)
  );
  const failures = statements[2];
  expect(
    ts.isVariableStatement(failures) &&
      failures.declarationList.declarations[0].name.getText(source) === 'startupCleanupFailures'
  ).toBe(true);
  const outer = statements[3];
  if (!ts.isTryStatement(outer) || !outer.finallyBlock || outer.catchClause)
    throw new Error('Missing independent original projection finally');
  expect(outer.finallyBlock.statements).toHaveLength(1);
  const final = outer.finallyBlock.statements[0];
  expect(
    ts.isExpressionStatement(final) &&
      ts.isAwaitExpression(final.expression) &&
      ts.isIdentifier(final.expression.expression) &&
      final.expression.expression.text === declaration.name.text
  ).toBe(true);
  const workspace = outer.tryBlock.statements[0];
  if (!ts.isTryStatement(workspace)) throw new Error('Missing scoped workspace containment');
  const offline = outer.tryBlock.statements[1];
  if (!ts.isTryStatement(offline)) throw new Error('Missing scoped original offline listener join');
  expect(offline.tryBlock.statements).toHaveLength(1);
  const close = offline.tryBlock.statements[0];
  expect(
    ts.isExpressionStatement(close) &&
      ts.isAwaitExpression(close.expression) &&
      ts.isCallExpression(close.expression.expression) &&
      close.expression.expression.expression.getText(source) === 'testComposioFixture?.close' &&
      close.expression.expression.arguments.length === 0
  ).toBe(true);
  expect(offline.catchClause).toBeDefined();
  expect(offline.finallyBlock?.statements[0].getText(source)).toBe(
    'testComposioFixture = undefined;'
  );
  return { callback, outer, workspace, offline };
}
