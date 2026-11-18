import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// CI runs main's copy of scripts/release-branch/ out of a temp folder, with no
// install (DOR-4639), so the folder may import only itself and node: builtins.
const dir = fileURLToPath(new URL('../../scripts/release-branch/', import.meta.url));

it('scripts/release-branch imports only its own files and node: builtins', async () => {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = await readFile(dir + file, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'/g)].map(
      (match) => match[1] ?? match[2]
    );
    for (const spec of specifiers)
      expect(spec, `${file} imports ${spec}`).toMatch(/^(node:[a-z/_]+|\.\/[a-z-]+\.ts)$/);
  }
});
