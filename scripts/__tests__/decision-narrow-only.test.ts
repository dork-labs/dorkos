/**
 * "A decision can only narrow, never widen" (spec `official-community-space`
 * D15; research `20261006_decision-models.md` §5e).
 *
 * A decision model's answer may hide, hold, tag or suggest. It must never reach
 * a permission check, an approval, or the gate that decides whether an agent may
 * use a tool — otherwise a stranger who talks a model into a confident answer
 * gets power a stranger would not otherwise have.
 *
 * The port's types carry nothing a permission API could accept as a grant, but a
 * type cannot stop somebody wiring a `DecisionResult` into an `if` inside a
 * permission module. This file does, by source:
 *
 * 1. no permission, approval, auth or tool-gate module imports the decision
 *    port or its bridges, and no module that does mentions `canUseTool`;
 * 2. the bridges themselves import nothing but the port, Node built-ins and
 *    each other, so the dependency cannot run the other way either.
 *
 * Tests are excluded: a test may well put a fake decision next to a fake gate.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Paths that hold a permission, approval, auth or tool-use decision. */
const GATE_PATH =
  /(permission|approval|tool-gate|tool-tier|tool-exposure|mcp-auth|access-level|authoriz)|(^|\/)auth(\/|\.tsx?$)/i;

/** Text that marks a module as one that decides whether a tool may run. */
const GATE_TEXT = /\bcanUseTool\b/;

/** An import of the decision port or its bridges, by package or by relative path. */
const DECISION_IMPORT =
  /from\s+['"](@dorkos\/decisions|@dorkos\/shared\/decision-model|[./]+[^'"]*decision-model(\.js)?)['"]/;

/** Every non-test TypeScript source file under apps/*\/src and packages/*\/src. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '__tests__', '.turbo'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const top of ['apps', 'packages']) {
    for (const pkg of readdirSync(path.join(repoRoot, top), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = path.join(repoRoot, top, pkg.name, 'src');
      try {
        walk(src);
      } catch {
        // No src/ in this package.
      }
    }
  }
  return out;
}

/** Why `file` (repo-relative) with `text` breaks the rule, or undefined. */
function violation(file: string, text: string): string | undefined {
  if (!DECISION_IMPORT.test(text)) return undefined;
  if (GATE_PATH.test(file))
    return `${file}: a permission, approval, auth or tool gate imports the decision port`;
  if (GATE_TEXT.test(text))
    return `${file}: imports the decision port and decides whether a tool may run`;
  return undefined;
}

describe('decisions only narrow', () => {
  it('flags the shapes it exists to catch (positive control)', () => {
    const imp = "import { runLadder } from '@dorkos/decisions';";
    expect(violation('apps/server/src/services/core/permissions/check.ts', imp)).toBeDefined();
    expect(violation('apps/server/src/services/core/mcp-tool-gate.ts', imp)).toBeDefined();
    expect(violation('apps/community/src/auth.ts', imp)).toBeDefined();
    expect(violation('apps/server/src/x.ts', `${imp}\nconst canUseTool = 1;`)).toBeDefined();
    expect(
      violation(
        'apps/server/src/services/core/approvals/a.ts',
        "import type { DecisionResult } from '../decision-model.js';"
      )
    ).toBeDefined();
    expect(violation('apps/community/src/moderation/spam.ts', imp)).toBeUndefined();
    expect(
      violation('apps/server/src/services/core/permissions/check.ts', 'export {}')
    ).toBeUndefined();
  });

  it('no permission, approval, auth or tool gate reads a decision', () => {
    const found = sourceFiles()
      .map((f) => violation(path.relative(repoRoot, f), readFileSync(f, 'utf8')))
      .filter((v): v is string => v !== undefined);
    expect(found).toEqual([]);
  });

  it('the bridges import nothing but the port, Node built-ins and each other', () => {
    const dir = path.join(repoRoot, 'packages/decisions/src');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        const allowed =
          spec === '@dorkos/shared/decision-model' ||
          spec.startsWith('node:') ||
          spec.startsWith('./');
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
