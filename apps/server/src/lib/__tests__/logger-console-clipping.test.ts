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

    it('clips the terminal and the NDJSON file with one shared marker', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', new Error('y'.repeat(HUGE)));

      const marker = `[truncated, ${HUGE} characters total]`;
      expect(output()).toContain(marker);
      expect(fs.readFileSync(path.join(logDir, 'dorkos.log'), 'utf8')).toContain(marker);
    });
  });

  describe('an error a call site flattened with logError() before logging it', () => {
    /**
     * The shape ~92 call sites use: the error is folded into a wider context
     * object as `{ error, stack }`, so neither reporter's walk can see an Error
     * to clip any more (DOR-1827). Before the clip moved into `logError` itself
     * this wrote 1.2 MB where handing the same error to the logger wrote 9 KB.
     */
    function flattened(err: unknown): Record<string, unknown> {
      return { workspaceId: 'demo', ...loggerModule.logError(err) };
    }

    /**
     * The terminal was never as loud as the file for this shape, and not for a
     * reason worth relying on: `util.inspect` truncates a string nested in an
     * object at its own default of 10,000 characters, so a flattened error
     * arrived as ~20 KB of two half-strings and Node's own
     * `... 590000 more characters` note. That is an accident of a default we do
     * not set, it does not say what the caps elsewhere say, and it scales with
     * however many string fields a context carries. So the assertion is that
     * the terminal now carries OUR bound and OUR marker.
     */
    it('bounds the terminal with the shared marker, not Node’s inspect default', () => {
      loggerModule.logger.error('[Workspaces] scan failed', flattened(new Error('y'.repeat(HUGE))));

      expect(output().length).toBeLessThan(64 * 1024);
      expect(output()).toContain(`[truncated, ${HUGE} characters total]`);
      expect(output()).not.toContain('more characters');
    });

    it('bounds the NDJSON line too, with the same marker', () => {
      loggerModule.logger.error('[Workspaces] scan failed', flattened(new Error('y'.repeat(HUGE))));

      const marker = `[truncated, ${HUGE} characters total]`;
      const line = fs.readFileSync(path.join(logDir, 'dorkos.log'), 'utf8');
      expect(line.length).toBeLessThan(64 * 1024);
      expect(line).toContain(marker);
      expect(output()).toContain(marker);
    });
  });

  describe('an error whose message contains someone else’s stack trace', () => {
    /**
     * The shape this exists for: a subprocess dump. `git clone` stderr, a failed
     * `npm install`, a crashed child runtime — the message carries the CHILD's
     * own stack, `    at …` lines and all, so the first frame-looking line in
     * the string belongs to the child and not to us. Anything that locates the
     * frames by searching for one hands the header a few dozen bytes and spends
     * the whole frame budget on quoted child lines.
     */
    function subprocessDump(): Error {
      const childStack = [
        'ChildError: the packfile was truncated',
        '    at Unpacker.finish (/usr/lib/node_modules/npm/unpack.js:220:17)',
        '    at Socket.onEnd (/usr/lib/node_modules/npm/fetch.js:88:9)',
      ].join('\n');
      // Long enough to blow the budget, and every repetition looks like a frame.
      return new Error(`child process failed:\n${(childStack + '\n').repeat(9000)}`);
    }

    it('keeps OUR frames, not the quoted ones from the message', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', subprocessDump());

      const out = output();
      expect(out.length).toBeLessThan(64 * 1024);
      // The frames of the log call itself — the only ones that say where in
      // DorkOS this happened. Locating the boundary by the first `at ` line
      // instead of by the message loses every one of them.
      expect(out).toContain('logger-console-clipping.test.ts');
    });
  });

  describe('a cause chain deeper than the walk follows', () => {
    it('says the chain was cut, and how much of it is missing', () => {
      let err = new Error('depth-0');
      for (let i = 1; i <= 12; i++) err = new Error(`depth-${i}`, { cause: err });

      loggerModule.logger.error('[relay] send failed', err);

      // Without this marker the cut link reads exactly like the natural end of
      // the chain — nothing would tell the reader seven more levels existed.
      expect(output()).toContain('[cause chain truncated at depth 5, 7 more levels]');
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
      expect(output()).toContain('unreadable property');
    });
  });
});
