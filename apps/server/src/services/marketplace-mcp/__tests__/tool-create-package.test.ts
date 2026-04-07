import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

import {
  ensurePersonalMarketplace,
  personalMarketplaceRoot,
  PERSONAL_MARKETPLACE_NAME,
} from '../personal-marketplace.js';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
} from '../confirmation-provider.js';
import type { ConfirmationProvider, ConfirmationResult } from '../confirmation-provider.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import type { MarketplaceSource } from '../../marketplace/types.js';
import type { MarketplaceSourceManager } from '../../marketplace/marketplace-source-manager.js';
import { createCreatePackageHandler } from '../tool-create-package.js';

/** Build a logger whose every method is a `vi.fn()` spy. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a stub `MarketplaceSourceManager` backed by an in-memory map. Only
 * `get()` and `add()` are touched by `ensurePersonalMarketplace`, so the stub
 * implements just those two and casts through `unknown` to satisfy the type.
 */
function buildSourceManagerStub() {
  const sources = new Map<string, MarketplaceSource>();
  const get = vi.fn(async (name: string) => sources.get(name) ?? null);
  const add = vi.fn(async (input: { name: string; source: string; enabled?: boolean }) => {
    const created: MarketplaceSource = {
      name: input.name,
      source: input.source,
      enabled: input.enabled ?? true,
      addedAt: new Date().toISOString(),
    };
    sources.set(created.name, created);
    return created;
  });
  return { stub: { get, add } as unknown as MarketplaceSourceManager, get, add };
}

/**
 * Build a `MarketplaceMcpDeps` stub. Only `dorkHome`, `confirmationProvider`,
 * and `logger` are exercised by `createCreatePackageHandler`. The rest are
 * cast through `unknown` to satisfy the dependency interface without pulling
 * in unrelated marketplace services.
 */
function buildDeps(opts: {
  dorkHome: string;
  confirmationProvider: ConfirmationProvider;
  logger?: Logger;
}): MarketplaceMcpDeps {
  return {
    dorkHome: opts.dorkHome,
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: opts.confirmationProvider,
    logger: opts.logger ?? buildLogger(),
  } satisfies MarketplaceMcpDeps;
}

/** Parse the JSON `text` payload out of an MCP tool result envelope. */
function parseResult(result: { content: { type: 'text'; text: string }[]; isError?: boolean }): {
  isError: boolean;
  payload: Record<string, unknown>;
} {
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  expect(block?.type).toBe('text');
  return {
    isError: result.isError === true,
    payload: JSON.parse(block?.text ?? '') as Record<string, unknown>,
  };
}

describe('createCreatePackageHandler', () => {
  let dorkHome: string;
  let logger: Logger;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'tool-create-package-'));
    logger = buildLogger();
    const { stub } = buildSourceManagerStub();
    // Seed the personal marketplace so the handler always operates against an
    // initialized directory tree, mirroring the production server boot order.
    await ensurePersonalMarketplace({ dorkHome, sourceManager: stub, logger });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('returns requires_confirmation and writes nothing on first call (token flow)', async () => {
    const provider = new TokenConfirmationProvider();
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: provider, logger })
    );

    const result = await handler({
      name: 'sample-skill',
      type: 'skill-pack',
      description: 'A sample skill pack for testing.',
    });
    const { payload } = parseResult(result);

    expect(payload.status).toBe('requires_confirmation');
    expect(typeof payload.confirmationToken).toBe('string');
    expect((payload.confirmationToken as string).length).toBeGreaterThan(0);

    // Confirmation gate fired BEFORE any disk write — package directory must
    // not exist yet.
    const packagePath = join(personalMarketplaceRoot(dorkHome), 'packages', 'sample-skill');
    await expect(access(packagePath)).rejects.toThrow();
  });

  it('writes scaffolded files after the user approves the issued token', async () => {
    const provider = new TokenConfirmationProvider();
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: provider, logger })
    );

    const first = await handler({
      name: 'approved-pkg',
      type: 'skill-pack',
      description: 'Approved test package.',
    });
    const { payload: pendingPayload } = parseResult(first);
    const token = pendingPayload.confirmationToken as string;

    provider.approve(token);

    const second = await handler({
      name: 'approved-pkg',
      type: 'skill-pack',
      description: 'Approved test package.',
      confirmationToken: token,
    });
    const { payload, isError } = parseResult(second);

    expect(isError).toBe(false);
    expect(payload.status).toBe('created');
    const packagePath = personalMarketplaceRoot(dorkHome) + '/packages/approved-pkg';
    expect(payload.packagePath).toBe(packagePath);
    expect(Array.isArray(payload.filesCreated)).toBe(true);
    expect((payload.filesCreated as string[]).length).toBeGreaterThan(0);

    // Manifest exists on disk.
    await expect(access(join(packagePath, '.dork', 'manifest.json'))).resolves.toBeUndefined();
    await expect(access(join(packagePath, 'README.md'))).resolves.toBeUndefined();
  });

  it('returns declined and writes nothing when the user declines the token', async () => {
    const provider = new TokenConfirmationProvider();
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: provider, logger })
    );

    const first = await handler({
      name: 'declined-pkg',
      type: 'agent',
      description: 'Will be declined.',
    });
    const token = parseResult(first).payload.confirmationToken as string;

    provider.decline(token, 'no thanks');

    const second = await handler({
      name: 'declined-pkg',
      type: 'agent',
      description: 'Will be declined.',
      confirmationToken: token,
    });
    const { payload } = parseResult(second);

    expect(payload.status).toBe('declined');
    expect(payload.reason).toBe('no thanks');

    // Confirmation gate kept the package off disk.
    const packagePath = join(personalMarketplaceRoot(dorkHome), 'packages', 'declined-pkg');
    await expect(access(packagePath)).rejects.toThrow();
  });

  it('appends the new package to personal marketplace.json on success', async () => {
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: new AutoApproveConfirmationProvider(), logger })
    );

    const result = await handler({
      name: 'registered-pkg',
      type: 'plugin',
      description: 'A plugin that should be registered.',
      author: 'Tester',
    });
    const { payload } = parseResult(result);
    expect(payload.status).toBe('created');

    const manifestPath = join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      name: string;
      plugins: { name: string; type?: string; description?: string; source?: string }[];
    };

    expect(parsed.name).toBe(PERSONAL_MARKETPLACE_NAME);
    expect(parsed.plugins).toHaveLength(1);
    const entry = parsed.plugins[0];
    expect(entry?.name).toBe('registered-pkg');
    expect(entry?.type).toBe('plugin');
    expect(entry?.description).toBe('A plugin that should be registered.');
    expect(entry?.source).toBe(`file://${payload.packagePath as string}`);
  });

  it('is idempotent when the same package name is registered twice', async () => {
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: new AutoApproveConfirmationProvider(), logger })
    );

    // First call: scaffolds and registers.
    await handler({
      name: 'idem-pkg',
      type: 'skill-pack',
      description: 'First registration.',
    });

    // Second call: scaffolder fails (directory exists), but the
    // marketplace.json must NOT gain a duplicate entry. We assert the manifest
    // still has exactly one entry — the registration helper is idempotent.
    const second = await handler({
      name: 'idem-pkg',
      type: 'skill-pack',
      description: 'Second registration.',
    });
    const { payload, isError } = parseResult(second);
    expect(isError).toBe(true);
    expect(payload.code).toBe('CREATE_FAILED');

    const manifestPath = join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
      plugins: { name: string }[];
    };
    expect(parsed.plugins.filter((p) => p.name === 'idem-pkg')).toHaveLength(1);
  });

  it('registerInPersonalMarketplace helper is a no-op when the entry already exists', async () => {
    // Manually pre-populate marketplace.json with a `dup-pkg` entry, then
    // attempt to scaffold a package by the same name. The scaffolder
    // succeeds (clean dir), but the helper should NOT add a second entry.
    const manifestPath = join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
    const seeded = {
      name: PERSONAL_MARKETPLACE_NAME,
      description: 'seeded',
      plugins: [
        {
          name: 'dup-pkg',
          type: 'skill-pack',
          description: 'pre-existing entry',
          source: 'file:///seeded',
        },
      ],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(manifestPath, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');

    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: new AutoApproveConfirmationProvider(), logger })
    );

    const result = await handler({
      name: 'dup-pkg',
      type: 'skill-pack',
      description: 'Will scaffold but not duplicate.',
    });
    const { payload } = parseResult(result);
    expect(payload.status).toBe('created');

    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
      plugins: { name: string; description: string }[];
    };
    expect(parsed.plugins.filter((p) => p.name === 'dup-pkg')).toHaveLength(1);
    // The original entry survived (helper did NOT overwrite it).
    expect(parsed.plugins[0]?.description).toBe('pre-existing entry');
  });

  it('returns CREATE_FAILED when the scaffolder throws (e.g., directory exists)', async () => {
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: new AutoApproveConfirmationProvider(), logger })
    );

    await handler({
      name: 'collision',
      type: 'skill-pack',
      description: 'First create succeeds.',
    });

    const second = await handler({
      name: 'collision',
      type: 'skill-pack',
      description: 'Second create fails — directory exists.',
    });
    const { payload, isError } = parseResult(second);

    expect(isError).toBe(true);
    expect(payload.code).toBe('CREATE_FAILED');
    expect(typeof payload.error).toBe('string');
    expect(payload.error).toContain('Directory already exists');
  });

  it('skips the confirmation gate entirely when AutoApproveConfirmationProvider is used', async () => {
    const provider = new AutoApproveConfirmationProvider();
    const requestSpy = vi.spyOn(provider, 'requestInstallConfirmation');
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: provider, logger })
    );

    const result = await handler({
      name: 'auto-approved',
      type: 'plugin',
      description: 'Auto-approved package.',
    });
    const { payload } = parseResult(result);
    expect(payload.status).toBe('created');
    // The handler still calls requestInstallConfirmation; auto-approve simply
    // returns approved synchronously rather than issuing a token.
    expect(requestSpy).toHaveBeenCalledWith({
      packageName: 'auto-approved',
      marketplace: PERSONAL_MARKETPLACE_NAME,
      operation: 'create-package',
    });
  });

  it('passes the resolved token through resolveToken when confirmationToken is provided', async () => {
    const provider = new TokenConfirmationProvider();
    const resolveSpy = vi.spyOn(provider, 'resolveToken');
    const handler = createCreatePackageHandler(
      buildDeps({ dorkHome, confirmationProvider: provider, logger })
    );

    const first = await handler({
      name: 'token-routed',
      type: 'agent',
      description: 'Token-routed package.',
    });
    const token = parseResult(first).payload.confirmationToken as string;
    provider.approve(token);

    await handler({
      name: 'token-routed',
      type: 'agent',
      description: 'Token-routed package.',
      confirmationToken: token,
    });

    expect(resolveSpy).toHaveBeenCalledWith(token);
  });

  it('logs a warning but still returns created when registerInPersonalMarketplace fails', async () => {
    // Delete marketplace.json so registerInPersonalMarketplace cannot read
    // it. The scaffolder still succeeds; the registration helper logs and
    // swallows the error so the user-visible result is still `created`.
    const manifestPath = join(personalMarketplaceRoot(dorkHome), 'marketplace.json');
    await rm(manifestPath);

    const customLogger = buildLogger();
    const handler = createCreatePackageHandler(
      buildDeps({
        dorkHome,
        confirmationProvider: new AutoApproveConfirmationProvider(),
        logger: customLogger,
      })
    );

    const result = await handler({
      name: 'registry-broken',
      type: 'plugin',
      description: 'Registry write will fail.',
    });
    const { payload } = parseResult(result);
    expect(payload.status).toBe('created');
    expect(customLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('marketplace_create_package'),
      expect.objectContaining({ error: expect.any(String) })
    );

    // The package directory still exists — only the registry write failed.
    await expect(
      access(join(personalMarketplaceRoot(dorkHome), 'packages', 'registry-broken'))
    ).resolves.toBeUndefined();
  });
});

describe('CreatePackageInputSchema', () => {
  it('exports a Zod schema shape with name, type, description, author, confirmationToken', async () => {
    const { CreatePackageInputSchema } = await import('../tool-create-package.js');
    expect(CreatePackageInputSchema).toBeDefined();
    expect(CreatePackageInputSchema.name).toBeDefined();
    expect(CreatePackageInputSchema.type).toBeDefined();
    expect(CreatePackageInputSchema.description).toBeDefined();
    expect(CreatePackageInputSchema.author).toBeDefined();
    expect(CreatePackageInputSchema.confirmationToken).toBeDefined();
  });

  it('rejects names that do not match the kebab-case regex', async () => {
    const { CreatePackageInputSchema } = await import('../tool-create-package.js');
    const result = CreatePackageInputSchema.name.safeParse('Bad_Name');
    expect(result.success).toBe(false);
  });

  it('accepts a valid kebab-case package name', async () => {
    const { CreatePackageInputSchema } = await import('../tool-create-package.js');
    const result = CreatePackageInputSchema.name.safeParse('good-name-123');
    expect(result.success).toBe(true);
  });

  it('restricts type to the four supported package types', async () => {
    const { CreatePackageInputSchema } = await import('../tool-create-package.js');
    expect(CreatePackageInputSchema.type.safeParse('agent').success).toBe(true);
    expect(CreatePackageInputSchema.type.safeParse('plugin').success).toBe(true);
    expect(CreatePackageInputSchema.type.safeParse('skill-pack').success).toBe(true);
    expect(CreatePackageInputSchema.type.safeParse('adapter').success).toBe(true);
    expect(CreatePackageInputSchema.type.safeParse('garbage').success).toBe(false);
  });
});

/**
 * Defensive type-only assertion to ensure the test file's `ConfirmationResult`
 * import is not tree-shaken by the linter — the discriminated union is used
 * implicitly through provider methods.
 */
const _confirmationResultTypeCheck: ConfirmationResult = { status: 'approved' };
void _confirmationResultTypeCheck;
