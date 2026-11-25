/**
 * `work-graph.record-pr` (DOR-5264): a chat says "I opened this pull request,
 * and I work on these tickets", and the work graph records an `opened` link
 * to the pull request and a `works_on` link to each ticket.
 *
 * `scripts/open-pr.sh` calls it after a pull request exists, with
 * `dorkos call`, from the chat's own shell. It has no MCP tool; it is reached
 * through the generic HTTP invoke route, the path `dorkos call` rides.
 *
 * ## The chat comes from the caller's own token, never from the request
 *
 * The input holds no chat, and an unknown field is refused. The chat is the one
 * a live process holding the presented identity token runs
 * (`AgentIdentity.chatId`, `core/agent-identity/token-chats.ts`), and only that
 * chat's own processes carry the token. A session or runtime principal id the surface set beside it must
 * agree with it, or the call is refused rather than one of them picked.
 *
 * ## Only a chat's own turn, right now
 *
 * Refused as `NOT_A_CHAT_TURN`: no identity (a person, a program key), an
 * inactive one, a token that names no chat (minted before DOR-5264, after a
 * restart, an evicted entry, OpenCode and Doe, which mint none), a chat
 * that is not mid-turn, and a chat whose agent is not the token's. Mid-turn
 * asks the run record for a live run first, and the chat's projector (a turn
 * open, or held on a person) only for a turn the run record does not hold
 * yet, so a script left in a background shell after its turn ended is
 * refused. The chat is resolved through recorded
 * re-keys, so a re-keyed chat's links land on its current id.
 *
 * ## References
 *
 * The pull request must be one `parseEntityRef` reads as a pull request, or
 * the whole call is refused. Tickets are recorded one by one: each one
 * `parseEntityRef` reads as a ticket is written, and the rest come back by
 * name, so one stray word never costs the `opened` link. The links are
 * append-only, so the caller sends only tickets it is sure of.
 *
 * Each link carries the turn's marks, read live at the call: a pull request
 * body a stranger wrote can name tickets, and the graph shows that it did.
 *
 * @module services/work-graph/work-graph-capabilities
 */
import { z } from 'zod';
import { entityRef, parseEntityRef, type EntityRef } from '@dorkos/shared/entity-ref';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { isServerPrincipal } from '../connectors/principal/server-principal.js';
import type { TurnMarks } from '../core/turn-power/turn-marks.js';
import type { WorkLinkStore } from './work-link-store.js';

/** The most tickets one call records. */
export const RECORD_PR_MAX_TICKETS = 25;

/** A chat's live run, as the run record holds it. */
export interface LiveRun {
  /** The Mesh id of the agent it runs for, or `null` when unrecorded. */
  agentId: string | null;
}

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** What `work-graph.record-pr` reads (DOR-5264). */
    workGraphDeps?: {
      /** The installed link store, or `null` before startup installs it. */
      store(): WorkLinkStore | null;
      /** The Mesh id of the agent rooted at a path. */
      agentIdForPath(agentPath: string): string | undefined;
      /** The chat's current id, through recorded re-keys. */
      resolveChat(chatId: string): string;
      /** The chat's live run, or `undefined` when the run record holds none (or is not installed). */
      liveRun(chatId: string): LiveRun | undefined;
      /** Whether the chat's projector shows a turn open or held on a person. */
      projectorBusy(chatId: string): boolean;
      /** The agent home the chat belongs to, from server-held state. */
      chatAgentPath(chatId: string): Promise<string | undefined>;
      /** The marks the chat's running turn carries. */
      marksOf(chatId: string, agentPath: string): TurnMarks;
    };
  }
}

function requireDeps(deps: CapabilityDeps) {
  if (!deps.workGraphDeps) throw new Error('The work graph is unavailable.');
  return deps.workGraphDeps;
}

function notAChatTurn(why: string): CapabilityToolError {
  return new CapabilityToolError({
    code: 'NOT_A_CHAT_TURN',
    error: `Only a DorkOS chat's own turn can record this: ${why}`,
  });
}

/**
 * The chat behind this call and the agent home it runs for, from server-held
 * state only. Throws `NOT_A_CHAT_TURN` for every caller that is not a chat's
 * own live turn.
 */
async function callerChatOf(
  graph: ReturnType<typeof requireDeps>,
  context: CapabilityHandlerContext
): Promise<{ chatId: string; agentPath: string }> {
  const identity = context.identity;
  if (!identity) throw notAChatTurn('no agent token was presented.');
  if (identity.inactive) throw notAChatTurn('this agent token is no longer active.');
  const bound = identity.chatId;
  if (!bound) throw notAChatTurn('this agent token names no chat.');
  const principal = context.serverPrincipal;
  const principalChat =
    principal && isServerPrincipal(principal) && principal.claims.kind === 'runtime'
      ? principal.claims.canonicalSessionId
      : undefined;
  for (const other of [context.sessionId, principalChat]) {
    if (other !== undefined && graph.resolveChat(other) !== graph.resolveChat(bound))
      throw notAChatTurn('the call names a different chat than its token.');
  }
  const chatId = graph.resolveChat(bound);
  const agentId = graph.agentIdForPath(identity.agentPath);
  if (!agentId) throw notAChatTurn('this agent is not registered.');
  // The run record first; a turn it does not hold yet (a task's, a relay's) only
  // through the chat's projector.
  const run = graph.liveRun(chatId);
  if (!run && !graph.projectorBusy(chatId)) throw notAChatTurn('the chat is not mid-turn.');
  if (run && run.agentId !== agentId) throw notAChatTurn("the chat's turn runs for another agent.");
  if ((await graph.chatAgentPath(chatId)) !== identity.agentPath)
    throw notAChatTurn('the chat belongs to another agent.');
  return { chatId, agentPath: identity.agentPath };
}

const RefusedTicketSchema = z.object({ ref: z.string(), reason: z.string() });

/** Record a pull request a chat opened, and the tickets it works on. */
export const workGraphDomain: CapabilityDomain = {
  name: 'work-graph',
  assertDeps: requireDeps,
  capabilities: [
    defineCapability({
      id: 'work-graph.record-pr',
      title: 'Record a pull request this chat opened',
      tier: 'act',
      area: null,
      areaNote: 'it records only what the calling chat itself did',
      description:
        'Record that this chat opened a pull request and works on the tickets it names. The chat is the one whose token makes the call. A pull request that is not one is refused; each ticket that is not one is returned, and the rest are recorded.',
      input: z
        .object({
          pr: z
            .string()
            .min(1)
            .max(300)
            .describe('The pull request: its GitHub URL, owner/repo#42 or PR #42.'),
          tickets: z
            .array(z.string().min(1).max(300))
            .max(RECORD_PR_MAX_TICKETS)
            .default([])
            .describe('The tickets it works on: DOR-1234 or a Linear issue URL.'),
        })
        .strict(),
      output: z.object({
        ok: z.literal(true),
        chat: z.string(),
        pr: z.string(),
        tickets: z.array(z.string()),
        refused: z.array(RefusedTicketSchema),
      }),
      surfaces: {},
      invoke: async (deps, input, context) => {
        const graph = requireDeps(deps);
        const { chatId, agentPath } = await callerChatOf(graph, context);
        const pr = parseEntityRef(input.pr);
        if (!pr.ok || pr.value.kind !== 'pr')
          throw new CapabilityToolError({
            code: 'INVALID_PR',
            error: `${input.pr} is not a pull request reference.`,
          });
        const store = graph.store();
        if (!store) throw new Error('The work graph is unavailable.');
        const chat = entityRef('chat', chatId);
        if (!chat.ok) throw notAChatTurn('the chat id has no reference form.');
        const turnMarks = graph.marksOf(chatId, agentPath);
        const link = (relation: 'opened' | 'works_on', to: EntityRef) =>
          store.record({
            from: chat.value,
            relation,
            to,
            source: 'open-pr',
            recordingChatId: chatId,
            turnMarks,
          });
        const opened = link('opened', pr.value);
        if (!opened.ok) throw new Error(`The pull request link was refused (${opened.reason}).`);
        const tickets: string[] = [];
        const refused: z.infer<typeof RefusedTicketSchema>[] = [];
        for (const raw of input.tickets) {
          const ticket = parseEntityRef(raw);
          if (!ticket.ok || ticket.value.kind !== 'ticket') {
            refused.push({ ref: raw, reason: ticket.ok ? 'not-a-ticket' : ticket.reason });
            continue;
          }
          const written = link('works_on', ticket.value);
          if (written.ok) tickets.push(ticket.value.id);
          else refused.push({ ref: raw, reason: written.reason });
        }
        return { ok: true as const, chat: chat.value.id, pr: pr.value.id, tickets, refused };
      },
    }),
  ],
};
