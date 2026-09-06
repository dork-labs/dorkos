import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ALLOWED_COMPOSIO_SDK_ROOTS = [
  'apps/server/src/services/connectors/providers/composio/',
  'apps/site/src/lib/connectors/composio/',
] as const;

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
      .filter(Boolean);
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
