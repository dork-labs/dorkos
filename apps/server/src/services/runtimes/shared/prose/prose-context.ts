/**
 * The context kinds rendered as shared prose so they read the same on every
 * runtime. They cover structured environment and routing facts, a person's
 * staged or seeded note, approval and Direct-chat context, and DorkOS lifecycle
 * notes. Most carry a defused-tag or fenced security seam, and a seam written
 * once per runtime is one that holds in one place and leaks in the others.
 *
 * @module server/services/runtimes/shared/prose/prose-context
 */
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { formatApprovalVerdict } from '../approval-verdict-block.js';
import { formatDirectNotes } from './direct-notes-block.js';
import { formatSeedContext } from '../seed-context-block.js';
import { formatStagedContext } from '../staged-context-block.js';
import { formatTurnCutoff } from '../../../session/turn-cutoff/turn-cutoff.js';
import { formatNewSince } from './new-since-block.js';
import {
  formatEnv,
  formatGitStatus,
  formatRelayContext,
  QUEUE_NOTE_TEXT,
} from './context-entry.js';

/** Wrap one body in the context tag used by transcript stripping. */
export function wrapContextTag(tag: string, inner: string): string {
  return `<${tag}>\n${inner}\n</${tag}>`;
}

/** An additional-context entry rendered by the shared prose dispatch. */
export type ProseContextEntry = Extract<
  AdditionalContextEntry,
  {
    kind:
      | 'git_status'
      | 'env'
      | 'relay_context'
      | 'queue_note'
      | 'staged_context'
      | 'seed_context'
      | 'approval_verdict'
      | 'direct_notes'
      | 'turn_cutoff'
      | 'new_since_last_run';
  }
>;

/**
 * Render the body of a prose context entry.
 *
 * @param entry - The entry.
 * @returns The block body; the adapter wraps it in its tag.
 */
export function formatProseContext(entry: ProseContextEntry): string {
  switch (entry.kind) {
    case 'git_status':
      return formatGitStatus(entry.data);
    case 'env':
      return formatEnv(entry.data);
    case 'relay_context':
      return formatRelayContext(entry.data);
    case 'queue_note':
      return QUEUE_NOTE_TEXT;
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
    case 'new_since_last_run':
      return formatNewSince(entry.data);
  }
}

/**
 * Render a complete tagged block for an entry handled by the shared prose dispatch.
 *
 * Queue notes retain their compact one-line wire form; every other prose kind
 * uses the standard multiline context wrapper.
 *
 * @param entry - The prose entry to render.
 * @returns The complete context block, including its shared tag.
 */
export function renderProseContextBlock(entry: ProseContextEntry): string {
  const tag = CONTEXT_TAG[entry.kind];
  const body = formatProseContext(entry);
  return entry.kind === 'queue_note' ? `<${tag}>${body}</${tag}>` : wrapContextTag(tag, body);
}
