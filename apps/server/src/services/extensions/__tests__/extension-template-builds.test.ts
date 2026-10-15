/**
 * The data-provider template's server half builds and serves (DOR-2858):
 * what `create_extension` writes, compiled by the real compiler from a folder
 * with nothing installed, loaded the way DorkOS loads it, and asked through
 * its fetch handler. A template that teaches a shape DorkOS cannot build is
 * the first thing an agent copies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { readRegisterResult, serverEntryStart } from '@dorkos/extension-api/server';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ExtensionCompiler } from '../extension-compiler.js';
import { generateServerTemplate } from '../extension-templates.js';
import { loadInProcessBundle } from '../server-bundle/load-in-process.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'template-builds-')));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('the data-provider server template', () => {
  it('builds with nothing installed, serves /data, and keeps writes to people', async () => {
    const dir = path.join(tmp, 'extensions', 'weather');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'server.ts'), generateServerTemplate('weather', ''));
    const record = {
      id: 'weather',
      manifest: { id: 'weather', name: 'Weather', version: '1.0.0' },
      status: 'enabled',
      scope: 'global',
      origin: 'user',
      path: dir,
      bundleReady: false,
      hasServerEntry: true,
      hasDataProxy: false,
      serverEntryPath: path.join(dir, 'server.ts'),
    } as ExtensionRecord;

    const compiled = await new ExtensionCompiler(path.join(tmp, 'dork')).compileServer(record);
    if ('error' in compiled) throw new Error(JSON.stringify(compiled.error));
    const bundle = path.join(tmp, 'weather.js');
    await fs.writeFile(bundle, compiled.code);

    let stored: unknown = ['sunny'];
    const ctx = {
      storage: {
        loadData: async () => stored,
        saveData: async (data: unknown) => {
          stored = data;
        },
      },
      secrets: { get: async () => null },
      schedule: vi.fn(() => () => undefined),
      emit: vi.fn(),
    };
    const start = serverEntryStart(loadInProcessBundle(bundle))!;
    const { fetch, cleanup } = readRegisterResult(await start(ctx as never));
    const person = { person: { ok: true } } as const;
    const agent = {
      person: {
        ok: false,
        status: 403,
        body: { error: 'No.', code: 'extension_person_required', message: 'No.' },
      },
    } as const;

    const read = await fetch!(new Request('http://x/data'), person);
    const refused = await fetch!(
      new Request('http://x/data', { method: 'PUT', body: '["rain"]' }),
      agent
    );
    const saved = await fetch!(
      new Request('http://x/data', { method: 'PUT', body: '["rain"]' }),
      person
    );

    const garbled = await fetch!(
      new Request('http://x/data', { method: 'PUT', body: '{not json' }),
      person
    );

    expect(await read.json()).toEqual({ data: ['sunny'] });
    expect(garbled.status).toBe(400);
    expect(refused.status).toBe(403);
    expect(saved.status).toBe(200);
    expect(stored).toEqual(['rain']);
    expect(cleanup).toBeTypeOf('function');
  });
});
