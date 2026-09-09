import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCodexAppServerVersion,
  readCodexModelContextWindows,
} from '../model-context-windows.js';

const NOW = Date.parse('2026-09-08T22:04:00.000Z');
const homes: string[] = [];

async function writeCache(value: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dorkos-codex-models-'));
  homes.push(home);
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify(value));
  return home;
}

function cache(overrides: Record<string, unknown> = {}) {
  return {
    fetched_at: '2026-09-08T22:03:42.123Z',
    client_version: '0.153.4',
    models: [
      {
        slug: 'gpt-6-astra',
        context_window: 272_000,
        effective_context_window_percent: 95,
      },
      {
        slug: 'gpt-5.3-codex-spark',
        context_window: 128_000,
        effective_context_window_percent: 95,
      },
    ],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('parseCodexAppServerVersion', () => {
  it.each([
    ['DorkOS', 'dorkos/0.145.0 (Mac OS 26.6.2; arm64) unknown (dorkos; 0.0.0)', '0.145.0'],
    [
      'Codex Desktop',
      'Codex Desktop/0.153.4 (Mac OS 26.6.2; arm64) dumb (dorkos; 0.0.0)',
      '0.153.4',
    ],
    ['Codex CLI', 'codex_cli_rs/0.153.4 (Mac OS 26.6.2; arm64)', '0.153.4'],
  ])('extracts the app-server version for %s clients', (_name, userAgent, version) => {
    expect(parseCodexAppServerVersion(userAgent)).toBe(version);
  });

  it.each([
    'missing-version',
    '/0.153.4 (missing client)',
    'dorkos/153.4 (invalid version)',
    `${'a'.repeat(65)}/0.153.4 (unbounded client name)`,
  ])('declines unknown user-agent format %s', (userAgent) => {
    expect(parseCodexAppServerVersion(userAgent)).toBeNull();
  });
});

describe('readCodexModelContextWindows', () => {
  it('derives the same effective windows emitted by native Codex rollouts', async () => {
    const codexHome = await writeCache(cache());

    const windows = await readCodexModelContextWindows({
      codexHome,
      clientVersion: '0.153.4',
      now: NOW,
    });

    expect(Object.fromEntries(windows)).toEqual({
      'gpt-6-astra': 258_400,
      'gpt-5.3-codex-spark': 121_600,
    });
  });

  it.each([
    ['another client version', cache({ client_version: '0.152.0' })],
    ['a stale fetch', cache({ fetched_at: '2026-09-08T21:00:00.000Z' })],
    ['a future fetch', cache({ fetched_at: '2026-09-08T22:06:00.000Z' })],
    ['malformed metadata', cache({ models: [{ slug: 'gpt-6-astra', context_window: -1 }] })],
  ])('ignores %s', async (_name, value) => {
    const codexHome = await writeCache(value);

    await expect(
      readCodexModelContextWindows({ codexHome, clientVersion: '0.153.4', now: NOW })
    ).resolves.toEqual(new Map());
  });

  it('refuses a cache larger than the read bound', async () => {
    const codexHome = await writeCache(cache());

    await expect(
      readCodexModelContextWindows({
        codexHome,
        clientVersion: '0.153.4',
        now: NOW,
        maxBytes: 20,
      })
    ).resolves.toEqual(new Map());
  });

  it('treats a missing cache as optional metadata', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'dorkos-codex-models-'));
    homes.push(codexHome);

    await expect(
      readCodexModelContextWindows({ codexHome, clientVersion: '0.153.4', now: NOW })
    ).resolves.toEqual(new Map());
  });
});
