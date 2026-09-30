/** Structural root wiring plus isolated cleanup execution; this does not boot the server. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MainRequestAdmission } from '../main-request-admission.js';
import { WorkspaceReconciler } from '../../../workspace/workspace-reconciler.js';
import { WorkspaceReconcilerLifecycle } from '../../../workspace/workspace-reconciler-lifecycle.js';
import { WorkspaceService } from '../../../workspace/workspace-service.js';
import type { WorkspaceStore } from '../../../workspace/workspace-store.js';

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('../../../../index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
function walk(node: ts.Node): ts.Node[] {
  const nodes = [node];
  ts.forEachChild(node, (child) => {
    nodes.push(...walk(child));
  });
  return nodes;
}
function rootFunction(name: string) {
  const fn = source.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === name);
  if (!fn?.body) throw new Error(`Missing root function ${name}`);
  return fn;
}
function property(options: ts.ObjectLiteralExpression, name: string) {
  const prop = options.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name
  );
  if (!prop || !ts.isPropertyAssignment(prop)) throw new Error(`Missing option ${name}`);
  return prop.initializer;
}
function rootVariable(name: string, statements: readonly ts.Statement[] = source.statements) {
  const declaration = statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
  if (!declaration) throw new Error(`Missing direct variable ${name}`);
  return declaration;
}
function call(node: ts.Node, name: string): ts.CallExpression {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== name
  )
    throw new Error(`Expected direct ${name} call`);
  return node;
}
function options(node: ts.Node) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Expected literal options');
  return node;
}
function named(node: ts.Node, name: string) {
  expect(ts.isIdentifier(node) && node.text === name).toBe(true);
}
function closeFirst(statement: ts.Statement) {
  if (!ts.isExpressionStatement(statement))
    throw new Error('Admission close must be the first synchronous statement');
  const expr = statement.expression;
  expect(
    ts.isCallExpression(expr) &&
      !expr.questionDotToken &&
      ts.isPropertyAccessExpression(expr.expression) &&
      !expr.expression.questionDotToken &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === 'mainRequestAdmission' &&
      expr.expression.name.text === 'close' &&
      expr.arguments.length === 0
  ).toBe(true);
}
function disposeNext(statement: ts.Statement) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression))
    throw new Error('Workspace disposal must be the next direct await');
  const expr = statement.expression.expression;
  expect(
    ts.isCallExpression(expr) &&
      !expr.questionDotToken &&
      ts.isPropertyAccessExpression(expr.expression) &&
      !expr.expression.questionDotToken &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === 'workspaceReconcilerLifecycle' &&
      expr.expression.name.text === 'dispose' &&
      expr.arguments.length === 0
  ).toBe(true);
}

describe('main admission root adoption', () => {
  it('owns exactly one passive admission instance and injects it into HTTP, listener and upgrades', () => {
    const constructors = walk(source)
      .filter(ts.isNewExpression)
      .filter(
        (node) =>
          ts.isIdentifier(node.expression) && node.expression.text === 'MainRequestAdmission'
      );
    expect(constructors).toHaveLength(1);
    expect(rootVariable('mainRequestAdmission').initializer).toBe(constructors[0]);
    const statements = rootFunction('start').body!.statements;
    const app = call(rootVariable('app', statements).initializer!, 'createApp');
    named(property(options(app.arguments[0]), 'admission'), 'mainRequestAdmission');
    const listener = call(rootVariable('server', statements).initializer!, 'startMainListener');
    const opts = options(listener.arguments[0]);
    named(property(opts, 'admission'), 'mainRequestAdmission');
    const factory = property(opts, 'listen');
    if (!ts.isArrowFunction(factory) || !ts.isCallExpression(factory.body))
      throw new Error('Main listen must be acquired by the guarded factory');
    expect(
      ts.isPropertyAccessExpression(factory.body.expression) &&
        ts.isIdentifier(factory.body.expression.expression) &&
        factory.body.expression.expression.text === 'app' &&
        factory.body.expression.name.text === 'listen'
    ).toBe(true);
    const callback = property(opts, 'onListening');
    if (!ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
      throw new Error('Expected guarded listening callback');
    const upgradeCalls = callback.body.statements
      .filter(ts.isExpressionStatement)
      .map((node) => node.expression)
      .filter(
        (node) =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'attachUpgradeRouter'
      ) as ts.CallExpression[];
    expect(upgradeCalls).toHaveLength(1);
    named(upgradeCalls[0].arguments[2], 'mainRequestAdmission');
    // No unguarded competing main-listen call may survive outside the factory.
    const listeners = walk(rootFunction('start'))
      .filter(ts.isCallExpression)
      .filter(
        (node) =>
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'app' &&
          node.expression.name.text === 'listen'
      );
    expect(listeners).toEqual([factory.body]);
  });

  it('closes admission then immediately invokes workspace disposal in both cleanup entries', () => {
    const ordinary = rootFunction('shutdownServices').body!.statements;
    closeFirst(ordinary[0]);
    disposeNext(ordinary[1]);
    const startup = source.statements
      .filter(ts.isExpressionStatement)
      .map((node) => node.expression)
      .find(
        (node) =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'catch' &&
          ts.isCallExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === 'start'
      );
    if (
      !startup ||
      !ts.isCallExpression(startup) ||
      !ts.isArrowFunction(startup.arguments[0]) ||
      !ts.isBlock(startup.arguments[0].body)
    )
      throw new Error('Missing startup cleanup');
    const statements = startup.arguments[0].body.statements;
    closeFirst(statements[0]);
    const scoped = statements[1];
    if (!ts.isTryStatement(scoped))
      throw new Error('Workspace startup failure containment must remain scoped');
    expect(scoped.tryBlock.statements).toHaveLength(1);
    disposeNext(scoped.tryBlock.statements[0]);
  });

  it('executes the actual root prefix without waiting for a pending listener close or later cleanup', async () => {
    const { startMainListener } = await import('../main-listener.js');
    const admission = new MainRequestAdmission();
    const pendingListener = createServer();
    const close = vi.spyOn(pendingListener, 'close').mockReturnValue(pendingListener);
    const announced = vi.fn();
    startMainListener({ admission, listen: () => pendingListener, onListening: announced });
    let release!: (value: boolean) => void;
    const read = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    vi.spyOn(WorkspaceService, 'checkoutExists').mockReturnValueOnce(read);
    const removeRow = vi.fn();
    const reconciler = new WorkspaceReconciler({
      list: () => [{ id: 'held', path: '/held' }],
      removeRow,
    } as unknown as WorkspaceStore);
    const owner = new WorkspaceReconcilerLifecycle();
    owner.start(reconciler);
    const pass = reconciler.reconcile();
    const stopAfterPrefix = new Error('later cleanup sentinel');
    const compiled = ts.transpileModule(`(${rootFunction('shutdownServices').getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const cleanup = runInNewContext(compiled, {
      mainRequestAdmission: admission,
      workspaceReconcilerLifecycle: owner,
      logger: {
        info: () => {
          throw stopAfterPrefix;
        },
      },
    }) as () => Promise<void>;
    try {
      const completion = cleanup();
      expect(admission.isClosed).toBe(true);
      expect(() => reconciler.start()).toThrow(/disposed/i);
      pendingListener.emit('listening');
      expect(close).toHaveBeenCalledTimes(1);
      expect(announced).not.toHaveBeenCalled();
      release(false);
      await pass;
      await expect(completion).rejects.toBe(stopAfterPrefix);
      expect(removeRow).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
