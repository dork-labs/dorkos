/**
 * Per-eval JSONL transcript: the prompt(s), every collected SSE frame in order,
 * and each oracle/rubric result with its evidence. A transcript is the audit
 * trail for one eval — CI attaches it as an artifact and a failure links to it.
 *
 * @module evals/report/transcript
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { OracleResult, RubricJudgeResult } from '../types.js';

/** One line in a transcript: a discriminated record (`kind`). */
export type TranscriptRecord =
  | { kind: 'meta'; runId: string; evalId: string; title: string; startedAt: string }
  | { kind: 'prompt'; index: number; content: string }
  | { kind: 'frame'; frame: SseFrame }
  | { kind: 'oracle'; result: OracleResult }
  | { kind: 'rubric'; result: RubricJudgeResult };

/** Everything one eval contributes to its transcript. */
export interface TranscriptInput {
  /** The run id (transcript directory name). */
  runId: string;
  /** The eval's stable id (transcript file name). */
  evalId: string;
  /** The eval's one-line title. */
  title: string;
  /** ISO timestamp the eval started. */
  startedAt: string;
  /** The prompt(s) sent, in order. */
  prompts: string[];
  /** Every SSE frame collected, in delivery order. */
  frames: SseFrame[];
  /** Per-oracle results. */
  oracleResults: OracleResult[];
  /** The rubric result, when the eval carried a rubric. */
  rubricResult?: RubricJudgeResult;
}

/** The JSONL path for one eval within a run directory. */
export function transcriptPath(runDir: string, evalId: string): string {
  return path.join(runDir, `${evalId}.jsonl`);
}

/** Flatten a {@link TranscriptInput} into its ordered transcript records. */
export function toRecords(input: TranscriptInput): TranscriptRecord[] {
  const records: TranscriptRecord[] = [
    {
      kind: 'meta',
      runId: input.runId,
      evalId: input.evalId,
      title: input.title,
      startedAt: input.startedAt,
    },
  ];
  input.prompts.forEach((content, index) => records.push({ kind: 'prompt', index, content }));
  input.frames.forEach((frame) => records.push({ kind: 'frame', frame }));
  input.oracleResults.forEach((result) => records.push({ kind: 'oracle', result }));
  if (input.rubricResult) records.push({ kind: 'rubric', result: input.rubricResult });
  return records;
}

/**
 * Write one eval's transcript as JSONL (one record per line) under the run
 * directory. Creates the directory if needed.
 *
 * @param runDir - The run's transcript directory.
 * @param input - The eval's transcript input.
 * @returns The absolute path written.
 */
export async function writeTranscript(runDir: string, input: TranscriptInput): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const file = transcriptPath(runDir, input.evalId);
  const lines = toRecords(input).map((r) => JSON.stringify(r));
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/** Read a JSONL transcript back into its ordered records. */
export async function readTranscript(file: string): Promise<TranscriptRecord[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptRecord);
}

/** Extract just the SSE frames from a set of transcript records (round-trip helper). */
export function framesFromRecords(records: TranscriptRecord[]): SseFrame[] {
  return records
    .filter((r): r is Extract<TranscriptRecord, { kind: 'frame' }> => r.kind === 'frame')
    .map((r) => r.frame);
}
