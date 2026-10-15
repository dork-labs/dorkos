/** Keep local proof output outside root lint without exempting maintained source. */
import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: repoRoot });

describe('the local browser proof output lint boundary', () => {
  it.each([
    ['.dork/local-browser/generated-proof.cjs', true],
    ['scripts/local-browser/native-consent-proof.ts', false],
    ['.dork/future-source/maintained.ts', false],
    ['.dork/local-browser-sibling/maintained.ts', false],
  ] as const)('%s has ignored=%s', async (file, ignored) => {
    expect(await eslint.isPathIgnored(path.join(repoRoot, file))).toBe(ignored);
  });
});
