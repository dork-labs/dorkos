/**
 * The whole-file read of a transcript, for tests: every JSONL line through one
 * {@link createTranscriptParser}, as the history cache feeds it a chunk at a time.
 * Production reads through the parser itself, so this one-pass form lives here.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/parse-transcript
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import { createTranscriptParser, type TranscriptImageRef } from '../transcript-parser.js';

/**
 * Parse an array of JSONL lines into HistoryMessage objects in one pass.
 *
 * @param lines - The transcript's JSONL lines.
 * @param images - Collects every image a tool result carried, in transcript order.
 */
export function parseTranscript(lines: string[], images?: TranscriptImageRef[]): HistoryMessage[] {
  const parser = createTranscriptParser();
  for (const line of lines) parser.push(line, images);
  return parser.result();
}
