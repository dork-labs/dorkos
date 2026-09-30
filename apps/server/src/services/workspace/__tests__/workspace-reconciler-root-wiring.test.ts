import { MainRequestAdmission } from '../../core/lifecycle/main-request-admission.js';
/** Structural root wiring and an isolated startup-catch callback; no server boot/exit proof. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  function visit(child: ts.Node) {
    nodes.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return nodes;
}

function namedCall(node: ts.Node, receiver: string, method: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === receiver &&
    node.expression.name.text === method
  );
}

function ownerName(): string {
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        declaration.initializer &&
        ts.isNewExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === 'WorkspaceReconcilerLifecycle'
    );
  expect(declarations).toHaveLength(1);
  const name = declarations[0].name;
  expect(ts.isIdentifier(name)).toBe(true);
  return name.getText(source);
}

function expectAwaitedDisposal(statement: ts.Statement, owner: string) {
  expect(
    ts.isExpressionStatement(statement),
    'disposal must be an unconditional first statement'
  ).toBe(true);
  if (!ts.isExpressionStatement(statement)) throw new Error('Expected disposal statement');
  expect(ts.isAwaitExpression(statement.expression), 'disposal must be awaited').toBe(true);
  if (!ts.isAwaitExpression(statement.expression)) throw new Error('Expected awaited disposal');
  const call = statement.expression.expression;
  expect(
    namedCall(call, owner, 'dispose'),
    'await the same root owner before unrelated operations'
  ).toBe(true);
  if (!ts.isCallExpression(call)) throw new Error('Expected disposal call');
  expect(call.arguments).toHaveLength(0);
}

function expectAdmissionClose(statement: ts.Statement) {
  expect(
    ts.isExpressionStatement(statement) &&
      namedCall(statement.expression, 'mainRequestAdmission', 'close')
  ).toBe(true);
}

function startupCatch(): ts.ArrowFunction {
  const calls = descendants(source)
    .filter(ts.isCallExpression)
    .filter((call) => {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'catch')
        return false;
      const start = call.expression.expression;
      return (
        ts.isCallExpression(start) &&
        ts.isIdentifier(start.expression) &&
        start.expression.text === 'start'
      );
    });
  expect(calls).toHaveLength(1);
  const callback = calls[0].arguments[0];
  if (!ts.isArrowFunction(callback)) throw new Error('Expected startup catch callback');
  return callback;
}

describe('workspace reconciler root wiring (AST, not a full server boot)', () => {
  it('constructs one unshadowed module owner from the workspace barrel and starts the factory reconciler through it', () => {
    const owner = ownerName();
    const workspaceImport = source.statements
      .filter(ts.isImportDeclaration)
      .find(
        (node) =>
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === './services/workspace/index.js'
      );
    expect(workspaceImport).toBeDefined();
    const imports = descendants(workspaceImport!)
      .filter(ts.isImportSpecifier)
      .map((node) => node.name.text);
    expect(imports).toContain('WorkspaceReconcilerLifecycle');
    const ownerBindings = descendants(source).filter(
      (node) =>
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === owner
    );
    expect(ownerBindings).toHaveLength(1);
    const calls = descendants(source).filter((node) =>
      namedCall(node, owner, 'start')
    ) as ts.CallExpression[];
    expect(calls).toHaveLength(1);
    const argument = calls[0].arguments[0];
    expect(ts.isIdentifier(argument)).toBe(true);
    const factoryBindings = descendants(source)
      .filter(ts.isVariableDeclaration)
      .filter(
        (node) =>
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'createWorkspaceSubsystem'
      );
    expect(factoryBindings).toHaveLength(1);
    const binding = factoryBindings[0].name as ts.ObjectBindingPattern;
    const reconciler = binding.elements.find(
      (element) => element.propertyName?.getText(source) === 'reconciler'
    );
    expect(reconciler?.name.getText(source)).toBe(argument.getText(source));
    expect(
      descendants(source).filter((node) => namedCall(node, argument.getText(source), 'start'))
    ).toHaveLength(0);
  });

  it('closes admission then unconditionally awaits workspace disposal and propagates rejection', () => {
    const owner = ownerName();
    const shutdown = source.statements
      .filter(ts.isFunctionDeclaration)
      .find((node) => node.name?.text === 'shutdownServices');
    expect(shutdown?.body).toBeDefined();
    // No unrelated work or await may separate admission close from the workspace fence.
    expectAdmissionClose(shutdown!.body!.statements[0]);
    expectAwaitedDisposal(shutdown!.body!.statements[1], owner);
  });

  it('awaits the same owner first in startup failure and contains only that disposal failure', () => {
    const owner = ownerName();
    const callback = startupCatch();
    if (!ts.isBlock(callback.body)) throw new Error('Expected startup callback block');
    expectAdmissionClose(callback.body.statements[0]);
    const first = callback.body.statements[1];
    expect(ts.isTryStatement(first)).toBe(true);
    if (!ts.isTryStatement(first)) throw new Error('Expected scoped workspace cleanup try');
    expect(first.tryBlock.statements).toHaveLength(1);
    expectAwaitedDisposal(first.tryBlock.statements[0], owner);
    expect(first.finallyBlock).toBeUndefined();
    const caught = first.catchClause;
    expect(caught).toBeDefined();
    expect(caught!.block.statements).toHaveLength(1);
    const report = caught!.block.statements[0];
    expect(
      ts.isExpressionStatement(report) && namedCall(report.expression, 'logger', 'error')
    ).toBe(true);
    expect(descendants(caught!.block).some(ts.isThrowStatement)).toBe(false);
    // The existing unrelated fixture cleanup remains outside the contained failure.
    const fixtureClose = callback.body.statements[2];
    expect(
      ts.isExpressionStatement(fixtureClose) && ts.isAwaitExpression(fixtureClose.expression)
    ).toBe(true);
    if (!ts.isExpressionStatement(fixtureClose) || !ts.isAwaitExpression(fixtureClose.expression))
      throw new Error('Expected fixture cleanup await');
    const fixtureCall = fixtureClose.expression.expression;
    expect(ts.isCallExpression(fixtureCall)).toBe(true);
    if (!ts.isCallExpression(fixtureCall) || !ts.isPropertyAccessExpression(fixtureCall.expression))
      throw new Error('Expected fixture close call');
    expect(fixtureCall.expression.name.text).toBe('close');
    expect(
      ts.isIdentifier(fixtureCall.expression.expression) &&
        fixtureCall.expression.expression.text === 'testComposioFixture'
    ).toBe(true);
  });

  it.each(['throw', 'reject'] as const)(
    'preserves the original startup error across workspace disposal %s',
    async (mode) => {
      // Execute only the actual catch callback with explicit bindings, never root imports/startup.
      const { WorkspaceReconcilerLifecycle } = await import('../workspace-reconciler-lifecycle.js');
      const { WorkspaceReconciler } = await import('../workspace-reconciler.js');
      const owner = new WorkspaceReconcilerLifecycle();
      const reconciler = new WorkspaceReconciler(
        {} as ConstructorParameters<typeof WorkspaceReconciler>[0]
      );
      vi.spyOn(reconciler, 'start').mockImplementation(() => {});
      owner.start(reconciler);
      const cleanupError = new Error('workspace cleanup');
      vi.spyOn(reconciler, 'dispose').mockImplementation(() => {
        if (mode === 'throw') throw cleanupError;
        return Promise.reject(cleanupError);
      });
      const original = new Error('startup original');
      const logged = { error: vi.fn() };
      const logError = vi.fn((error: unknown) => error);
      const exit = vi.fn();
      const fixtureClose = vi.fn().mockResolvedValue(undefined);
      const callback = startupCatch();
      const javascript = ts.transpileModule(`(${callback.getText(source)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText;
      const run = runInNewContext(javascript, {
        [ownerName()]: owner,
        mainRequestAdmission: new MainRequestAdmission(),
        logger: logged,
        logError,
        process: { exit },
        testComposioFixture: { close: fixtureClose },
        DatabaseOpenError: class extends Error {},
        SnapshotFailedError: class extends Error {},
      }) as (error: Error) => Promise<void>;
      try {
        await run(original);
        expect(logged.error).toHaveBeenCalledWith(
          '[workspace] Reconciliation disposal failed during startup cleanup:',
          cleanupError
        );
        expect(fixtureClose).toHaveBeenCalledTimes(1);
        expect(logError).toHaveBeenCalledExactlyOnceWith(original);
        expect(logged.error).toHaveBeenLastCalledWith(
          '[DorkOS] Fatal error during startup',
          original
        );
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        vi.restoreAllMocks();
      }
    }
  );
});
