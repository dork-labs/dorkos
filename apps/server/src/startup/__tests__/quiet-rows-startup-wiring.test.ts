/**
 * DOR-3427, QA's NO-GO at `366fbcc84f`: the saved quiet rows are picked up at
 * startup on every server, relay on or off.
 *
 * The pickup used to sit inside `startMarketplace`'s
 * `if (extensionManager && adapterManager)` block, which a server with relay
 * off skips, so a yes given after a restart was lost there. It now runs from
 * the approvals startup step, which `index.ts` runs unconditionally. Booting
 * the whole server with relay off is not something a unit test can do, so the
 * wiring is read off the source, the way `main-admission-root-wiring.test.ts`
 * reads the composition root; what the pickup does is
 * `services/harness/__tests__/hook-passive-restart.test.ts`.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Parse one server source file. */
function parse(relative: string): ts.SourceFile {
  const url = new URL(relative, import.meta.url);
  return ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Every call in `root` to a function named `name`. */
function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Whether anything between `node` and `stop` decides whether it runs. */
function isConditional(node: ts.Node, stop: ts.Node): boolean {
  for (let at = node.parent; at && at !== stop; at = at.parent) {
    if (
      ts.isIfStatement(at) ||
      ts.isConditionalExpression(at) ||
      ts.isSwitchStatement(at) ||
      ts.isForStatement(at) ||
      ts.isForOfStatement(at) ||
      ts.isForInStatement(at) ||
      ts.isWhileStatement(at) ||
      ts.isDoStatement(at) ||
      ts.isFunctionLike(at) ||
      (ts.isBinaryExpression(at) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(at.operatorToken.kind))
    ) {
      return true;
    }
  }
  return false;
}

/** The named function declaration in a file. */
function functionNamed(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = file.statements
    .filter(ts.isFunctionDeclaration)
    .find((node) => node.name?.text === name);
  if (!fn?.body) throw new Error(`Missing function ${name}`);
  return fn;
}

describe('the saved quiet rows are picked up on every server (DOR-3427)', () => {
  it('the approvals step picks them up unconditionally, with its own approval service', () => {
    const step = functionNamed(
      parse('../steps/connector-events-approvals.ts'),
      'wireConnectorEventsAndApprovals'
    );
    const calls = callsTo(step.body!, 'resumeQuietRowsAtStartup');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(isConditional(call!, step.body!)).toBe(false);
    const first = call!.arguments[0];
    expect(first && ts.isIdentifier(first) ? first.text : undefined).toBe('approvalService');
  });

  it('the server always runs the approvals step, whatever relay is set to', () => {
    const index = parse('../../index.ts');
    const calls = callsTo(index, 'wireConnectorEventsAndApprovals');
    expect(calls).toHaveLength(1);
    // Within the startup function that holds it, nothing decides whether it runs.
    let enclosing: ts.Node = calls[0]!;
    while (enclosing.parent && !ts.isFunctionLike(enclosing.parent)) enclosing = enclosing.parent;
    expect(isConditional(calls[0]!, enclosing.parent ?? index)).toBe(false);
  });

  it('the marketplace step, which relay off skips, no longer picks them up', () => {
    const marketplace = parse('../marketplace.ts');
    expect(callsTo(marketplace, 'resumePassiveHookRows')).toEqual([]);
    expect(callsTo(marketplace, 'resumeQuietRowsAtStartup')).toEqual([]);
  });
});
