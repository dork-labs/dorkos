/**
 * What the extension-building case promises about ITSELF (DOR-2858), without a
 * model: it never runs on a free tier or inside `core`, its prompt names no
 * HTTP style (the router and fetch-handler runs must get the same words), the
 * seeded approval is a config the server accepts for exactly the copy
 * `create_extension` writes, and every body predicate has a real PASS and FAIL.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { selectSuite } from '../index.js';
import {
  SAVED_QUOTES,
  QUOTE_BOARD_ID,
  extensionDataProviderCase,
  hasQuotes,
  hasSavedQuotes,
  quoteBoardDir,
  seedQuoteBoardApproval,
  startedOk,
} from '../extensions/data-provider.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('extension-data-provider case', () => {
  it('is credentialed, quarantined, and kept out of core', () => {
    expect(extensionDataProviderCase.runtimeTier).toBe('claude-code-cheap');
    expect(extensionDataProviderCase.quarantined).toBe(true);
    expect(selectSuite('core')).not.toContain(extensionDataProviderCase);
    expect(selectSuite('experimental')).toContain(extensionDataProviderCase);
    expect(selectSuite('extension-data-provider')).toEqual([extensionDataProviderCase]);
  });

  it('never names the HTTP style it is comparing', () => {
    const prompt = String(extensionDataProviderCase.prompt).toLowerCase();
    for (const word of ['router', 'express', 'hono', 'fetch']) {
      expect(prompt).not.toContain(word);
    }
    expect(prompt).toContain('data-provider');
    expect(prompt).toContain(QUOTE_BOARD_ID);
  });

  it('denies Bash, so the build goes through the extension tools', () => {
    expect(extensionDataProviderCase.approvalPolicy?.allowTools).toContain('create_extension');
    expect(extensionDataProviderCase.approvalPolicy?.allowTools).not.toContain('Bash');
  });

  it('seeds a valid approval for the global copy create_extension writes', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evals-ext-seed-'));
    const sandbox = { dorkHome: path.join(dir, 'home'), projectCwd: path.join(dir, 'cwd') };
    await seedQuoteBoardApproval(sandbox);

    const raw = JSON.parse(await readFile(path.join(sandbox.dorkHome, 'config.json'), 'utf8'));
    // Only `extensions` is seeded; the store fills every other section from its defaults.
    const extensions = UserConfigSchema.shape.extensions.parse(raw.extensions);
    expect(extensions.approvedToRun).toEqual([QUOTE_BOARD_ID]);
    expect(extensions.approvedSources[QUOTE_BOARD_ID]).toEqual({
      path: path.join(sandbox.dorkHome, 'extensions', QUOTE_BOARD_ID),
    });
    expect(quoteBoardDir(sandbox)).toBe(path.join(sandbox.dorkHome, 'extensions', QUOTE_BOARD_ID));
  });
});

describe('body predicates', () => {
  it('hasQuotes wants at least the minimum of non-empty strings', () => {
    expect(hasQuotes({ quotes: ['a', 'b'] }, 2)).toBe(true);
    expect(hasQuotes({ quotes: ['a'] }, 2)).toBe(false);
    expect(hasQuotes({ quotes: ['a', ''] }, 2)).toBe(false);
    expect(hasQuotes({ quotes: [{ text: 'a' }, { text: 'b' }] }, 2)).toBe(false);
    expect(hasQuotes(['a', 'b'], 2)).toBe(false);
    expect(hasQuotes(undefined, 2)).toBe(false);
  });

  it('hasSavedQuotes wants exactly the saved list, in order', () => {
    expect(hasSavedQuotes({ quotes: [...SAVED_QUOTES] })).toBe(true);
    expect(hasSavedQuotes({ quotes: [...SAVED_QUOTES].reverse() })).toBe(false);
    expect(hasSavedQuotes({ quotes: SAVED_QUOTES.slice(1) })).toBe(false);
    expect(hasSavedQuotes({ quotes: ['default one', 'default two'] })).toBe(false);
  });

  it('startedOk wants ok: true and nothing less', () => {
    expect(startedOk({ ok: true })).toBe(true);
    expect(startedOk({ error: 'Build failed: x' })).toBe(false);
    expect(startedOk({ ok: 'true' })).toBe(false);
    expect(startedOk(undefined)).toBe(false);
  });
});
