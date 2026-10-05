/**
 * LogForwarder (DOR-2686 task 3.5): lines are split across chunks, prefixed
 * with the extension id, capped per window with one "output suppressed" line,
 * and every line — suppressed or not — is still offered to `onLine`.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { LogForwarder } from '../log-forwarder.js';

/** A forwarder writing into arrays, on a clock the test moves. */
function setup(limit = 3) {
  const info: string[] = [];
  const warn: string[] = [];
  const seen: string[] = [];
  let t = 0;
  const forwarder = new LogForwarder({
    extensionId: 'x',
    logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) },
    onLine: (line) => seen.push(line),
    linesPerWindow: limit,
    windowMs: 1_000,
    now: () => t,
  });
  return { forwarder, info, warn, seen, advance: (ms: number) => (t += ms) };
}

describe('LogForwarder', () => {
  // Purpose: a line split across chunks is one line; stdout is info, stderr warn.
  it('joins partial lines and prefixes them', async () => {
    const { forwarder, info, warn } = setup(10);
    const out = new PassThrough();
    const err = new PassThrough();
    forwarder.attach(out, 'stdout');
    forwarder.attach(err, 'stderr');
    out.write('hel');
    out.write('lo\r\nwor');
    out.end('ld');
    err.end('oops\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(info).toEqual(['[ext:x] hello', '[ext:x] world']);
    expect(warn).toEqual(['[ext:x] oops']);
  });

  // Purpose: past the cap one suppression line is written, and the next
  // window starts fresh; onLine still sees every line (the OOM marker).
  it('caps lines per window', () => {
    const { forwarder, info, warn, seen, advance } = setup(3);
    for (let i = 0; i < 6; i++) forwarder.line(`l${i}`, 'stdout');
    expect(info).toEqual(['[ext:x] l0', '[ext:x] l1', '[ext:x] l2']);
    expect(warn).toEqual(['[ext:x] output suppressed']);
    expect(seen).toHaveLength(6);
    advance(1_000);
    forwarder.line('fresh', 'stdout');
    expect(info.at(-1)).toBe('[ext:x] fresh');
  });

  // Purpose: a very long line is cut, never logged whole.
  it('cuts very long lines', () => {
    const { forwarder, info } = setup(10);
    forwarder.line('a'.repeat(10_000), 'stdout');
    expect(info[0]!.length).toBeLessThan(4_100);
  });
});
