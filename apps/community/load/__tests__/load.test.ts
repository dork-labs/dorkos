import { describe, expect, it } from 'vitest';
import { parseLoadArgs, UsageError } from '../args.js';
import { LatencyHistogram } from '../histogram.js';
import { parseMetrics } from '../metrics.js';
import { summarizeReaders, verdictFor } from '../report.js';
import { parseTimedPost, takeFrames } from '../sse.js';
import { scheduledPostCount } from '../writer.js';

// Purpose: the load script's numbers are only as honest as the arithmetic behind them. These
// fail if a percentile drifts more than its 5% bucket from the truth, if a frame split across
// network chunks is lost or double-counted, if another run's posts count as this run's
// deliveries, if a stream that stayed open but missed posts is not reported, or if a non-local
// target stops needing the explicit production flag.
describe('LatencyHistogram', () => {
  it('estimates percentiles within one bucket of the exact value', () => {
    const histogram = new LatencyHistogram();
    for (let ms = 1; ms <= 1_000; ms += 1) histogram.record(ms);
    const { p50Ms, p95Ms, p99Ms, minMs, maxMs, count } = histogram.summary();
    expect(count).toBe(1_000);
    expect(minMs).toBe(1);
    expect(maxMs).toBe(1_000);
    expect(p50Ms! / 500).toBeCloseTo(1, 1);
    expect(Math.abs(p95Ms! - 950) / 950).toBeLessThan(0.05);
    expect(Math.abs(p99Ms! - 990) / 990).toBeLessThan(0.05);
  });

  it('is empty until it records, and never reports past its largest sample', () => {
    const histogram = new LatencyHistogram();
    expect(histogram.percentile(95)).toBeNull();
    histogram.record(42);
    expect(histogram.percentile(99)).toBe(42);
    histogram.record(-5);
    expect(histogram.summary().minMs).toBe(0);
  });
});

describe('takeFrames', () => {
  const entry = (text: string) =>
    `id: c1\nevent: entry\ndata: ${JSON.stringify({ type: 'entry', entry: { text } })}\n\n`;

  it('keeps a frame split across chunks until it is whole', () => {
    const whole = entry('hello');
    const first = takeFrames(whole.slice(0, 20));
    expect(first.frames).toHaveLength(0);
    const second = takeFrames(first.rest + whole.slice(20));
    expect(second.frames).toEqual([
      { type: 'entry', data: { type: 'entry', entry: { text: 'hello' } } },
    ]);
    expect(second.rest).toBe('');
  });

  it('skips heartbeats and unparseable frames', () => {
    const { frames } = takeFrames(`: keepalive\n\nevent: entry\ndata: {oops\n\n${entry('ok')}`);
    expect(frames).toHaveLength(1);
  });
});

describe('parseTimedPost', () => {
  it('reads only this run’s markers', () => {
    expect(parseTimedPost(JSON.stringify({ r: 'abc', n: 3, t: 12.5 }), 'abc')).toEqual({
      r: 'abc',
      n: 3,
      t: 12.5,
    });
    expect(parseTimedPost(JSON.stringify({ r: 'other', n: 3, t: 1 }), 'abc')).toBeNull();
    expect(parseTimedPost('just a message', 'abc')).toBeNull();
  });
});

describe('summarizeReaders', () => {
  it('counts drops, refusals and missed deliveries separately', () => {
    const summary = summarizeReaders(
      [
        { opened: true, openMs: 5, endedEarly: false, received: 10 },
        { opened: true, openMs: 7, endedEarly: false, received: 8 },
        { opened: true, openMs: 6, endedEarly: true, closeReason: 'revoked', received: 2 },
        { opened: false, status: 503, endedEarly: false, received: 0 },
        // Opened after posting began: reported as late, and its misses are not losses.
        { opened: true, openMs: 900, openedAt: 2_000, endedEarly: false, received: 1 },
      ],
      10,
      1_000
    );
    expect(summary).toMatchObject({
      opened: 4,
      openFailed: 1,
      openFailedBy: { 'HTTP 503': 1 },
      openedLate: 1,
      endedEarly: 1,
      closeReasons: { revoked: 1 },
      missedDeliveries: 2,
    });
  });
});

describe('verdictFor', () => {
  const clean = {
    delivery: new LatencyHistogram().summary(),
    writerStats: { attempted: 10, succeeded: 10 },
    readers: { openFailed: 0, openedLate: 0, endedEarly: 0, missedDeliveries: 0 },
    generatorSaturated: false,
  };
  const delivered = (ms: number) => {
    const histogram = new LatencyHistogram();
    for (let i = 0; i < 100; i += 1) histogram.record(ms);
    return histogram.summary();
  };

  it('meets D12 only with p95 under a second and nothing lost', () => {
    expect(verdictFor({ ...clean, delivery: delivered(200) })).toBe('met');
    expect(verdictFor({ ...clean, delivery: delivered(1_500) })).toBe('not met');
    expect(verdictFor(clean)).toBe('not met');
    expect(
      verdictFor({
        ...clean,
        delivery: delivered(200),
        readers: { ...clean.readers, missedDeliveries: 1 },
      })
    ).toBe('not met');
    expect(
      verdictFor({
        ...clean,
        delivery: delivered(200),
        writerStats: { attempted: 10, succeeded: 9 },
      })
    ).toBe('not met');
  });

  it('calls a miss inconclusive when the load machine was saturated, never a pass', () => {
    expect(verdictFor({ ...clean, delivery: delivered(1_500), generatorSaturated: true })).toBe(
      'inconclusive'
    );
    expect(verdictFor({ ...clean, delivery: delivered(200), generatorSaturated: true })).toBe(
      'met'
    );
  });
});

describe('LatencyHistogram.merge', () => {
  it('adds another histogram, as a reader thread hands it over', () => {
    const a = new LatencyHistogram();
    const b = new LatencyHistogram();
    a.record(10);
    b.record(500);
    b.record(20);
    a.merge(structuredClone(b.toData()));
    a.merge(new LatencyHistogram().toData());
    expect(a.summary()).toMatchObject({ count: 3, minMs: 10, maxMs: 500 });
  });
});

describe('parseMetrics', () => {
  it('reads the totals, never a labelled per-community line', () => {
    const snapshot = parseMetrics(
      [
        'community_live_streams_by_community{community_id="x"} 7',
        'community_live_streams 12',
        'community_live_streams_refused_total{limit="host"} 3',
        'community_db_pool_waiting 0',
      ].join('\n')
    );
    expect(snapshot.openStreams).toBe(12);
    expect(snapshot.refusedHost).toBe(3);
    expect(snapshot.refusedMember).toBeNull();
  });
});

describe('parseLoadArgs', () => {
  it('runs against a local target', () => {
    for (const url of ['http://localhost:6481', 'http://127.0.0.1:6481/', 'http://[::1]:6481']) {
      expect(parseLoadArgs(['--url', url]).url).toBe(url.replace(/\/$/, ''));
    }
  });

  it('refuses a real host without the production flag', () => {
    expect(() => parseLoadArgs(['--url', 'https://community.example.com'])).toThrow(UsageError);
    expect(
      parseLoadArgs(['--url', 'https://community.example.com', '--i-understand-this-is-production'])
        .url
    ).toBe('https://community.example.com');
  });

  it('warns when one writer would hit the default posting limit', () => {
    const args = parseLoadArgs(['--url', 'http://localhost:1', '--writers', '1', '--rate', '50']);
    expect(args.warnings.join(' ')).toMatch(/429/);
    expect(parseLoadArgs(['--url', 'http://localhost:1']).warnings).toEqual([]);
  });

  it('refuses a quiet window shorter than two progress reports', () => {
    expect(() => parseLoadArgs(['--url', 'http://localhost:1', '--quiet-ms', '500'])).toThrow(
      /--quiet-ms/
    );
  });

  it('asks for help with exit code 0', () => {
    try {
      parseLoadArgs(['--help']);
      expect.unreachable();
    } catch (error) {
      expect((error as UsageError).isHelp).toBe(true);
    }
  });
});

describe('scheduledPostCount', () => {
  it('schedules rate × duration posts', () => {
    expect(scheduledPostCount(50, 60_000)).toBe(3_000);
    expect(scheduledPostCount(0, 60_000)).toBe(0);
  });
});
