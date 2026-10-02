/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile(
  'index.ts',
  fs.readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
function collect<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  function visit(node: ts.Node) {
    if (guard(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return nodes;
}
const calls = collect(ts.isCallExpression);
const assignments = collect(ts.isBinaryExpression);
function localAssignment(name: string): ts.ObjectLiteralExpression {
  const matches = assignments.filter(
    (node) =>
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === `app.locals.${name}`
  );
  expect(matches).toHaveLength(1);
  const assigned = matches[0]!.right;
  const value = ts.isSatisfiesExpression(assigned) ? assigned.expression : assigned;
  expect(ts.isObjectLiteralExpression(value)).toBe(true);
  return value as ts.ObjectLiteralExpression;
}

describe('production document metrics bootstrap', () => {
  it('constructs one instance using the migrated database and hands the same instance to both routes', () => {
    const constructions = collect(ts.isNewExpression).filter(
      (node) => node.expression.getText(source) === 'DocChannelMetrics'
    );
    expect(constructions).toHaveLength(1);
    const construction = constructions[0]!;
    expect(construction.arguments?.map((node) => node.getText(source))).toEqual(['db']);
    expect(ts.isVariableDeclaration(construction.parent)).toBe(true);
    const name = (construction.parent as ts.VariableDeclaration).name.getText(source);
    const migrations = calls.filter((node) => node.expression.getText(source) === 'runMigrations');
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.arguments.map((node) => node.getText(source))).toEqual(['db']);
    expect(migrations[0]!.pos).toBeLessThan(construction.pos);
    const http = localAssignment('docChannelHttp');
    const metrics = http.properties
      .filter(ts.isPropertyAssignment)
      .filter((node) => node.name.getText(source) === 'metrics');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.initializer.getText(source)).toBe(name);
    const debug = localAssignment('debugDeps');
    expect(
      debug.properties
        .filter(ts.isShorthandPropertyAssignment)
        .map((node) => node.name.getText(source))
    ).toContain(name);
    expect(
      calls.filter(
        (node) =>
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'recordHttpResult'
      )
    ).toHaveLength(0);
  });
});
