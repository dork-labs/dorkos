/**
 * Transcript: a frame sequence round-trips to JSONL and back unchanged, and the
 * transcript captures prompts + oracle results alongside the frames.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SseFrame } from '@dorkos/test-utils';
import {
  writeTranscript,
  readTranscript,
  framesFromRecords,
  toRecords,
  type TranscriptInput,
} from '../transcript.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const frames: SseFrame[] = [
  { id: 's-0', event: 'snapshot', data: { cursor: 0 } },
  { event: 'turn_start', data: { type: 'turn_start', seq: 1 } },
  { event: 'text_delta', data: { type: 'text_delta', seq: 2, text: 'Hi' } },
  { event: 'turn_end', data: { type: 'turn_end', seq: 3 } },
];

function input(): TranscriptInput {
  return {
    runId: 'run-1',
    evalId: 'widget-round-trip',
    title: 'Widget round trip',
    startedAt: '2026-07-18T00:00:00.000Z',
    prompts: ['Open the tasks panel.'],
    frames,
    oracleResults: [{ label: 'health 200', passed: true, evidence: { status: 200 } }],
  };
}

describe('transcript', () => {
  it('round-trips a frame sequence to JSONL and back unchanged', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evals-tx-'));
    const file = await writeTranscript(dir, input());
    const records = await readTranscript(file);
    expect(framesFromRecords(records)).toEqual(frames);
  });

  it('captures meta, prompts, frames, and oracle results as ordered records', async () => {
    const records = toRecords(input());
    expect(records[0]).toMatchObject({ kind: 'meta', evalId: 'widget-round-trip' });
    expect(records.filter((r) => r.kind === 'prompt')).toHaveLength(1);
    expect(records.filter((r) => r.kind === 'frame')).toHaveLength(4);
    expect(records.filter((r) => r.kind === 'oracle')).toHaveLength(1);
  });
});
