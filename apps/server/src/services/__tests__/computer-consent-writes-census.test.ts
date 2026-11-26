/**
 * Census: no computer-side file writes the `harness` or `permissions` settings
 * (spec `computer-side-starts-alone` §5.4, §5.7, C14).
 *
 * Those two sections hold the standing consent decisions: who may install
 * hooks, which agent folder settings and allow lists may apply, which repo
 * settings may run, and the upgrade pins. The space side writes them
 * (`core/approvals/computer-asks/`), from a card's answer or from a decision
 * the computer reports through the asks port. This fails when a computer-side
 * file (by `eslint-rules/sides.json`) calls a writer with either section:
 * `<anything>.set('harness' | 'permissions', …)` (and `patch`, `update`,
 * `replace`), `logConfigWrite(…, 'harness' | 'permissions', …)`, or
 * `configManager.set(<a section it cannot name>, …)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sideOf } from '../../../eslint-rules/computer-wall.js';

const SERVICES = path.resolve(__dirname, '..');

/** The sections only the space side may write. */
const SPACE_WRITTEN = new Set(['harness', 'permissions']);

/** The method names that write a config section. */
const WRITERS = new Set(['set', 'patch', 'update', 'replace']);

/** Every non-test source file under `services/`, absolute. */
function serviceFiles(dir = SERVICES): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === '__fixtures__' ? [] : serviceFiles(full);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.(test|spec)\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}

/** A string literal's text, or `undefined` for anything else. */
function literal(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/**
 * The writes of the two space-written sections one source makes, as
 * `line: text`.
 *
 * @param fileName - The file's name, for the parser.
 * @param text - Its source.
 */
function consentWritesIn(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const report = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${line + 1}: ${node.getText(source).split('\n')[0]}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first, second] = node.arguments;
      if (ts.isPropertyAccessExpression(callee) && WRITERS.has(callee.name.text)) {
        const section = literal(first);
        if (section !== undefined && SPACE_WRITTEN.has(section)) report(node);
        else if (
          section === undefined &&
          callee.name.text === 'set' &&
          /configManager$/u.test(callee.expression.getText(source))
        ) {
          report(node);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'logConfigWrite') {
        const section = literal(second);
        if (section !== undefined && SPACE_WRITTEN.has(section)) report(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the computer side writes no consent decision (C14)', () => {
  it('finds no write of `harness` or `permissions` in any computer-side file', () => {
    const offenders = serviceFiles()
      .filter((file) => sideOf(file) === 'computer')
      .flatMap((file) =>
        consentWritesIn(file, fs.readFileSync(file, 'utf8')).map(
          (hit) => `${path.relative(SERVICES, file)}:${hit}`
        )
      );
    expect(offenders).toEqual([]);
  });

  it('sees the writes it exists to refuse', () => {
    const planted = [
      "configManager.set('harness', { ...harness, approvedHooks: [] });",
      "configManager.set('permissions', next);",
      "logConfigWrite('approving', 'harness', before, after);",
      'configManager.set(section, value);',
      "store.patch('permissions', { approvedFolderAllows: [] });",
    ].join('\n');
    expect(consentWritesIn('planted.ts', planted)).toHaveLength(5);
    // The two sections the computer still writes (spec §5.4) pass.
    expect(
      consentWritesIn(
        'allowed.ts',
        "configManager.set('runtimes', next);\nlogConfigWrite('setup', 'providers', a, b);"
      )
    ).toEqual([]);
  });

  it('counts the space side’s own door as space side, and its store is built outside services', () => {
    const door = path.join(SERVICES, 'core/approvals/computer-asks/consent-config.ts');
    expect(sideOf(door)).toBe('space');
    // The store over `configManager` is handed in by a composition root.
    const root = path.join(SERVICES, '../startup/computer-asks.ts');
    expect(consentWritesIn(root, fs.readFileSync(root, 'utf8'))).not.toEqual([]);
    expect(sideOf(root)).not.toBe('computer');
  });
});
