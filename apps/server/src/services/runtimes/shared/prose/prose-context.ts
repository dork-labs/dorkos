/**
 * The context kinds whose body is PROSE, written by one shared writer each so
 * they read the same on every runtime: a person's staged note, a caller's seed,
 * a late approval verdict, a Direct chat's notes, and the note that DorkOS (not a
 * person) stopped the last turn. Most carry a defused-tag or fenced security
 * seam, and a seam written once per runtime is
 * one that holds in one place and leaks in the others.
 *
 * @module server/services/runtimes/shared/prose/prose-context
 */
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { formatApprovalVerdict } from '../approval-verdict-block.js';
import { formatDirectNotes } from './direct-notes-block.js';
import { formatSeedContext } from '../seed-context-block.js';
import { formatStagedContext } from '../staged-context-block.js';
import { formatTurnCutoff } from '../../../session/turn-cutoff/turn-cutoff.js';

/** An entry whose body one of the shared prose writers renders. */
export type ProseContextEntry = Extract<
  AdditionalContextEntry,
  { kind: 'staged_context' | 'seed_context' | 'approval_verdict' | 'direct_notes' | 'turn_cutoff' }
>;

/**
 * Render the body of a prose context entry.
 *
 * @param entry - The entry.
 * @returns The block body; the adapter wraps it in its tag.
 */
export function formatProseContext(entry: ProseContextEntry): string {
  switch (entry.kind) {
    case 'staged_context':
      return formatStagedContext(entry.data);
    case 'seed_context':
      return formatSeedContext(entry.data);
    case 'approval_verdict':
      return formatApprovalVerdict(entry.data);
    case 'direct_notes':
      return formatDirectNotes(entry.data);
    case 'turn_cutoff':
      return formatTurnCutoff(entry.data);
  }
}
