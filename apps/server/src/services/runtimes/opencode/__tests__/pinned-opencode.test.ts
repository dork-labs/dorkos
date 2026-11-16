/**
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events';
import type { spawn, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_PIN,
  pinnedOpenCode,
  withUnchangedBinary,
  guardedOpenCodeSpawn,
} from './pinned-opencode.js';

type Manifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** The server package's manifest, which pins the SDK. */
const serverPackage = JSON.parse(
  fs.readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')
) as Manifest;

/** The test-utils manifest, which installs the binary (test-only, so it never ships). */
const testUtilsPackage = JSON.parse(
  fs.readFileSync(
    new URL('../../../../../../../packages/test-utils/package.json', import.meta.url),
    'utf8'
  )
) as Manifest;

/** The `opencode-*` entries in a manifest's optional dependencies. */
function openCodePins(manifest: Manifest): [string, string][] {
  return Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith('opencode-')
  );
}

const HERE = `${process.platform}-${process.arch}`;

describe('the pinned OpenCode binary', () => {
  // On the server it would ship, and the desktop build would read the server
  // as a per-platform package and refuse to bundle it.
  it('is never a dependency of the server itself', () => {
    expect(openCodePins(serverPackage)).toEqual([]);
  });

  it('installs every pinned platform at exactly the pinned version, and nothing else', () => {
    const installed = openCodePins(testUtilsPackage);
    expect(Object.fromEntries(installed)).toEqual(
      Object.fromEntries(
        Object.keys(OPENCODE_PIN.sha256).map((key) => [`opencode-${key}`, OPENCODE_PIN.version])
      )
    );
  });

  it('pins the CLI to the SDK’s version', () => {
    expect(serverPackage.dependencies?.['@opencode-ai/sdk']).toBe(`^${OPENCODE_PIN.version}`);
  });

  it('has nothing to run on a platform with no recorded hash', () => {
    expect(pinnedOpenCode('plan9', 'mips')).toBeNull();
  });

  // The real-binary tests skip where nothing is pinned. CI must never be such a
  // place, or they would stop running there without anyone noticing.
  it.runIf(process.env.CI)('finds a pinned binary on the CI runner', () => {
    expect(OPENCODE_PIN.sha256[HERE], `no OpenCode pin for ${HERE}`).toBeDefined();
    expect(pinnedOpenCode()).not.toBeNull();
  });

  it.skipIf(!OPENCODE_PIN.sha256[HERE])('hands back only a file whose bytes match the pin', () => {
    const binary = pinnedOpenCode()!;
    const actual = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    expect(actual).toBe(OPENCODE_PIN.sha256[HERE]);
  });
});

describe('fresh binary integrity checks', () => {
  async function fixture(run: (file: string, hash: string) => Promise<void>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-integrity-'));
    const file = path.join(root, 'binary');
    fs.writeFileSync(file, 'original executable bytes');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    try {
      await run(file, hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('returns the result when the binary is unchanged', async () => {
    await fixture(async (file, hash) => {
      await expect(withUnchangedBinary(file, hash, async () => 42)).resolves.toBe(42);
    });
  });

  it.each([false, true])('refuses post-run mutation even when the run fails: %s', async (fails) => {
    await fixture(async (file, hash) => {
      await expect(
        withUnchangedBinary(file, hash, async () => {
          fs.writeFileSync(file, 'changed executable bytes');
          if (fails) throw new Error('run failed');
        })
      ).rejects.toThrow('does not match its pinned SHA-256');
    });
  });

  it('refuses changed bytes before a subsequent run starts', async () => {
    await fixture(async (file, hash) => {
      await withUnchangedBinary(file, hash, async () => undefined);
      fs.writeFileSync(file, 'changed between runs');
      let started = false;
      await expect(
        withUnchangedBinary(file, hash, async () => {
          started = true;
        })
      ).rejects.toThrow('does not match its pinned SHA-256');
      expect(started).toBe(false);
    });
  });

  it('preserves an operation failure when the binary is unchanged', async () => {
    await fixture(async (file, hash) => {
      await expect(
        withUnchangedBinary(file, hash, async () => {
          throw new Error('run failed');
        })
      ).rejects.toThrow('run failed');
    });
  });
});

it.skipIf(!OPENCODE_PIN.sha256[HERE])(
  'every guarded spawn overrides self-update settings while preserving config',
  async () => {
    const child = new EventEmitter();
    const spawnBinary = vi.fn(() => child);
    const result = guardedOpenCodeSpawn(
      spawnBinary as unknown as typeof spawn,
      pinnedOpenCode()!,
      ['serve'],
      {
        env: {
          OPENCODE_DISABLE_AUTOUPDATE: '0',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: true, model: 'fake/x' }),
        },
      }
    );
    const options = spawnBinary.mock.calls[0] as unknown as [string, string[], SpawnOptions];
    expect(options[2].env?.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(JSON.parse(String(options[2].env?.OPENCODE_CONFIG_CONTENT))).toEqual({
      autoupdate: false,
      model: 'fake/x',
    });
    child.emit('close');
    await expect(result.verified).resolves.toBeUndefined();
  }
);
