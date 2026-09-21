/** @vitest-environment node */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  expectSanitizedProviderFixture,
  mutateTrustedProviderFields,
} from './provider-contract-harness.js';

describe('provider contract fixture harness', () => {
  it('mutates every trusted field through removal, rename, type, and control cases', () => {
    const fixture = { id: 'resource_01', options: { public: false } };
    const mutations = mutateTrustedProviderFields(fixture, [['id'], ['options', 'public']]);
    expect(mutations.map(({ label }) => label)).toEqual([
      'remove id',
      'rename id',
      'change type id',
      'inject control id',
      'remove options.public',
      'rename options.public',
      'change type options.public',
    ]);
    expect(fixture).toEqual({ id: 'resource_01', options: { public: false } });
  });

  it.each([
    ['credential key', { password: 'value' }],
    ['secret URL', { value: 'postgresql://role:value@example.test/database' }],
    ['terminal control', { value: 'safe\u001b[2J' }],
  ])('rejects %s in a checked-in fixture', (_label, fixture) => {
    expect(() => expectSanitizedProviderFixture(fixture, 'fixture')).toThrow();
  });

  it('keeps every checked-in provider fixture free of credential shapes and controls', async () => {
    const root = new URL('./fixtures/', import.meta.url);
    for (const service of await readdir(root)) {
      const directory = new URL(`${service}/`, root);
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json')) continue;
        const url = new URL(name, directory);
        expectSanitizedProviderFixture(JSON.parse(await readFile(url, 'utf8')), fileURLToPath(url));
      }
    }
  });
});
