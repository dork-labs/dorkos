/**
 * `runs.chat_runs` (spec `turns-survive-restarts` §4.6, DOR-5212): a chat's
 * runs for integrations, served by the capability mount on
 * `GET /api/sessions/{id}/runs` (ADR 261123-170830). The same list the
 * session snapshot and every `run_update` carry, so a script reads what
 * every window shows: the live run, the waiting runs and, while nothing is
 * live, the run that ended last with its line.
 *
 * It names statuses and lines, never a turn's words. The session read guard
 * in front of every other `/api/sessions/:id/*` route never runs for a path
 * the mount serves, so it is folded in here: an agent caller gets the same
 * 404 for a chat it may not read as for one that does not exist.
 *
 * @module services/runs/run-capabilities
 */
import { z } from 'zod';
import { ChatRunsPageSchema, type ChatRunsPage } from '@dorkos/shared/run-schemas';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
  type CapabilityInvocationContext,
} from '../core/capabilities/index.js';
import { readerFor } from '../audit/audit-capabilities.js';
import { auditTrail } from '../audit/audit-trail.js';
import { readableSessionIds } from '../audit/session-visibility.js';
import { getRunRecord } from './index.js';

/** The most runs one page holds. */
export const CHAT_RUNS_PAGE_LIMIT = 200;

/** `runs.chat_runs`'s input: the chat, and where this page starts. */
const ChatRunsInputSchema = z.object({
  /** The chat, by its session id. */
  id: z.string().uuid(),
  /** The `nextCursor` of the page before; absent for the first page. */
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('The `nextCursor` of the page before; leave it out for the first page.'),
  /** How many runs this page holds at most. */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHAT_RUNS_PAGE_LIMIT)
    .default(50)
    .describe(`How many runs this page holds, 1 to ${CHAT_RUNS_PAGE_LIMIT}.`),
});

/**
 * One page of a chat's runs, oldest first, after `cursor` (a run's `chatSeq`).
 *
 * @param input - The chat, the cursor and the page size.
 * @param context - Who calls: an agent reads only a chat it may read.
 */
export function chatRunsPage(
  input: z.infer<typeof ChatRunsInputSchema>,
  context?: CapabilityInvocationContext
): ChatRunsPage {
  const reader = readerFor({ accounts: auditTrail()?.accounts }, context);
  if (!readableSessionIds(reader, [input.id]).has(input.id)) {
    throw new CapabilityToolError({ code: 'SESSION_NOT_FOUND', error: 'No chat with that id.' });
  }
  const record = getRunRecord();
  if (!record) {
    throw new CapabilityToolError({ code: 'NOT_READY', error: 'DorkOS is still starting.' });
  }
  // A gone boot's live run is retired first, as every reader of one does (§4.7).
  record.store.liveRunOf(input.id);
  const after = input.cursor === undefined ? 0 : Number(input.cursor);
  const rest = record.view(input.id).filter((run) => run.chatSeq > after);
  const runs = rest.slice(0, input.limit);
  const last = runs.at(-1);
  return {
    runs,
    nextCursor: rest.length > runs.length && last ? String(last.chatSeq) : null,
  };
}

/** The run record's domain: what integrations read of a chat's runs. */
export const runsDomain: CapabilityDomain = {
  name: 'runs',
  capabilities: [
    defineCapability({
      id: 'runs.chat_runs',
      title: 'List a chat’s runs',
      description:
        'A chat’s runs, from its run record: the live run, the runs waiting behind it with ' +
        'their place and why they wait, and, while nothing is live, the run that ended last, ' +
        'with how it ended and the line a person sees (`restart_stopped`: DorkOS restarted ' +
        'during that reply and nothing continues it). Oldest first; page with `limit` and ' +
        'the returned `nextCursor`. Statuses only, never what was said.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: ChatRunsInputSchema,
      output: ChatRunsPageSchema,
      surfaces: { http: { method: 'get', path: '/api/sessions/{id}/runs' } },
      invoke: async (_deps, input, context) => chatRunsPage(input, context),
    }),
  ],
};
