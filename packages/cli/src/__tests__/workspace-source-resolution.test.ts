import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { dorkosSourcePlugin } from '../../scripts/build.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('workspace bundle source resolution', () => {
  it.each(['default', 'import', 'default-with-import'] as const)(
    'bundles published %s exports from source without compiled files',
    async (condition) => {
      const root = await mkdtemp(join(tmpdir(), 'dorkos-source-export-'));
      temporary.push(root);
      const directory = join(root, 'packages/doe');
      await mkdir(join(directory, 'src'), { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: '@dorkos/doe',
          type: 'module',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              ...(condition === 'default-with-import'
                ? { default: './dist/index.js', import: './dist/absent.js' }
                : { [condition]: './dist/index.js' }),
            },
          },
        })
      );
      await writeFile(join(directory, 'src/index.ts'), 'export const vintage = "fresh-source";');
      const result = await build({
        absWorkingDir: root,
        stdin: { contents: 'export { vintage } from "@dorkos/doe";', resolveDir: root },
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        metafile: true,
        plugins: [dorkosSourcePlugin(root)],
      });
      expect(result.outputFiles[0].text).toContain('fresh-source');
      expect(
        Object.keys(result.metafile!.inputs).some((file) =>
          file.endsWith('packages/doe/src/index.ts')
        )
      ).toBe(true);
      expect(Object.keys(result.metafile!.inputs).some((file) => file.includes('/dist/'))).toBe(
        false
      );
    }
  );
});
