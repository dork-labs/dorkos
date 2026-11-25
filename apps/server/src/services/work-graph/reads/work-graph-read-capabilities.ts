/**
 * The work graph's read tools (W4, DOR-4970), served by the capability mount
 * (ADR 261123-170830) and reachable by agents over MCP:
 *
 * | Capability                | Tool             | Path                              | What it answers                                  |
 * | ------------------------- | ---------------- | --------------------------------- | ------------------------------------------------ |
 * | `work-graph.agent_chats`  | `agent_chats`    | `GET /api/agents/{agentId}/chats` | Every chat this DorkOS bound to an agent, ended ones too |
 * | `work-graph.chat_tree`    | `chat_tree`      | `GET /api/sessions/{id}/tree`     | A chat's ancestors and the chats below it        |
 * | `work-graph.agent_work`   | `work_for_agent` | `GET /api/agents/{agentId}/work`  | The PRs and tickets an agent's chats are linked to |
 * | `work-graph.chat_work`    | `work_for_chat`  | `GET /api/sessions/{id}/work`     | The same, for a chat and the chats below it      |
 *
 * **Doors that take a chat id (step 10's D13 census, PR #4460 §8.7):**
 * `work-graph.chat_tree` and `work-graph.chat_work` take one in their path, and
 * `work-graph.agent_chats` and `work-graph.agent_work` return chat ids. When
 * step 10 gives program keys their own reach, `readerKey`
 * (`./page-cursor.ts`) must add the key's id: today every program key reads
 * as the owner and shares the owner's cursors.
 *
 * All four are `observe` with no permission area, like the audit reads: what
 * a caller may SEE is the audit read side's one rule (spec `audit-trail`
 * §3.4), read through `readerFor` and `readableSessionIds`. The owner reads
 * everything, and so does a program key that presents no agent, as it does
 * for the audit log today; an agent reads every agent's work and never a
 * person's own chat. Each read says how it leaves out a chat its reader may
 * not read. A chat it may not read, asked for by id, answers as a chat that
 * does not exist. The session read guard in front of every other
 * `/api/sessions/:id/*` route never runs for a path the mount serves, so the
 * two chat reads fold it in this way, as `runs.chat_runs` does.
 *
 * **Ids and references.** A path segment takes a bare id or its `dork:`
 * reference (`dork:agent:<id>`, `dork:chat:<id>`), neither of which can hold a
 * `/` or a `%` (`./id-input.ts`). An address (`dork:<space>/<handle>`) is not
 * taken.
 *
 * @module services/work-graph/reads/work-graph-read-capabilities
 */
import { z } from 'zod';
import {
  AGENT_CHATS_PAGE_LIMIT,
  AgentChatsPageSchema,
  CHAT_TREE_PAGE_LIMIT,
  ChatTreeSchema,
  WORK_PAGE_LIMIT,
  WorkKindSchema,
  WorkPageSchema,
} from '@dorkos/shared/work-graph-reads';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityInvocationContext,
} from '../../core/capabilities/index.js';
import { markCallerTurnOutsider } from '../../core/capabilities/mark-caller-turn.js';
import { chatHoldsOutsideText } from '../../core/turn-power/chat-outside-words.js';
import { readerFor } from '../../audit/audit-capabilities.js';
import { readableSessionIds } from '../../audit/session-visibility.js';
import type { AuditReader } from '../../audit/visibility.js';
import { chatTitleOf } from '../../session/chat-messages/chat-message-wiring.js';
import {
  getWorkGraphDb,
  getWorkLinkStore,
  LINEAGE_MAX_DEPTH,
  readChatLineage,
  readLineageReads,
} from '../index.js';
import { LineageReads } from '../lineage-reads.js';
import { readAgentChats } from './agent-chats.js';
import { agentChatIds } from './chat-bindings.js';
import { chatIdsOf, filterChatTree } from './chat-tree.js';
import { idInput, idOf } from './id-input.js';
import { readWork } from './work-for.js';

type AuditDeps = NonNullable<CapabilityDeps['auditDeps']>;

/**
 * The audit deps these reads take their reader and roster from, throwing if
 * the registry was composed without them (a wiring bug, caught at boot).
 *
 * @param deps - The capability bag.
 */
function requireAuditDeps(deps: CapabilityDeps): AuditDeps {
  if (!deps.auditDeps) {
    throw new Error('Work graph read invoked without auditDeps in the registry bag.');
  }
  return deps.auditDeps;
}

/** Both MCP servers, read-only, safe to repeat. */
const READ_TOOL = {
  servers: ['in-session', 'external'] as ('in-session' | 'external')[],
  annotations: { idempotentHint: true },
};

/** The page cursor field. */
const cursorInput = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('The `nextCursor` of the page before; leave it out for the first page.');

/** A page size field, 1 to `max`, 50 when left out. */
function limitInput(max: number) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .default(50)
    .describe(`How many this page holds, 1 to ${max}.`);
}

/** The kind field of the work reads. */
const kindInput = WorkKindSchema.optional().describe(
  'Only pull requests (`pr`) or only tickets (`ticket`); both when left out.'
);

/** Fail with "still starting" until startup installs the work graph. */
function workGraphDb() {
  const db = getWorkGraphDb();
  const links = getWorkLinkStore();
  if (!db || !links) {
    throw new CapabilityToolError({ code: 'NOT_READY', error: 'DorkOS is still starting.' });
  }
  return { db, links };
}

/** The registered agent's folder, or a not-found refusal. */
function agentFolder(audit: AuditDeps, agentInput: string): string {
  const agentId = idOf(agentInput, 'agent');
  const agent = audit
    .roster?.()
    ?.listWithPaths()
    .find((entry) => entry.id === agentId);
  if (!agent) {
    throw new CapabilityToolError({
      code: 'WORK_GRAPH_AGENT_NOT_FOUND',
      error: 'No agent on the team has that id.',
    });
  }
  return agent.projectPath;
}

/** The answer for a chat that does not exist, or one the reader may not read: the same. */
function chatNotFound(): CapabilityToolError {
  return new CapabilityToolError({ code: 'SESSION_NOT_FOUND', error: 'No chat with that id.' });
}

/**
 * A chat's lineage, when the reader may read the chat, with the chats in it
 * the reader may read. `forReader` reads it with the reader's filter, so the
 * chats the reader may not read are left out before the cap counts (the
 * tree); without it every chat below is kept (the work reads, which list a
 * private chat's work with the chat left off).
 */
function readableLineage(
  chatInput: string,
  reader: AuditReader,
  opts: { depth?: number | undefined; forReader: boolean }
) {
  workGraphDb();
  const lineage = readChatLineage(idOf(chatInput, 'chat'), {
    ...(opts.depth === undefined ? {} : { depth: opts.depth }),
    ...(opts.forReader ? { readable: (ids) => readableSessionIds(reader, ids) } : {}),
  });
  if (!lineage) throw chatNotFound();
  const readable = readableSessionIds(reader, chatIdsOf(lineage));
  if (!readable.has(lineage.chatId)) throw chatNotFound();
  return { lineage, readable };
}

/** Mark the caller's turn when a listed chat's title may quote outside words (DOR-3969). */
function markIfTitlesHoldOutsideWords(
  context: CapabilityInvocationContext | undefined,
  chatIds: readonly string[]
): void {
  if (context && chatIds.some((id) => chatHoldsOutsideText(id))) {
    markCallerTurnOutsider(context, { kind: 'chat' });
  }
}

/** The work graph's read tools. */
export const workGraphReadDomain: CapabilityDomain = {
  name: 'work-graph',
  assertDeps: requireAuditDeps,
  capabilities: [
    defineCapability({
      id: 'work-graph.agent_chats',
      title: 'List an agent’s chats',
      description:
        'Every chat this DorkOS knows for one agent, ended ones included, newest first: its ' +
        'title, a ready markdown link, when it began, its runtime, and the chat that started ' +
        'it. Chats the agent ran on another computer are not listed. A person’s own chat is ' +
        'left out for an agent. For the chats running right now, use running_chats. Page with ' +
        '`limit` and the returned `nextCursor`. Use the link, never the id, when you tell a ' +
        'person about a chat. agentId is the agent’s id or its dork:agent: reference.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({
        agentId: idInput('agent'),
        cursor: cursorInput,
        limit: limitInput(AGENT_CHATS_PAGE_LIMIT),
      }),
      output: AgentChatsPageSchema,
      surfaces: {
        mcp: { toolName: 'agent_chats', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/agents/{agentId}/chats' },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        const agentPath = agentFolder(audit, input.agentId);
        const { db } = workGraphDb();
        const withoutTitles = context?.narrowedReads === true;
        const page = await readAgentChats(
          { agentPath, cursor: input.cursor, limit: input.limit },
          readerFor(audit, context),
          { db, titleOf: withoutTitles ? async () => null : chatTitleOf }
        );
        if (!withoutTitles) {
          markIfTitlesHoldOutsideWords(context, [
            ...page.chats.map((chat) => chat.id),
            ...page.chats.flatMap((chat) => (chat.startedBy ? [chat.startedBy.id] : [])),
          ]);
        }
        return page;
      },
    }),
    defineCapability({
      id: 'work-graph.chat_tree',
      title: 'See a chat’s tree',
      description:
        'A chat’s place in the tree of chats that started each other: the chats above it, ' +
        'nearest first, and every chat below it, depth first, each with whether it ran, is ' +
        `still launching, or never started and why. \`depth\` limits how many levels down, 1 to ` +
        `${LINEAGE_MAX_DEPTH}; all of them when left out. A chat you may not read is left out; ` +
        'when a chat you may read hangs below it, it shows as a private joint with no id. ' +
        'States and ids only, never what was said. Page the chats below it with `limit` and ' +
        'the returned `nextCursor`; the chats above it repeat on every page, so count them ' +
        'once. chatId is the chat’s id or its dork:chat: reference.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({
        chatId: idInput('chat'),
        depth: z.coerce
          .number()
          .int()
          .min(1)
          .max(LINEAGE_MAX_DEPTH)
          .optional()
          .describe(
            `How many levels below the chat, 1 to ${LINEAGE_MAX_DEPTH}; all when left out.`
          ),
        cursor: cursorInput,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(CHAT_TREE_PAGE_LIMIT)
          .default(CHAT_TREE_PAGE_LIMIT)
          .describe(`How many chats below it this page holds, 1 to ${CHAT_TREE_PAGE_LIMIT}.`),
      }),
      output: ChatTreeSchema,
      surfaces: {
        mcp: { toolName: 'chat_tree', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/sessions/{id}/tree', params: { id: 'chatId' } },
      },
      invoke: async (deps, input, context) => {
        const reader = readerFor(requireAuditDeps(deps), context);
        const { lineage, readable } = readableLineage(input.chatId, reader, {
          depth: input.depth,
          forReader: true,
        });
        const order = readLineageReads();
        if (!order)
          throw new CapabilityToolError({ code: 'NOT_READY', error: 'DorkOS is still starting.' });
        return filterChatTree(lineage, readable, { ...input, reader }, order);
      },
    }),
    defineCapability({
      id: 'work-graph.agent_work',
      title: 'List an agent’s pull requests and tickets',
      description:
        'Every pull request and ticket the chats this DorkOS knows for one agent opened, ' +
        'claimed or worked on, newest first by the day each was first linked, with each link: ' +
        'the relation, the chat and when. A link from a chat you may not read shows only its ' +
        'relation and the day. Page with `limit` and the returned `nextCursor`. agentId is the ' +
        'agent’s id or its dork:agent: reference.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({
        agentId: idInput('agent'),
        kind: kindInput,
        cursor: cursorInput,
        limit: limitInput(WORK_PAGE_LIMIT),
      }),
      output: WorkPageSchema,
      surfaces: {
        mcp: { toolName: 'work_for_agent', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/agents/{agentId}/work' },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        const agentPath = agentFolder(audit, input.agentId);
        const { db, links } = workGraphDb();
        const chatIds = agentChatIds(db, agentPath);
        const reader = readerFor(audit, context);
        const readable = readableSessionIds(reader, chatIds);
        return readWork({ ...input, chatIds, reader }, readable, {
          links,
          aliases: new LineageReads({ db, links }),
        });
      },
    }),
    defineCapability({
      id: 'work-graph.chat_work',
      title: 'List a chat’s pull requests and tickets',
      description:
        'Every pull request and ticket a chat and the chats below it opened, claimed or worked ' +
        'on, newest first by the day each was first linked, with each link: the relation, the ' +
        'chat and when. Set `children` to `false` for the chat alone. A link from a chat you ' +
        'may not read shows only its relation and the day. Page with `limit` and the returned ' +
        '`nextCursor`. chatId is the chat’s id or its dork:chat: reference.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({
        chatId: idInput('chat'),
        // A boolean from an MCP agent, or its spelling in a query string; never
        // z.coerce.boolean, which reads the string 'false' as true.
        children: z
          .union([z.boolean(), z.enum(['true', 'false'])])
          .optional()
          .describe('Include the chats below it (`true`, the default) or not (`false`).'),
        kind: kindInput,
        cursor: cursorInput,
        limit: limitInput(WORK_PAGE_LIMIT),
      }),
      output: WorkPageSchema,
      surfaces: {
        mcp: { toolName: 'work_for_chat', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/sessions/{id}/work', params: { id: 'chatId' } },
      },
      invoke: async (deps, input, context) => {
        const reader = readerFor(requireAuditDeps(deps), context);
        const alone = input.children === false || input.children === 'false';
        const { lineage, readable } = readableLineage(input.chatId, reader, {
          depth: alone ? 0 : undefined,
          forReader: false,
        });
        const { db, links } = workGraphDb();
        const chatIds = [lineage.chatId, ...lineage.descendants.map((d) => d.chatId)];
        return readWork(
          { chatIds, kind: input.kind, cursor: input.cursor, limit: input.limit, reader },
          readable,
          { links, aliases: new LineageReads({ db, links }) }
        );
      },
    }),
  ],
};
