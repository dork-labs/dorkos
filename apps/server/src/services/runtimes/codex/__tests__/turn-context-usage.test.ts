import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexTurnContextUsage } from '../turn-context-usage.js';

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
  prefix = ''
): Promise<string> {
  const directory =
    location === 'archive'
      ? path.join(home, 'archived_sessions')
      : path.join(home, 'sessions', ...localDateParts(THREAD_CREATED_AT));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-08T15-55-44-${THREAD_ID}.jsonl`);
  await writeFile(file, `${prefix}${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

afterEach(async () => {
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

    await expect(
      readCodexTurnContextUsage({
        threadId: THREAD_ID,
        turnStartedAtMs: TURN_STARTED_AT,
        codexHome,
        now: NOW,
        maxDirectoryEntries: 0,
      })
    ).resolves.toBeNull();
  });
});
