/**
 * The error-shape lint (`eslint-rules/problem-only.js`, ADR 261123-170831): no hand-built
 * `{ error }` body in the HTTP layer, so every failure goes out through `problem()`. Linted
 * with the package's real config, so a rule left unwired fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** How many times the rule fires on `code` linted as if it were the file at `path`. */
async function errorBodies(path: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result.messages.filter((message) => message.ruleId === 'problem-only/no-error-body')
    .length;
}

const OLD_SHAPES = [
  'declare const c: { json(body: unknown, status?: number): Response };',
  'declare const res: { status(n: number): { json(body: unknown): void } };',
  "export const a = () => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);",
  "export const b = () => c.json({ 'error': 'Bad' }, 400);",
  "export const d = () => res.status(500).json({ error: 'Failed' });",
].join('\n');

describe('the problem-only lint', () => {
  it('refuses a `{ error }` body in routes, the API chain and middleware', async () => {
    // Purpose: fails if a route could again answer a failure in the old shape.
    for (const path of [
      'src/routes/example.ts',
      'src/http/example.ts',
      'src/middleware/example.ts',
    ])
      expect(await errorBodies(path, OLD_SHAPES)).toBe(3);
  });

  it('refuses a module-level const body with an `error` member, as the spaces gate had', async () => {
    // Purpose: fails if `c.json(SPACES_DISABLED_BODY, 404)` could slip past again.
    const named = [
      'declare const c: { json(body: unknown, status?: number): Response };',
      "const DISABLED_BODY = { error: 'Off.', code: 'OFF' } as const;",
      "const FINE = { ok: true, code: 'x' };",
      'export const a = () => c.json(DISABLED_BODY, 404);',
      'export const b = () => c.json(FINE);',
      'export function d() {',
      "  const local = { error: 'not module level' };",
      '  return c.json(local);',
      '}',
    ].join('\n');
    expect(await errorBodies('src/middleware/example.ts', named)).toBe(1);
  });

  it('leaves problems, successes and other folders alone', async () => {
    const fine = [
      'declare const c: { json(body: unknown, status?: number): Response };',
      'declare const errors: unknown[];',
      'export const a = () => c.json({ ok: true, errors });',
      'export const b = () => c.json({ code: "not_found", detail: "Gone." }, 404);',
    ].join('\n');
    expect(await errorBodies('src/routes/example.ts', fine)).toBe(0);
    expect(await errorBodies('src/services/example.ts', OLD_SHAPES)).toBe(0);
  });
});
