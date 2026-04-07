import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePersonalMarketplace,
  personalMarketplaceRoot,
  PERSONAL_MARKETPLACE_NAME,
} from '../personal-marketplace.js';
import type { MarketplaceSourceManager } from '../../marketplace/marketplace-source-manager.js';
import type { MarketplaceSource } from '../../marketplace/types.js';
import type { Logger } from '@dorkos/shared/logger';

/** Build a noop logger so info/error calls are silent in tests. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a stub MarketplaceSourceManager backed by an in-memory map.
 * Only the `get()` and `add()` methods are exercised by
 * `ensurePersonalMarketplace`, so the stub satisfies just those two.
 */
function buildSourceManagerStub(initial: MarketplaceSource[] = []) {
  const sources = new Map<string, MarketplaceSource>();
  for (const source of initial) {
    sources.set(source.name, source);
  }

  const get = vi.fn(async (name: string) => sources.get(name) ?? null);
  const add = vi.fn(async (input: { name: string; source: string; enabled?: boolean }) => {
    if (sources.has(input.name)) {
      throw new Error(`Marketplace source '${input.name}' already exists`);
    }
    const created: MarketplaceSource = {
      name: input.name,
      source: input.source,
      enabled: input.enabled ?? true,
      addedAt: new Date().toISOString(),
    };
    sources.set(created.name, created);
    return created;
  });

  // Cast through unknown — we only implement the surface area used by
  // ensurePersonalMarketplace. Adding methods to the real class will not
  // break this stub because the field-typed cast is intentional.
  const stub = { get, add } as unknown as MarketplaceSourceManager;
  return { stub, get, add, sources };
}

describe('personalMarketplaceRoot', () => {
  it('returns `${dorkHome}/personal-marketplace`', () => {
    expect(personalMarketplaceRoot('/tmp/dork-home')).toBe(
      join('/tmp/dork-home', 'personal-marketplace')
    );
  });
});

describe('PERSONAL_MARKETPLACE_NAME', () => {
  it('is the literal string "personal"', () => {
    expect(PERSONAL_MARKETPLACE_NAME).toBe('personal');
  });
});

describe('ensurePersonalMarketplace', () => {
  let dorkHome: string;
  let logger: Logger;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'personal-marketplace-'));
    logger = buildLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('creates the directory tree on first call', async () => {
    const { stub } = buildSourceManagerStub();

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    const root = personalMarketplaceRoot(dorkHome);
    await expect(access(join(root, 'packages'))).resolves.toBeUndefined();
    await expect(access(join(root, 'marketplace.json'))).resolves.toBeUndefined();
    await expect(access(join(root, 'README.md'))).resolves.toBeUndefined();
    await expect(access(join(root, '.gitignore'))).resolves.toBeUndefined();
  });

  it('seeds marketplace.json with the personal registry shape', async () => {
    const { stub } = buildSourceManagerStub();

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    const manifestPath = join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      name: string;
      owner?: { name: string };
      metadata?: { description?: string };
      plugins: unknown[];
    };

    expect(parsed.name).toBe('personal');
    expect(parsed.owner?.name).toBeTruthy();
    expect(typeof parsed.metadata?.description).toBe('string');
    expect(parsed.metadata?.description?.length ?? 0).toBeGreaterThan(0);
    expect(parsed.plugins).toEqual([]);
  });

  it('registers a personal source pointing at the on-disk root via file:// URL', async () => {
    const { stub, add } = buildSourceManagerStub();

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      name: PERSONAL_MARKETPLACE_NAME,
      source: `file://${personalMarketplaceRoot(dorkHome)}`,
      enabled: true,
    });
  });

  it('logs a diagnostic message when the source is registered', async () => {
    const { stub } = buildSourceManagerStub();

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    expect(logger.info).toHaveBeenCalledWith(
      '[personal-marketplace] registered source',
      expect.objectContaining({ root: personalMarketplaceRoot(dorkHome) })
    );
  });

  it('is idempotent: re-running does not throw', async () => {
    const { stub } = buildSourceManagerStub();

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });
    await expect(
      ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger })
    ).resolves.toBeUndefined();
  });

  it('does not overwrite an existing marketplace.json on re-run', async () => {
    const { stub } = buildSourceManagerStub();
    const root = personalMarketplaceRoot(dorkHome);
    await mkdir(join(root, 'packages'), { recursive: true });
    const customManifest = {
      name: 'personal',
      description: 'user-customized',
      plugins: [{ name: 'my-pkg', version: '1.0.0' }],
    };
    await writeFile(
      join(root, 'marketplace.json'),
      JSON.stringify(customManifest, null, 2),
      'utf-8'
    );

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    const raw = await readFile(join(root, 'marketplace.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { description: string; plugins: unknown[] };
    expect(parsed.description).toBe('user-customized');
    expect(parsed.plugins).toHaveLength(1);
  });

  it('does not overwrite an existing README.md or .gitignore on re-run', async () => {
    const { stub } = buildSourceManagerStub();
    const root = personalMarketplaceRoot(dorkHome);
    await mkdir(join(root, 'packages'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# my custom readme', 'utf-8');
    await writeFile(join(root, '.gitignore'), 'node_modules', 'utf-8');

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    const readme = await readFile(join(root, 'README.md'), 'utf-8');
    const gitignore = await readFile(join(root, '.gitignore'), 'utf-8');
    expect(readme).toBe('# my custom readme');
    expect(gitignore).toBe('node_modules');
  });

  it('does not call add() when the source is already registered', async () => {
    const { stub, add } = buildSourceManagerStub([
      {
        name: PERSONAL_MARKETPLACE_NAME,
        source: `file://${personalMarketplaceRoot(dorkHome)}`,
        enabled: true,
        addedAt: new Date().toISOString(),
      },
    ]);

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    expect(add).not.toHaveBeenCalled();
  });

  it('does not log "registered source" when the source is already registered', async () => {
    const { stub } = buildSourceManagerStub([
      {
        name: PERSONAL_MARKETPLACE_NAME,
        source: `file://${personalMarketplaceRoot(dorkHome)}`,
        enabled: true,
        addedAt: new Date().toISOString(),
      },
    ]);

    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });

    expect(logger.info).not.toHaveBeenCalledWith(
      '[personal-marketplace] registered source',
      expect.anything()
    );
  });
});
