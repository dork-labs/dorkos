import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PUBLIC_ERROR_SOURCES = [
  'apps/server/src/routes/connector-resources.ts',
  'apps/server/src/routes/connector-providers.ts',
  'apps/server/src/routes/connector-execution.ts',
  'apps/server/src/services/connectors/management-review-service.ts',
  'apps/server/src/services/connectors/management-action-service.ts',
  'apps/server/src/services/connectors/resources/authentication-flow-service.ts',
  'apps/server/src/services/connectors/resources/lifecycle-service.ts',
  'apps/server/src/services/connectors/resources/operator-query-service.ts',
  'apps/server/src/services/connectors/execution/access-query-service.ts',
] as const;

const COPY_PROPERTIES = new Set(['error', 'message', 'reason']);
const RETIRED_CONNECTION_NOUNS = [
  'integration',
  'integrations',
  'connector',
  'connectors',
  'adapter',
  'adapters',
  'provider',
  'providers',
] as const;

interface CopyLiteral {
  readonly line: number;
  readonly text: string;
}

/** Return a static string from an expression when it can be shown without interpolation. */
function staticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Read error-shaped strings that can cross a public route or typed service boundary. */
function publicErrorCopy(path: string, source: string): CopyLiteral[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: CopyLiteral[] = [];
  const add = (node: ts.Expression) => {
    const text = staticString(node);
    if (text === undefined) return;
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (name && COPY_PROPERTIES.has(name)) add(node.initializer);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^Connector\w*Error$/.test(node.expression.text)
    ) {
      for (const argument of node.arguments ?? []) add(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Find a retired architecture noun when it appears as an ordinary word. */
function retiredNoun(text: string): string | undefined {
  return RETIRED_CONNECTION_NOUNS.find((term) =>
    new RegExp(`(^|[^\\w])${term}($|[^\\w])`, 'i').test(text)
  );
}

describe('public Connections error copy', () => {
  it('uses product language across every active owner and program boundary', () => {
    expect(PUBLIC_ERROR_SOURCES).toHaveLength(9);
    const copy = PUBLIC_ERROR_SOURCES.flatMap((path) =>
      publicErrorCopy(path, readFileSync(path, 'utf8')).map((literal) => ({ path, ...literal }))
    );
    expect(copy.length).toBeGreaterThan(30);

    const violations = copy.flatMap(({ path, line, text }) => {
      const term = retiredNoun(text);
      return term ? [`${path}:${line}: ${term}: ${text}`] : [];
    });
    expect(violations).toEqual([]);
  });

  it('rejects retired architecture nouns but keeps connection and service language', () => {
    expect(retiredNoun('Connector request failed.')).toBe('connector');
    expect(retiredNoun('Choose another provider.')).toBe('provider');
    expect(retiredNoun('Connection not found.')).toBeUndefined();
    expect(retiredNoun('Try this service again.')).toBeUndefined();
  });
});
