/**
 * Tests for the server log excerpt (feedback-pipeline spec Part 2).
 *
 * Proves the two load-bearing guarantees: severity/recency filtering (only
 * warn+ lines, only within the requested window, newest-last and bounded), and
 * SCRUBBING — a home directory and a secret-shaped token planted in a real log
 * line must never survive into the returned excerpt (mirrors the poison-test
 * pattern in `packages/shared/src/__tests__/feedback.test.ts`).
 *
 * Uses real files under a throwaway tmpdir (via the real `logger.ts`) rather
 * than mocking `fs`, so the NDJSON shape this module actually parses is the
 * shape the logger actually writes — no risk of the two drifting apart.
 */
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LOG_EXCERPT_LEN } from '@dorkos/shared/telemetry-events';

let logDir: string;
let loggerModule: typeof import('../logger.js');
let logExcerptModule: typeof import('../log-excerpt.js');

beforeEach(async () => {
  vi.resetModules();
  logDir = await mkdtemp(path.join(tmpdir(), 'dork-log-excerpt-'));
  loggerModule = await import('../logger.js');
  logExcerptModule = await import('../log-excerpt.js');
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

describe('getRecentLogExcerpt', () => {
  it('returns undefined when no log directory is configured', async () => {
    const result = await logExcerptModule.getRecentLogExcerpt();
    expect(result).toBeUndefined();
  });

  it('returns undefined when there are no warn-or-above lines', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    loggerModule.logger.info('just some info');
    const result = await logExcerptModule.getRecentLogExcerpt();
    expect(result).toBeUndefined();
  });

  it('includes warn/error lines but excludes info/debug', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    loggerModule.logger.info('info line');
    loggerModule.logger.debug('debug line');
    loggerModule.logger.warn('warn line');
    loggerModule.logger.error('error line');

    const result = await logExcerptModule.getRecentLogExcerpt();

    expect(result).toContain('warn line');
    expect(result).toContain('error line');
    expect(result).not.toContain('info line');
    expect(result).not.toContain('debug line');
  });

  it('scrubs a home directory and a secret-shaped token before returning (poison test)', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    loggerModule.logger.warn(
      'config at /Users/dorian/.dork/config.json failed, token sk-live-abcdefgh12345678'
    );

    const result = await logExcerptModule.getRecentLogExcerpt();

    expect(result).toBeDefined();
    expect(result).not.toContain('/Users/dorian');
    expect(result).not.toContain('dorian');
    expect(result).not.toContain('sk-live-abcdefgh12345678');
  });

  it('drops lines older than maxAgeMs', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    const oldLine =
      JSON.stringify({
        level: 'warn',
        time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        msg: 'ancient warning',
      }) + '\n';
    await appendFile(path.join(logDir, 'dorkos.log'), oldLine);
    loggerModule.logger.warn('recent warning');

    const result = await logExcerptModule.getRecentLogExcerpt(200, 5 * 60 * 1000);

    expect(result).toContain('recent warning');
    expect(result).not.toContain('ancient warning');
  });

  it('bounds the excerpt to maxLines, keeping the newest', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    for (let i = 0; i < 10; i++) loggerModule.logger.warn(`warn ${i}`);

    const result = await logExcerptModule.getRecentLogExcerpt(3);

    expect(result).not.toContain('warn 0');
    expect(result).toContain('warn 9');
  });

  it('falls back to the prior rotated file when the current tail is thin', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    const rotatedLine =
      JSON.stringify({
        level: 'warn',
        time: '2020-01-01T00:00:00.000Z',
        msg: 'rotated warning',
      }) + '\n';
    await writeFile(path.join(logDir, 'dorkos.2020-01-01.log'), rotatedLine);
    loggerModule.logger.warn('live warning');

    // A very large maxAgeMs isolates "does it read the prior file at all"
    // from the separate recency filter proven above.
    const result = await logExcerptModule.getRecentLogExcerpt(200, Number.MAX_SAFE_INTEGER);

    expect(result).toContain('rotated warning');
    expect(result).toContain('live warning');
  });

  it('does not fall back to the prior file when the current tail already has enough lines', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    const rotatedLine =
      JSON.stringify({
        level: 'warn',
        time: '2020-01-01T00:00:00.000Z',
        msg: 'rotated warning',
      }) + '\n';
    await writeFile(path.join(logDir, 'dorkos.2020-01-01.log'), rotatedLine);
    loggerModule.logger.warn('live warning');

    const result = await logExcerptModule.getRecentLogExcerpt(1, Number.MAX_SAFE_INTEGER);

    expect(result).toContain('live warning');
    expect(result).not.toContain('rotated warning');
  });

  it('caps the excerpt length at or under MAX_LOG_EXCERPT_LEN', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    for (let i = 0; i < 500; i++) {
      loggerModule.logger.warn(`warning number ${i} `.repeat(5));
    }

    const result = await logExcerptModule.getRecentLogExcerpt(1000);

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(MAX_LOG_EXCERPT_LEN);
  });

  it('never throws when the log directory is unreadable', async () => {
    loggerModule.initLogger({ logDir, level: 5 });
    await rm(logDir, { recursive: true, force: true });

    await expect(logExcerptModule.getRecentLogExcerpt()).resolves.toBeUndefined();
  });
});
