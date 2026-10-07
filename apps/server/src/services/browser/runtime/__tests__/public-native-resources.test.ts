import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import {
  parseCounters,
  requireOriginalCounterEOF,
  resourceInterval,
  resourceReport,
} from './public-native-resources.js';
const node = { pid: 101, birth: 'original-node' },
  descendant = { pid: 102, birth: 'original-child' };
const sample = (time: number, cpu: number) => ({
  host: {
    monotonicMilliseconds: time,
    timestamp: '2026-10-06T00:00:00Z',
    freeBytes: 1000,
    totalBytes: 4000,
    loadAverage: [1, 2, 3],
    logicalCores: 2,
    idleMilliseconds: time,
    totalMilliseconds: time * 2,
  },
  counterWindow: { startMilliseconds: time - 5, endMilliseconds: time + 5 },
  identities: [node, descendant],
  counters: [
    { pid: 101, rssBytes: 2048, cpuMilliseconds: cpu },
    { pid: 102, rssBytes: 4096, cpuMilliseconds: cpu * 2 },
  ],
});
describe('private resource observation integrity', () => {
  it('parses cumulative time and RSS only for the complete known cohort', () => {
    expect(parseCounters('101 2 00:01.20\n102 4 1-02:03:04\n', [node, descendant])).toEqual([
      { pid: 101, rssBytes: 2048, cpuMilliseconds: 1200 },
      { pid: 102, rssBytes: 4096, cpuMilliseconds: 93784000 },
    ]);
  });
  it('parses fractional milliseconds as exact integers and refuses unsupported precision', () => {
    expect(parseCounters('101 2 0:01.005\n', [node])[0]?.cpuMilliseconds).toBe(1005);
    expect(() => parseCounters('101 2 0:01.0005\n', [node])).toThrow('CPU_TIME_UNKNOWN');
  });
  it('requires both original readable end events and EOF, including premature pipe close', async () => {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    const ends = [false, false];
    stdout.once('end', () => {
      ends[0] = true;
    });
    stderr.once('end', () => {
      ends[1] = true;
    });
    stdout.resume();
    stderr.resume();
    const returned = [once(stdout, 'close'), once(stderr, 'close')];
    stdout.end('counter bytes');
    stderr.destroy(); // Original premature close cannot be healed by the other stream's EOF.
    await Promise.all(returned);
    expect(() => requireOriginalCounterEOF([stdout, stderr], ends)).toThrow(
      'COUNTER_PIPE_EOF_REQUIRED'
    );
    const complete = [new PassThrough(), new PassThrough()];
    const completeEnds = [false, false];
    const closed = complete.map((pipe, index) => {
      pipe.once('end', () => {
        completeEnds[index] = true;
      });
      pipe.resume();
      const close = once(pipe, 'close');
      pipe.end();
      return close;
    });
    await Promise.all(closed);
    expect(() => requireOriginalCounterEOF(complete, completeEnds)).not.toThrow();
    expect(() => requireOriginalCounterEOF(complete, [true, false])).toThrow(
      'COUNTER_PIPE_EOF_REQUIRED'
    );
  });
  it('rejects a root-only counter mutant instead of silently dropping a child', () => {
    expect(() => parseCounters('101 2 00:01.20\n', [node, descendant])).toThrow(
      'COMPLETE_TREE_COUNTERS_REQUIRED'
    );
  });
  it('rejects unrelated or duplicate PID rows and unknown clock counters', () => {
    expect(() => parseCounters('101 2 00:00\n999 2 00:00\n', [node, descendant])).toThrow(
      'COMPLETE_TREE_COUNTERS_REQUIRED'
    );
    expect(() => parseCounters('101 2 00:00\n101 2 00:00\n', [node, descendant])).toThrow(
      'COMPLETE_TREE_COUNTERS_REQUIRED'
    );
    expect(() => parseCounters('101 2 00:99\n102 2 00:00\n', [node, descendant])).toThrow(
      'CPU_TIME_UNKNOWN'
    );
  });
  it('rejects same PID with a replacement birth and regressing CPU', () => {
    const replacement = sample(2000, 100);
    replacement.identities[1] = { ...descendant, birth: 'replacement-child' };
    expect(() => resourceInterval(sample(1000, 10), replacement, node, [node])).toThrow(
      'INTERVAL_COHORT_CHANGED'
    );
    expect(() => resourceInterval(sample(1000, 10), sample(2000, 1), node, [node])).toThrow(
      'CPU_COUNTER_REGRESSED'
    );
  });
  it('does not turn positive counters into per-browser ownership, frontend proof, or extra slots', () => {
    const before = sample(1000, 10),
      after = sample(2000, 30);
    const interval = resourceInterval(before, after, node, [node]);
    expect(interval.node.cpuPercentOneCore).toBe(2);
    expect(interval.additionalNativeCohort.rssBytes).toBe(4096);
    const report = resourceReport(before, interval, interval, {
      bytes: 2000,
      frames: 2,
    });
    expect(report.status).toBe('UNVERIFIED');
    expect(report.headroom.additionalSlotsAdmitted).toBe(0);
    expect(report.availability.frontend).toContain('unavailable');
    expect(report.wire.renderedFrontendReceipt).toBe(false);
  });
});
