import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../broker/', import.meta.url));

it('keeps the tab broker independent of server code and runtime dependencies', () => {
  const files = readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts') && !name.includes('__tests__'));
  expect(files.length).toBeGreaterThan(0);
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const check = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        const local =
          specifier.startsWith('.') &&
          !path.relative(root, path.resolve(root, path.dirname(file), specifier)).startsWith('..');
        const builtIn =
          specifier.startsWith('node:') && builtinModules.includes(specifier.slice(5));
        const pageTypes =
          specifier === 'playwright-core' &&
          ts.isImportDeclaration(node) &&
          node.importClause?.isTypeOnly;
        if (!local && !builtIn && !pageTypes) violations.push(`${file}: ${specifier}`);
      }
      // Dynamic import and require would defeat a guard checking static imports alone.
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        violations.push(`${file}: dynamic module load`);
      }
      ts.forEachChild(node, check);
    };
    check(source);
  }
  expect(violations).toEqual([]);
});
