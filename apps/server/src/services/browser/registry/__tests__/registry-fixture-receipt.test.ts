import { closeSync, openSync, writeSync } from 'node:fs';
import { devNull } from 'node:os';
import { describe, expect, it } from 'vitest';
import { emitRegistryFixtureReceipt } from './registry-fixture-receipt.js';
function withReadOnlyOutput<T>(run: (write: (line: string) => number) => T): T {
  const fd = openSync(devNull, 'r');
  try {
    return run((line) => writeSync(fd, line));
  } finally {
    closeSync(fd);
  }
}
describe('registry diagnostic receipt preserves primary failure', () => {
  it.each([undefined, null, false, 0, ''])(
    'preserves an existing falsy primary %s on actual refused descriptor write',
    (first) => {
      const result = withReadOnlyOutput((write) =>
        emitRegistryFixtureReceipt(
          { failed: true, first },
          () => '{"fixture":"receipt-control"}\n',
          write
        )
      );
      expect(result).toEqual({ failed: true, first, emitted: false });
      expect(result.first).toBe(first);
    }
  );
  it('makes actual descriptor output failure primary only when no earlier failure exists', () => {
    const result = withReadOnlyOutput((write) =>
      emitRegistryFixtureReceipt(
        { failed: false, first: undefined },
        () => '{"fixture":"receipt-control"}\n',
        write
      )
    );
    expect(result).toMatchObject({ failed: true, emitted: false });
    expect(result.first).toMatchObject({ code: 'EBADF', syscall: 'write' });
  });
  it('preserves original error identity through serialization failure and never enters output', () => {
    const first = new Error('PRIMARY_FIXTURE_FAILURE');
    let writes = 0;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const result = emitRegistryFixtureReceipt(
      { failed: true, first },
      () => JSON.stringify(circular),
      () => {
        writes++;
        return 0;
      }
    );
    expect(result.first).toBe(first);
    expect(result.emitted).toBe(false);
    expect(writes).toBe(0);
  });
  it('retains a single partial output attempt, and refuses oversize rows before any output', () => {
    let writes = 0;
    const partial = emitRegistryFixtureReceipt(
      { failed: false, first: undefined },
      () => 'fixed-row\n',
      () => {
        writes++;
        return 1;
      }
    );
    expect(partial).toMatchObject({ failed: true, emitted: false });
    expect(writes).toBe(1);
    const oversize = emitRegistryFixtureReceipt(
      { failed: false, first: undefined },
      () => 'x'.repeat(2049),
      () => {
        writes++;
        return 2049;
      }
    );
    expect(oversize).toMatchObject({ failed: true, emitted: false });
    expect(writes).toBe(1);
  });
  it('emits one complete row without replacing an existing primary', () => {
    let writes = 0;
    const first = new Error('PRIMARY');
    const result = emitRegistryFixtureReceipt(
      { failed: true, first },
      () => 'fixed-row\n',
      (line) => {
        writes++;
        return Buffer.byteLength(line);
      }
    );
    expect(result).toEqual({ failed: true, first, emitted: true });
    expect(writes).toBe(1);
  });
});
