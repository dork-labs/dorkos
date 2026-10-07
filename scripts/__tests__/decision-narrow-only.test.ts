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
 * permission module. This file does, by source, as an ALLOWLIST rather than a
 * list of gate paths: a deny list only catches the gate modules somebody thought
 * to name, and a new one would slip past it. Only the places below may import
 * the decision port, its bridges or its conformance suite. Anywhere else fails,
 * and widening the list is a reviewed edit to this file.
 *
 * The second half pins the other direction: the bridges import nothing but the
 * port, Node built-ins and each other.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The full-tree scan reads every source file under apps/ and packages/; on a
// loaded machine that outruns the 5s default (same budget as the sibling
// import-boundary tests).
vi.setConfig({ testTimeout: 15_000 });

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * The only places that may import the decision port or its bridges
 * (repo-relative, `/`-separated). Each is a decision consumer that can only
 * record, tag, hide or hold — never a permission, approval, auth or tool gate.
 */
const ALLOWED: readonly RegExp[] = [
  // The bridges and the ladder.
  /^packages\/decisions\//,
  // The port itself, and its schema tests.
  /^packages\/shared\/src\/decision-model\.ts$/,
  /^packages\/shared\/src\/__tests__\/decision-model\.test\.ts$/,
  // The shared conformance suite.
  /^packages\/test-utils\/src\/decision-model-conformance\.ts$/,
  // The DorkOS server's decision service domain (research §5g).
  /^apps\/server\/src\/services\/decisions\//,
  // The Community app's own ladder: its decisions dir and moderation code.
  /^apps\/community\/src\/decisions\//,
  /^apps\/community\/src\/(.+\/)?moderation\//,
];

/** An import (static, dynamic or re-export) of the decision port, its bridges or its conformance suite. */
const DECISION_IMPORT =
  /(?:from|import\s*\()\s*['"](?:@dorkos\/decisions(?:\/[^'"]*)?|@dorkos\/shared\/decision-model|@dorkos\/test-utils\/decision-model-conformance|\.{1,2}\/[^'"]*decision-model(?:-conformance)?(?:\.js)?)['"]/;

/** Every TypeScript source file under apps/*\/src and packages/*\/src, tests included. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.turbo'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c|m)?tsx?$/.test(entry.name)) out.push(full);
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
  if (ALLOWED.some((re) => re.test(file))) return undefined;
  return `${file}: imports the decision port outside the allowlist`;
}

describe('decisions only narrow', () => {
  it('flags an import anywhere outside the allowlist (positive control)', () => {
    const imp = "import { runLadder } from '@dorkos/decisions';";
    expect(violation('apps/server/src/services/core/permissions/check.ts', imp)).toBeDefined();
    expect(violation('apps/server/src/services/core/mcp-tool-gate.ts', imp)).toBeDefined();
    expect(violation('apps/community/src/auth.ts', imp)).toBeDefined();
    expect(violation('apps/server/src/services/rooms/room-service.ts', imp)).toBeDefined();
    expect(
      violation(
        'packages/shared/src/permissions/tiers.ts',
        "import type { DecisionResult } from '../decision-model.js';"
      )
    ).toBeDefined();
    expect(
      violation('apps/server/src/x.ts', "const m = await import('@dorkos/shared/decision-model');")
    ).toBeDefined();
    expect(
      violation('apps/server/src/x.ts', "export { runLadder } from '@dorkos/decisions';")
    ).toBeDefined();
    expect(
      violation(
        'packages/test-utils/src/fake-memory-provider.ts',
        "import x from './decision-model-conformance.js';"
      )
    ).toBeDefined();
  });

  it('allows the listed consumers and ignores files that do not import the port', () => {
    const imp = "import { runLadder } from '@dorkos/decisions';";
    expect(violation('apps/community/src/moderation/spam.ts', imp)).toBeUndefined();
    expect(violation('apps/community/src/content/moderation/hint.ts', imp)).toBeUndefined();
    expect(violation('apps/community/src/decisions/ladder-run.ts', imp)).toBeUndefined();
    expect(violation('apps/server/src/services/decisions/service.ts', imp)).toBeUndefined();
    expect(violation('packages/decisions/src/ladder.ts', imp)).toBeUndefined();
    expect(
      violation('apps/server/src/services/core/permissions/check.ts', 'export {}')
    ).toBeUndefined();
  });

  it('nothing outside the allowlist imports a decision', () => {
    const found = sourceFiles()
      .map((f) =>
        violation(path.relative(repoRoot, f).split(path.sep).join('/'), readFileSync(f, 'utf8'))
      )
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
