import { expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
it('imports and constructs without reading vendor credentials or making network calls', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('Network forbidden');
  });
  const { SqliteModelStore } = await import('../index.js');
  const store = new SqliteModelStore(':memory:');
  store.createSession('offline');
  store.close();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
it('pins audited upstream APIs and publishes built standalone exports', () => {
  const root = join(import.meta.dirname, '../..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(manifest.dependencies['@earendil-works/pi-agent-core']).toBe('1.0.4');
  expect(manifest.dependencies['@earendil-works/pi-ai']).toBe('1.0.4');
  expect(manifest.dependencies.typebox).toBe('1.3.27');
  expect(manifest.exports['.'].types).toBe('./dist/index.d.ts');
  expect(manifest.exports['.'].import).toBe('./dist/index.js');
  for (const file of readdirSync(join(root, 'src')).filter((x) => x.endsWith('.ts')))
    expect(readFileSync(join(root, 'src', file), 'utf8')).not.toMatch(
      /from ['"]@(?:dorkos|dork-labs)\//
    );
  const core = readFileSync(
    join(root, 'node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts'),
    'utf8'
  );
  expect(core).toContain('streamFn: StreamFn');
  expect(core).toContain('prepareRequest?: PrepareRequest');
  expect(core).toContain('finishTurn?: FinishTurn');
});
