import { resolve } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: resolve(__dirname, '..') });

/** Exercise the shipped configuration so disabling or narrowing the rule cannot pass silently. */
async function errors(code: string, filePath = 'src/layers/features/example/ui/Example.tsx') {
  const [result] = await eslint.lintText(code, { filePath });
  expect(result.messages.some((message) => message.message.includes('File ignored'))).toBe(false);
  return result.messages.filter((message) => message.ruleId === 'routes/no-hardcoded-route');
}

describe('route factories at navigation boundaries', () => {
  it('loads in a clean source checkout before shared packages are built', () => {
    const checkout = mkdtempSync(resolve(tmpdir(), 'route-lint-source-'));
    try {
      writeFileSync(resolve(checkout, 'package.json'), '{"type":"module"}');
      mkdirSync(resolve(checkout, 'apps/client/eslint-rules'), { recursive: true });
      mkdirSync(resolve(checkout, 'packages/shared/src'), { recursive: true });
      cpSync(
        resolve(__dirname, '../eslint-rules/routes.js'),
        resolve(checkout, 'apps/client/eslint-rules/routes.js')
      );
      cpSync(
        resolve(__dirname, '../../../packages/shared/src/app-route-paths.ts'),
        resolve(checkout, 'packages/shared/src/app-route-paths.ts')
      );
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', "await import('./apps/client/eslint-rules/routes.js')"],
        { cwd: checkout, encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it.each([
    "navigate({ to: '/team' });",
    "const target = '/team'; navigate({ to: target });",
    "const target = '/team'; const next = target; navigate({ to: next });",
    "navigate({ to: '/x/flow/p/project' });",
    "const target = { href: '/session?session=abc' };",
    'const link = <Link to="/connections" />;',
    'const link = <a href={`/team?agent=${id}`} />;',
  ])(
    'rejects a hardcoded destination: %s',
    async (code) => {
      expect(await errors(code)).toHaveLength(1);
    },
    20_000
  );

  it.each([
    'navigate({ ...appRoutes.team(), search: { agent: id } });',
    "const request = { href: '/api/sessions' };",
    'const external = <a href="https://example.com/team" />;',
    "const path = '/team'; // descriptive data, not navigation",
  ])(
    'allows factories and other URL contracts: %s',
    async (code) => {
      expect(await errors(code)).toEqual([]);
    },
    20_000
  );

  it('allows route declarations and test expectations', async () => {
    expect(await errors("const route = { to: '/team' };", 'src/routes/_shell/team.tsx')).toEqual(
      []
    );
    expect(
      await errors("expect(target).toEqual({ to: '/team' });", 'src/__tests__/route.test.ts')
    ).toEqual([]);
  }, 20_000);
});
