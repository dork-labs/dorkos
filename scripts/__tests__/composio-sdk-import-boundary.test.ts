import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// The first case shells out to `git ls-files` and then reads all ~7,100 tracked
// source files synchronously, which is a whole-repo scan inside vitest's 5s
// default. It peaked at 2.67s across three rounds at a load average of 300-405
// with a warm page cache, and was reported over 5s on the run that filed
// DOR-1886 — under 5s, so 15s rather than 30s. That is ~5.6x the measured peak:
// room for the tree to roughly quintuple, or for a cold page cache on a fresh CI
// checkout, and no more. There is no hook here to budget. The scan itself never
// shrinks to fit — if this file ever needs more than 15s, the scan is what
// should change.
vi.setConfig({ testTimeout: 15_000 });

const ALLOWED_COMPOSIO_SDK_ROOTS = ['packages/connector-providers/src/composio/'] as const;

/** Return whether a source path is one of the deliberately narrow SDK adapters. */
function isAllowedComposioSdkPath(path: string): boolean {
  return ALLOWED_COMPOSIO_SDK_ROOTS.some(
    (root) => path === root || (root.endsWith('/') && path.startsWith(root))
  );
}

/** Detect direct static, dynamic, re-export, and CommonJS imports of one package. */
function importsComposioSdk(source: string): boolean {
  const packageName = ['@composio', 'core'].join('/');
  return new RegExp(
    String.raw`(?:from\s*|import\s*\(|require\s*\()\s*['"]${packageName.replace('/', '\\/')}['"]`
  ).test(source);
}

describe('Composio SDK import boundary', () => {
  it('confines every repository import to the provider adapter roots', () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.mjs',
        '*.cjs',
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((path) => path.length > 0 && existsSync(path));
    expect(files.length).toBeGreaterThan(100);

    const violations = files.filter(
      (path) => importsComposioSdk(readFileSync(path, 'utf8')) && !isAllowedComposioSdkPath(path)
    );
    expect(violations).toEqual([]);
  });

  it('fails for the same SDK import moved outside an allowed adapter root', () => {
    const packageName = ['@composio', 'core'].join('/');
    const mutatedSource = `import { Composio } from '${packageName}';`;

    expect(importsComposioSdk(mutatedSource)).toBe(true);
    expect(isAllowedComposioSdkPath('apps/server/src/routes/connectors.ts')).toBe(false);
  });
});
