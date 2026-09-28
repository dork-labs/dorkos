import { Dir } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCodexTurnContextUsage, readCodexTurnReading } from '../turn-context-usage.js';

const THREAD_ID = '01a082ce-2b72-71d2-be38-aa8425f13650';
const THREAD_CREATED_AT = 1_788_900_944_754;
const TURN_STARTED_AT = Date.parse('2026-09-08T22:57:59.000Z');
const NOW = Date.parse('2026-09-08T22:58:06.000Z');
const homes: string[] = [];

function localDateParts(timestampMs: number): [string, string, string] {
  const date = new Date(timestampMs);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
}

function tokenCount(overrides: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-09-08T22:58:05.960Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 326_129, total_tokens: 326_270 },
        last_token_usage: {
          input_tokens: 54_992,
          cached_input_tokens: 48_512,
          output_tokens: 7,
          reasoning_output_tokens: 0,
          total_tokens: 54_999,
        },
        model_context_window: 258_400,
      },
    },
    ...overrides,
  };
}

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dorkos-codex-turn-usage-'));
  homes.push(home);
  return home;
}

async function writeRollout(
  home: string,
  records: readonly unknown[],
  location: 'live' | 'archive' = 'live',
  prefix = '',
  fileThreadId = THREAD_ID
): Promise<string> {
  const directory =
    location === 'archive'
      ? path.join(home, 'archived_sessions')
      : path.join(home, 'sessions', ...localDateParts(THREAD_CREATED_AT));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-08T15-55-44-${fileThreadId}.jsonl`);
  await writeFile(file, `${prefix}${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('readCodexTurnContextUsage', () => {
  it('reads Codex current context from last usage rather than cumulative session totals', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [
      { timestamp: '2026-09-08T22:58:05.900Z', type: 'response_item', payload: {} },
      tokenCount(),
      {
        timestamp: '2026-09-08T22:58:05.992Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      },
    ]);

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
      })
    ).resolves.toEqual({ contextTokens: 54_999, contextMaxTokens: 258_400 });
  });

  it('finds an archived rollout through the same bounded suffix lookup', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()], 'archive');

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
      })
    ).resolves.toEqual({ contextTokens: 54_999, contextMaxTokens: 258_400 });
  });

  it('does not read another thread from the same candidate date', async () => {
    const codexHome = await createHome();
    await writeRollout(
      codexHome,
      [tokenCount()],
      'live',
      '',
      '01a082ce-2b72-71d2-be38-aa8425f13651'
    );

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
      })
    ).resolves.toBeNull();
  });

  it('reads only a bounded tail and discards its first partial line', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()], 'live', `${'x'.repeat(8_192)}\n`);

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
        maxTailBytes: 1_024,
      })
    ).resolves.toEqual({ contextTokens: 54_999, contextMaxTokens: 258_400 });
  });

  it('does not fall back to an earlier inference when the latest usage is invalid', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [
      tokenCount({ timestamp: '2026-09-08T22:58:02.000Z' }),
      tokenCount({
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 54_999 }, model_context_window: 0 },
        },
      }),
    ]);

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
      })
    ).resolves.toBeNull();
  });

  it.each([
    ['does not encode a bounded UUIDv7 timestamp', 'codex-thread-1', tokenCount()],
    [
      'contains only a prior turn measurement',
      THREAD_ID,
      tokenCount({ timestamp: '2026-09-08T22:57:58.000Z' }),
    ],
    [
      'contains malformed latest native usage',
      THREAD_ID,
      tokenCount({
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 54_999 }, model_context_window: 0 },
        },
      }),
    ],
  ])('returns no reading when the thread %s', async (_name, threadId, record) => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [record]);

    await expect(
      readCodexTurnContextUsage({
        threadId,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
      })
    ).resolves.toBeNull();
  });

  it('uses a valid live rollout without scanning an over-bound archive', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()]);
    const archive = path.join(codexHome, 'archived_sessions');
    await mkdir(archive, { recursive: true });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(path.join(archive, `rollout-old-${index}.jsonl`), '{}\n')
      )
    );

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
        maxDirectoryEntries: 1,
      })
    ).resolves.toEqual({ contextTokens: 54_999, contextMaxTokens: 258_400 });
  });

  it('stops after the configured directory-entry bound', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()]);
    const directoryReads = vi.spyOn(Dir.prototype, 'read');

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
        maxDirectoryEntries: 0,
      })
    ).resolves.toBeNull();
    expect(directoryReads).toHaveBeenCalledTimes(1);
  });

  it('closes a directory handle when its pending read reaches the deadline', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()]);
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    vi.spyOn(Dir.prototype, 'read').mockImplementationOnce(() => {
      markReadStarted();
      return new Promise(() => {});
    });
    const directoryCloses = vi.spyOn(Dir.prototype, 'close');

    const reading = readCodexTurnContextUsage({
      threadId: THREAD_ID,
      turnStartedAtMs: TURN_STARTED_AT,
      codexHome,
      now: NOW,
      timeoutMs: 50,
    });
    await readStarted;

    await expect(reading).resolves.toBeNull();
    expect(directoryCloses).toHaveBeenCalled();
  });

  it('closes a file handle when its pending read reaches the deadline', async () => {
    const codexHome = await createHome();
    const rollout = await writeRollout(codexHome, [tokenCount()]);
    const probe = await open(rollout, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
      close: typeof probe.close;
    };
    await probe.close();
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let fileWasClosed = false;
    vi.spyOn(fileHandlePrototype, 'read').mockImplementationOnce(function (this: typeof probe) {
      const close = this.close.bind(this);
      this.close = async () => {
        fileWasClosed = true;
        await close();
      };
      markReadStarted();
      return new Promise(() => {});
    });

    const reading = readCodexTurnContextUsage({
      threadId: THREAD_ID,
      turnStartedAtMs: TURN_STARTED_AT,
      codexHome,
      now: NOW,
      timeoutMs: 50,
    });
    await readStarted;

    await expect(reading).resolves.toBeNull();
    expect(fileWasClosed).toBe(true);
  });
});

/** A `rate_limits` payload as a real rollout line carries it (redacted, 2026-09-10). */
function rateLimits(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 25.0, window_minutes: 10080, resets_at: 1789663865 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: 'pro',
    rate_limit_reached_type: null,
    ...overrides,
  };
}

function tokenCountWithLimits(
  limits: Record<string, unknown> | null,
  timestamp = '2026-09-08T22:58:05.960Z'
): unknown {
  const record = tokenCount({ timestamp }) as { payload: Record<string, unknown> };
  return {
    ...record,
    payload: { ...record.payload, ...(limits ? { rate_limits: limits } : {}) },
  };
}

describe('readCodexTurnReading', () => {
  const read = (codexHome: string) =>
    readCodexTurnReading({
      threadId: THREAD_ID,
      turnStartedAtMs: TURN_STARTED_AT,
      codexHome,
      now: NOW,
    });

  it('reads the rate limits from the same token_count record as the context', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCountWithLimits(rateLimits())]);

    const reading = await read(codexHome);
    expect(reading?.context).toEqual({ contextTokens: 54_999, contextMaxTokens: 258_400 });
    expect(reading?.rateLimits).toEqual([rateLimits()]);
  });

  it('keeps the newest record of each limit, so a model limit written last never hides the main one', async () => {
    const codexHome = await createHome();
    const older = rateLimits({
      primary: { used_percent: 20, window_minutes: 10080, resets_at: 1789663865 },
    });
    const spark = rateLimits({ limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark' });
    await writeRollout(codexHome, [
      tokenCountWithLimits(older, '2026-09-08T22:58:01.000Z'),
      tokenCountWithLimits(rateLimits(), '2026-09-08T22:58:03.000Z'),
      tokenCountWithLimits(spark, '2026-09-08T22:58:05.960Z'),
    ]);

    const reading = await read(codexHome);
    expect(reading?.rateLimits).toEqual([rateLimits(), spark]);
  });

  it('treats a record with no limit_id as the main limit, the same one as "codex"', async () => {
    const codexHome = await createHome();
    const unnamed = rateLimits({ limit_id: undefined });
    delete unnamed.limit_id;
    await writeRollout(codexHome, [
      tokenCountWithLimits(unnamed, '2026-09-08T22:58:01.000Z'),
      tokenCountWithLimits(rateLimits(), '2026-09-08T22:58:05.960Z'),
    ]);
    expect((await read(codexHome))?.rateLimits).toEqual([rateLimits()]);
  });

  it('ignores a record written before this turn started', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [
      tokenCountWithLimits(rateLimits(), '2026-09-08T22:57:00.000Z'),
      tokenCountWithLimits(null),
    ]);
    expect((await read(codexHome))?.rateLimits).toEqual([]);
  });

  it("turns an older build's resets_in_seconds into resets_at from the record's own time", async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [
      tokenCountWithLimits({
        primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 600 },
        secondary: { used_percent: 30, window_minutes: 10080, resets_in_seconds: 3600 },
      }),
    ]);
    const recordedAtSeconds = Date.parse('2026-09-08T22:58:05.960Z') / 1000;
    const [limits] = (await read(codexHome))!.rateLimits;
    expect(limits).toMatchObject({
      primary: { resets_at: Math.round(recordedAtSeconds + 600) },
      secondary: { resets_at: Math.round(recordedAtSeconds + 3600) },
    });
  });

  it('reads no rate limits from a record without them, and the context as before', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [tokenCount()]);
    const reading = await read(codexHome);
    expect(reading).toEqual({
      context: { contextTokens: 54_999, contextMaxTokens: 258_400 },
      rateLimits: [],
    });
  });

  it('keeps the rate limits when the context part of the record does not verify', async () => {
    const codexHome = await createHome();
    await writeRollout(codexHome, [
      {
        ...(tokenCountWithLimits(rateLimits()) as object),
        payload: { type: 'token_count', info: null, rate_limits: rateLimits() },
      },
    ]);
    const reading = await read(codexHome);
    expect(reading).toEqual({ context: null, rateLimits: [rateLimits()] });
  });
});
