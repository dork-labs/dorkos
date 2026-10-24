/**
 * The process-level crash handlers hand their error to the logger whole
 * (DOR-1827).
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * Both reporters bound a runaway error by recognising an `Error` — the file
 * one serializes it, the console one clips it, and `lib/serialize-error.ts`
 * gives them one set of bounds so they agree. A call site that takes the error
 * apart first, into `{ message, stack, name }`, hands them three ordinary
 * strings instead, and neither can tell those from any other context field. So
 * the clipping silently does not apply: measured on this file's own handlers,
 * a crash carrying a subprocess dump wrote a 1,200,561-byte NDJSON line where
 * passing the error itself writes 8,820.
 *
 * Nothing about that is visible to a type check or to any other suite — the
 * flattened version compiles, logs, and reads correctly right up until the
 * error is huge. And these two lines are the least testable in the server:
 * they are registered on `process` by `index.ts`, whose import boots the whole
 * application. The scan is what makes the regression catchable at all.
 *
 * The second test covers the other half — that the shape they now use is in
 * fact bounded — because a scan asserting a call shape is only worth having
 * while that shape is the one that works.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The composition root, resolved from this file rather than from the cwd. */
const INDEX_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts');

/**
 * The fatal path of the process handlers in `index.ts`: the `fatal` callback
 * handed to `createProcessFaultHandlers`, which both events reach for anything
 * that is not a survivable network failure (DOR-3229).
 *
 * A missing handler throws rather than returning empty: a scan that passes
 * because it found nothing to look at is the failure mode this whole file
 * exists to avoid.
 */
function fatalBody(): string {
  const source = readFileSync(INDEX_TS, 'utf-8');
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    expect(source, `no process.on('${event}') registration in index.ts`).toContain(
      `process.on('${event}', processFaults.`
    );
  }
  const start = source.indexOf('createProcessFaultHandlers({');
  expect(start, 'no createProcessFaultHandlers call in index.ts').toBeGreaterThan(-1);
  const end = source.indexOf('\n});', start);
  expect(end, 'unterminated createProcessFaultHandlers call in index.ts').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('process crash handlers', () => {
  it('hands the uncaught error to the logger whole, not flattened', () => {
    const body = fatalBody();

    expect(body).toContain("logger.error('[DorkOS] Uncaught exception — shutting down', value)");
    // The shape that defeats both reporters' clipping.
    expect(body).not.toMatch(/\bstack:\s*value\.stack/);
    expect(body).not.toMatch(/\bmessage:\s*value\.message/);
  });

  it('hands the rejection reason to the logger whole, not flattened', () => {
    const body = fatalBody();

    expect(body).toContain(
      "logger.error('[DorkOS] Unhandled promise rejection — shutting down', { reason: value })"
    );
  });

  it('bounds a crash whose error is far larger than a log line should be', async () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'dorkos-crash-log-'));
    try {
      // Held as the module namespace, not destructured: `initLogger` REPLACES
      // the exported `logger`, so a binding captured before that call is the
      // pre-init instance with no file reporter on it, and nothing is written.
      const loggerModule = await import('../lib/logger.js');
      loggerModule.initLogger({ level: 5, logDir });
      const quiet = { columns: 80, write: () => true } as unknown as NodeJS.WriteStream;
      loggerModule.logger.options.stdout = quiet;
      loggerModule.logger.options.stderr = quiet;

      const huge = 'y'.repeat(600_000);
      // The two call shapes asserted above, verbatim.
      loggerModule.logger.error('[DorkOS] Uncaught exception — shutting down', new Error(huge));
      loggerModule.logger.error('[DorkOS] Unhandled promise rejection', {
        reason: new Error(huge),
      });

      const lines = readFileSync(path.join(logDir, 'dorkos.log'), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.length).toBeLessThan(64 * 1024);
        expect(line).toContain(`[truncated, ${huge.length} characters total]`);
      }
      // The frames survive the clip — they are the half that says where the
      // crash happened, and a flat cut of the stack would have spent the whole
      // budget on more of the message.
      expect(lines[0]).toContain('crash-handler-logging.test.ts');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
