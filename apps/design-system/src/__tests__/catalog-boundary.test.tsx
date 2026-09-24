import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = readFileSync(resolve(src, 'Catalog.tsx'), 'utf8');
const main = readFileSync(resolve(src, 'main.tsx'), 'utf8');

describe('catalog ownership boundary', () => {
  // A static replica can look fine while shipping a second implementation.
  it('imports production controls and never defines copies of them', () => {
    expect(catalog).toMatch(/from '@dork-labs\/ui'/);
    expect(catalog).not.toMatch(/function (Button|Input|Field|Notice)\b/);
  });

  // The catalog must remain runnable without a DorkOS application shell.
  it('has no client transport, router, app store or backend import', () => {
    for (const source of [catalog, main]) {
      expect(source).not.toMatch(
        /from ['"](?:@\/|@dorkos\/client|.*(?:transport|router|store|server))/i
      );
    }
  });
});
