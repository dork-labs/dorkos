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

    it('writes the same frames to the NDJSON file', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', subprocessDump());

      const [entry] = fs
        .readFileSync(path.join(logDir, 'dorkos.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(String(entry.stack)).toContain('logger-console-clipping.test.ts');
    });

    it('still shows the head of the child dump the operator came for', () => {
      loggerModule.logger.error('[Runtimes] subprocess died', subprocessDump());

      const out = output();
      expect(out).toContain('child process failed:');
      expect(out).toContain('ChildError: the packfile was truncated');
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

    it('says so without inventing a count when the cut error is the last link', () => {
      // Exactly five links, so the limit lands on an error that genuinely has
      // no cause of its own — the structure is still dropped, but there is no
      // remaining chain to size.
      let err = new Error('bottom');
      for (let i = 1; i <= 5; i++) err = new Error(`link-${i}`, { cause: err });

      loggerModule.logger.error('[relay] send failed', err);

      expect(output()).toContain('[truncated at depth 5]');
      expect(output()).not.toContain('more levels');
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
      expect(output()).toContain('unreadable property');
    });

    it('a throwing sibling does not cost the huge error beside it its clipping', () => {
      // `Object.entries` runs every getter in one go, so reading this object as
      // a unit throws before the error is ever seen — and abandoning the object
      // means abandoning the clip, putting the whole payload back on screen.
      const context = {
        err: new Error('y'.repeat(HUGE)),
        get diagnostics(): string {
          throw new Error('getter exploded');
        },
      };

      loggerModule.logger.error('[relay] send failed', context);

      expect(output().length).toBeLessThan(64 * 1024);
      // A nested error renders through its stack, whose marker names the
      // stack's own length rather than the message's — hence the pattern.
      expect(output()).toMatch(/\[truncated, \d{6,} characters total\]/);
      expect(output()).toContain('unreadable property');
    });

    it('clips an error whose class exposes a getter-only property', () => {
      // Assignment consults the prototype, so copying own properties onto the
      // clone by `clone[key] = value` throws on this shape.
      class RuntimeError extends Error {
        get code(): string {
          return 'E_RUNTIME';
        }
      }
      const err = new RuntimeError('y'.repeat(HUGE));
      Object.defineProperty(err, 'code', { value: 'E_OVERRIDDEN', enumerable: true });

      expect(() => loggerModule.logger.error('[Runtimes] died', err)).not.toThrow();
      expect(output().length).toBeLessThan(64 * 1024);
      expect(output()).toContain(`[truncated, ${HUGE} characters total]`);
    });

    it('still prints the line for a cyclic context', () => {
      const cyclic: Record<string, unknown> = { workspace: 'demo' };
      cyclic.self = cyclic;

      expect(() => loggerModule.logger.error('[workspaces] GET / failed', cyclic)).not.toThrow();
      expect(output()).toContain('[workspaces] GET / failed');
    });
  });
});
