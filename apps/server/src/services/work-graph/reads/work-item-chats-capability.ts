/**
 * `work-graph.work_item_chats` (DOR-4972): who worked on a ticket or pull
 * request, and when. Tool `work_item_chats` on both MCP servers; path
 * `GET /api/work-items/chats?ref=DOR-1234` on the capability mount.
 *
 * **Who reads as the owner.** The audit read side's `readerFor` reads a call
 * with no agent as the owner. This read is stricter (Security, DOR-4972): a
 * caller nobody named (the external MCP server, `dorkos call` with no key)
 * reads as an agent nobody could name, so it sees only what the space may.
 * Only a person (a session on a REST read, a signed-in person's key) or a
 * trusted caller reads as the owner.
 *
 * **Refs.** `ref` is a ticket (`DOR-1234`) or a pull request (`owner/repo#42`,
 * `PR #42`), in any case. Anything else is refused as invalid input. A valid
 * ref nobody claimed answers an empty page, never "not found", so the answer
 * says nothing about which refs exist.
 *
 * @module services/work-graph/reads/work-item-chats-capability
 */
import { z } from 'zod';
import { parseEntityRef, type EntityRef } from '@dorkos/shared/entity-ref';
import {
  WORK_ITEM_CHATS_PAGE_LIMIT,
  WorkItemChatsPageSchema,
  type WorkKind,
} from '@dorkos/shared/work-graph-reads';
import { defineCapability } from '../../core/capabilities/capability-definition.js';
import type { AuditReader } from '../../audit/visibility.js';
import {
  cursorInput,
  limitInput,
  READ_TOOL,
  requireAuditDeps,
  workGraphDb,
  type WorkGraphReadPorts,
} from './read-tool-parts.js';
import { readWorkItemChats } from './work-item-chats.js';

/** How a caller nobody named reads: as an agent nobody could name. */
const UNNAMED_READER: AuditReader = { kind: 'agent', accountId: 'unidentified' };

/** The longest ref this read takes: the work graph's own limit on a stored reference. */
const REF_MAX_LENGTH = 300;

/**
 * A ticket or pull request as a person may write it, or `null`: as given, then
 * upper-cased, so `dor-1234` and `pr #42` read as `DOR-1234` and `PR #42`.
 *
 * @param raw - The ref as sent.
 */
export function workRefOf(raw: string): EntityRef<WorkKind> | null {
  const text = raw.trim();
  for (const spelling of [text, text.toUpperCase()]) {
    const parsed = parseEntityRef(spelling);
    if (parsed.ok && (parsed.value.kind === 'ticket' || parsed.value.kind === 'pr')) {
      return { kind: parsed.value.kind, id: parsed.value.id };
    }
  }
  return null;
}

/**
 * The capability, over what the composition root passes in.
 *
 * @param ports - The audit read side's reader rule and the person check.
 */
export function workItemChatsCapability(ports: WorkGraphReadPorts) {
  return defineCapability({
    id: 'work-graph.work_item_chats',
    title: 'See who worked on a ticket or pull request',
    description:
      'The chats that claimed one ticket or pull request, and when, oldest first: each span ' +
      'with the chat, when it was claimed, when it ended and how (released, lapsed, handed ' +
      'over), or still held. Every agent’s chats are listed. A span of a chat you may not ' +
      'read carries only the days it began and ended. A hand-over’s time is visible to the ' +
      'space, and the chat that gave it never is. ref is a ticket (DOR-1234) or a pull ' +
      'request (owner/repo#42 or PR #42). Page with `limit` and the returned `nextCursor`; ' +
      'spans start and end between pages, so one can repeat or be missed while paging.',
    tier: 'observe',
    area: null,
    areaNote: 'reading',
    input: z.object({
      ref: z
        .string()
        .min(1)
        .max(REF_MAX_LENGTH)
        .refine((value) => workRefOf(value) !== null, {
          message: 'Name a ticket (DOR-1234) or a pull request (owner/repo#42 or PR #42).',
        })
        .describe('The ticket (DOR-1234) or pull request (owner/repo#42 or PR #42).'),
      cursor: cursorInput,
      limit: limitInput(WORK_ITEM_CHATS_PAGE_LIMIT),
    }),
    output: WorkItemChatsPageSchema,
    surfaces: {
      mcp: { toolName: 'work_item_chats', ...READ_TOOL, servers: [...READ_TOOL.servers] },
      http: { method: 'get', path: '/api/work-items/chats' },
    },
    invoke: async (deps, input, context) => {
      const named = ports.readerOf(requireAuditDeps(deps), context);
      const reader = named.kind === 'owner' && !ports.namesPerson(context) ? UNNAMED_READER : named;
      const { links } = workGraphDb();
      return readWorkItemChats(
        { ref: workRefOf(input.ref)!, cursor: input.cursor, limit: input.limit, reader },
        (chatIds) => ports.readable(reader, chatIds),
        links
      );
    },
  });
}
