/**
 * The three edits an agent can make to its own memory, as pure text
 * transformations. No filesystem, no locking, no cap — `store.ts` owns all
 * three, so everything here is directly testable on a string.
 *
 * @module memory/ops
 */
import {
  MemoryMatchError,
  type MemoryProvenance,
  type MemoryWriteOp,
} from '@dorkos/shared/memory-provider';

import { renderProvenanceSuffix } from './provenance.js';

/** How many near matches a refusal offers. Enough to choose from, few enough to read. */
const NEAR_MATCH_LIMIT = 3;

/** How much of a long line a near match shows before it is cut short. */
const NEAR_MATCH_MAX_CHARS = 120;

/**
 * Apply one write to the current memory text and return the new text.
 *
 * @param content - The memory as it stands.
 * @param op - The change to make.
 * @throws {MemoryMatchError} When a `replace` or `remove` does not name exactly
 *   one place in `content`.
 */
export function applyMemoryOp(content: string, op: MemoryWriteOp): string {
  switch (op.action) {
    case 'add':
      return appendNote(content, op.text, op.provenance);
    case 'replace': {
      const at = findUnique(content, op.oldText);
      return normalizeTail(content.slice(0, at) + op.text + content.slice(at + op.oldText.length));
    }
    case 'remove': {
      const at = findUnique(content, op.oldText);
      return removeLinesSpanning(content, at, at + op.oldText.length);
    }
  }
}

/**
 * Append a note to the end of the memory, with its provenance suffix.
 *
 * The note lands at the **end of the file**, not under a heading the engine goes
 * looking for. An agent's memory is a file a person may have reorganised — moved
 * the notes section, added their own headings — and an engine that hunted for a
 * heading would either fail on those files or silently invent one. The scaffold
 * puts its `## Notes` heading last precisely so "the end" and "under Notes" are
 * the same place in an unedited file.
 *
 * @param content - The memory as it stands.
 * @param text - The note, in the agent's own words. Written verbatim, newlines
 *   and all, so unicode round-trips exactly.
 * @param provenance - Where it was learned. Omitted only by a caller with no
 *   turn context.
 */
function appendNote(content: string, text: string, provenance?: MemoryProvenance): string {
  const suffix = provenance ? ` ${renderProvenanceSuffix(provenance)}` : '';
  const base = normalizeTail(content);
  return `${base}- ${text.trim()}${suffix}\n`;
}

/**
 * Find the one place `needle` appears in `content`.
 *
 * @param content - The memory to search.
 * @param needle - The text that must appear exactly once.
 * @throws {MemoryMatchError} When it appears twice or not at all — with the
 *   lines that came closest, so the caller can correct itself instead of
 *   guessing again next turn.
 */
function findUnique(content: string, needle: string): number {
  const first = content.indexOf(needle);
  if (first === -1) {
    throw new MemoryMatchError('not-found', needle, nearestLines(content, needle));
  }
  if (content.indexOf(needle, first + 1) !== -1) {
    throw new MemoryMatchError('ambiguous', needle, linesContaining(content, needle));
  }
  return first;
}

/**
 * Remove every line the span `[start, end)` touches.
 *
 * Removing only the matched characters would leave the rest of the line behind —
 * a dangling `- ` bullet, or half a sentence that now says something nobody
 * wrote. Forgetting a note means the note is gone, so the unit of removal is the
 * line.
 *
 * @param content - The memory as it stands.
 * @param start - Index of the first matched character.
 * @param end - Index just past the last matched character.
 */
function removeLinesSpanning(content: string, start: number, end: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(start - 1, 0)) + 1;
  const newlineAfter = content.indexOf('\n', end);
  const cutTo = newlineAfter === -1 ? content.length : newlineAfter + 1;

  const head = content.slice(0, lineStart);
  const tail = content.slice(cutTo);

  // The removed line usually sat between two blank lines; keeping both would
  // leave a widening hole every time something is forgotten. Collapse only this
  // seam — reflowing the whole file would rewrite formatting the operator chose.
  const joined =
    head.endsWith('\n\n') && tail.startsWith('\n') ? head + tail.slice(1) : head + tail;

  return normalizeTail(joined);
}

/** Every line that literally contains `needle`, shortened for display. */
function linesContaining(content: string, needle: string): string[] {
  return contentLines(content)
    .filter((line) => line.includes(needle))
    .slice(0, NEAR_MATCH_LIMIT)
    .map(shorten);
}

/**
 * The lines that most resemble `needle`, best first.
 *
 * Scoring is deliberately crude — how many of the needle's words the line
 * contains — because its job is to jog a caller toward the right quote, not to
 * rank search results. A line that shares nothing is never offered: an
 * unrelated suggestion is worse than none, since a model may quote it back.
 *
 * @param content - The memory to search.
 * @param needle - The text that matched nothing.
 */
function nearestLines(content: string, needle: string): string[] {
  const words = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  const terms = words.length > 0 ? words : needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return contentLines(content)
    .map((line) => {
      const haystack = line.toLowerCase();
      return { line, score: terms.filter((term) => haystack.includes(term)).length };
    })
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, NEAR_MATCH_LIMIT)
    .map((scored) => shorten(scored.line));
}

/**
 * The lines a near match may be drawn from: the notes themselves.
 *
 * The scaffold header is skipped, and so is anything else inside an HTML
 * comment. Offering the header's own prose back as a "closest line" would send a
 * caller quoting the instructions instead of the note it meant.
 */
function contentLines(content: string): string[] {
  const lines: string[] = [];
  let inComment = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    lines.push(line);
  }
  return lines;
}

/** Cut a long line down so a refusal stays readable. */
function shorten(line: string): string {
  return line.length <= NEAR_MATCH_MAX_CHARS ? line : `${line.slice(0, NEAR_MATCH_MAX_CHARS)}…`;
}

/**
 * End the file with exactly one newline and no trailing blank lines — or with
 * nothing at all, when everything in it has been forgotten.
 */
function normalizeTail(content: string): string {
  const trimmed = content.replace(/\s+$/u, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}
