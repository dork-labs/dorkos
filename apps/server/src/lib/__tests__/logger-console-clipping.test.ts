import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConsola } from 'consola';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The defect this file pins (DOR-1728) lived in the bytes that reach the
 * TERMINAL, so nothing here reads the NDJSON file: every assertion reads what
 * consola's own console reporter wrote, captured by pointing the instance's
 * `stdout`/`stderr` at a sink that keeps the chunks.
 *
 * `logger.error(msg, err)` routes to `stderr` — anything below level 2 does —
 * which is why reproducing this by hand with `> file` and no `2>&1` shows you
 * nothing at all.
 */
describe('console reporter clipping', () => {
  /** The length of the oversized message every case below feeds in. */
  const HUGE = 600_000;

  let logDir: string;
  let loggerModule: typeof import('../logger.js');
  let written: string[];

  /** A stream that keeps what was written to it. BasicReporter reads `.columns` first. */
  function sink(chunks: string[]): NodeJS.WriteStream {
    return {
      columns: 80,
      write: (chunk: string) => {
        chunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
  }

  /** Everything the console reporter has written so far, as one string. */
  function output(): string {
    return written.join('');
  }

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-console-clip-'));
    vi.resetModules();
    loggerModule = await import('../logger.js');
    loggerModule.initLogger({ level: 5, logDir });

    written = [];
    loggerModule.logger.options.stdout = sink(written);
    loggerModule.logger.options.stderr = sink(written);
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  describe('an error far larger than a terminal can carry', () => {
    it('bounds what reaches the terminal instead of writing the whole payload', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', new Error('y'.repeat(HUGE)));

      expect(output().length).toBeLessThan(64 * 1024);
    });

    it('names the full length of what it dropped', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', new Error('y'.repeat(HUGE)));

      expect(output()).toContain(`[truncated, ${HUGE} characters total]`);
    });

    it('still prints the call site, the head of the message, and the stack frames', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', new Error('y'.repeat(HUGE)));

      const out = output();
      expect(out).toContain('[Runtimes] subprocess died');
      // Enough of the message to recognise which failure this is.
      expect(out).toContain('y'.repeat(1000));
      // And the frames, which are the half an operator acts on — a flat clip of
      // the stack would have spent the whole budget on more of the message.
      expect(out).toContain('logger-console-clipping.test.ts');
    });

    it('bounds one nested inside a context object too', () => {
      loggerModule.logger.error('[relay] send failed', { err: new Error('y'.repeat(HUGE)) });

      expect(output().length).toBeLessThan(64 * 1024);
    });

    it('bounds one logged before initLogger has run at all', async () => {
      vi.resetModules();
      const fresh = await import('../logger.js');
      const chunks: string[] = [];
      fresh.logger.options.stdout = sink(chunks);
      fresh.logger.options.stderr = sink(chunks);

      fresh.logger.error('[boot] config load failed', new Error('y'.repeat(HUGE)));

      expect(chunks.join('').length).toBeLessThan(64 * 1024);
    });

    it('clips the terminal and the NDJSON file with one shared marker', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', new Error('y'.repeat(HUGE)));

      const marker = `[truncated, ${HUGE} characters total]`;
      expect(output()).toContain(marker);
      expect(fs.readFileSync(path.join(logDir, 'dorkos.log'), 'utf8')).toContain(marker);
    });
  });

  describe('an error of ordinary size', () => {
    it('reaches the terminal byte-for-byte as consola would have written it', () => {
      const err = new Error('boom');

      loggerModule.logger.error('[Extensions] Failed to initialize', err);

      // The same call through an UNWRAPPED consola of the same shape. Under
      // vitest (`NODE_ENV=test`) both instances pick BasicReporter, whose output
      // carries no timestamp and no colour, so the two strings compare directly.
      const plainChunks: string[] = [];
      const plain = createConsola({ level: 5 });
      plain.options.stdout = sink(plainChunks);
      plain.options.stderr = sink(plainChunks);
      plain.error('[Extensions] Failed to initialize', err);

      expect(output()).toBe(plainChunks.join(''));
      expect(output()).not.toContain('[truncated');
    });

    it('leaves an ordinary context object alone', () => {
      const plainChunks: string[] = [];
      const plain = createConsola({ level: 5 });
      plain.options.stdout = sink(plainChunks);
      plain.options.stderr = sink(plainChunks);

      const context = { taskId: 'abc', attempts: 2, nested: { ok: true } };
      loggerModule.logger.info('[Tasks] scheduled', context);
      plain.info('[Tasks] scheduled', context);

      expect(output()).toBe(plainChunks.join(''));
    });
  });

  describe('context objects that defeat inspection', () => {
    it('still prints the line when a property getter throws', () => {
      const hostile = {
        get boom(): string {
          throw new Error('getter exploded');
        },
      };

      expect(() => loggerModule.logger.error('[relay] send failed', hostile)).not.toThrow();
      expect(output()).toContain('[relay] send failed');
    });

    it('still prints the line for a cyclic context', () => {
      const cyclic: Record<string, unknown> = { workspace: 'demo' };
      cyclic.self = cyclic;

      expect(() => loggerModule.logger.error('[workspaces] GET / failed', cyclic)).not.toThrow();
      expect(output()).toContain('[workspaces] GET / failed');
    });
  });
});
