/** Real-path ownership and the CLI's configuration-free ownership import boundary. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { canonicalize, resolveDirectoryOwnership } from '../directory-ownership.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Make an isolated real filesystem tree without borrowing the user's data directory. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dorkos-ownership-'));
  roots.push(root);
  return root;
}

describe('directory ownership', () => {
  it('keeps agent homes, exact room worktrees and ordinary folders distinct', () => {
    const home = fixture();
    const agent = join(home, 'agents', 'agent-a');
    const room = join(home, 'rooms', 'room-a', 'worktrees', 'agent-a');
    mkdirSync(agent, { recursive: true });
    mkdirSync(room, { recursive: true });
    mkdirSync(join(agent, 'nested'));
    expect(resolveDirectoryOwnership(agent, home)).toBe('agent-home');
    expect(resolveDirectoryOwnership(join(agent, 'nested'), home)).toBe('agent-home');
    expect(resolveDirectoryOwnership(join(home, 'agents'), home)).toBe('plain');
    expect(resolveDirectoryOwnership(room, home)).toBe('room-worktree');
    expect(resolveDirectoryOwnership(join(room, 'nested'), home)).toBe('plain');
    expect(resolveDirectoryOwnership(join(home, 'agents-other', 'agent-a'), home)).toBe('plain');
    expect(canonicalize(join(home, 'missing', '..', 'future'))).toBe(resolve(home, 'future'));
  });

  it('canonicalizes linked homes and refuses links escaping the agents directory', () => {
    const root = fixture();
    const home = join(root, 'home');
    const alias = join(root, 'home-link');
    const foreign = join(root, 'foreign');
    mkdirSync(join(home, 'agents', 'agent-a'), { recursive: true });
    mkdirSync(join(home, 'rooms', 'room-a', 'worktrees', 'agent-a'), { recursive: true });
    mkdirSync(foreign);
    symlinkSync(home, alias, 'junction');
    symlinkSync(foreign, join(home, 'agents', 'escape'), 'junction');
    expect(canonicalize(alias)).toBe(realpathSync(home));
    expect(resolveDirectoryOwnership(join(alias, 'agents', 'agent-a'), home)).toBe('agent-home');
    expect(resolveDirectoryOwnership(join(home, 'agents', 'agent-a'), alias)).toBe('agent-home');
    expect(
      resolveDirectoryOwnership(join(alias, 'rooms', 'room-a', 'worktrees', 'agent-a'), home)
    ).toBe('room-worktree');
    expect(resolveDirectoryOwnership(join(home, 'agents', 'escape'), home)).toBe('plain');
  });

  it('loads only filesystem/path operations through the ownership runtime import graph', () => {
    const entry = fileURLToPath(new URL('../directory-ownership.ts', import.meta.url));
    const pending = [entry];
    const seen = new Set<string>();
    const violations: string[] = [];
    while (pending.length > 0 && violations.length === 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
      const record = (name: string) => {
        if (name === 'node:fs' || name === 'node:path') return;
        if (name.startsWith('.'))
          pending.push(resolve(dirname(file), name.replace(/\.js$/, '.ts')));
        else violations.push(`${file}: ${name}`);
      };
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) record(argument.text);
          else violations.push(`${file}: nonliteral module load`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        record(specifier.text);
      }
    }
    expect(violations).toEqual([]);
  });
});
