/**
 * The refusals a person meets on the `/api/mcp-servers` doors the capability
 * mount serves (`global-mcp-person-capabilities.ts`, DOR-4978): each tool code
 * with the problem code and the fixed sentences the hand routes answered with.
 * `routes/capability-refusals.ts` spreads them into its table, so a sentence
 * listed here is sent as it is and any other gets the code's own sentence.
 *
 * Imports nothing but the problem type, so the refusal table can load it.
 *
 * @module services/mesh/global-mcp/global-mcp-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';

/** One refusal: its problem code, its sentence, and the other sentences it may say. */
export interface GlobalMcpToolRefusal {
  /** The problem code; its status comes with it. */
  readonly code: ProblemCode;
  /** The sentence for a refusal whose own sentence is not on `alsoSays`. */
  readonly detail: string;
  /** Every other sentence these doors refuse with under this code, each sent as it is. */
  readonly alsoSays?: readonly string[];
}

/** What the change bar names, in its refusal. */
const WRITE_SUBJECT = 'MCP servers for every agent';

/** The front-door bar's two sentences (`refuseFrontDoorChange`). */
export const GLOBAL_MCP_FRONT_DOOR = {
  /** A caller that is not the owner. */
  notTheOwner: `Only the owner can change ${WRITE_SUBJECT}, in the app.`,
  /** The owner, from somewhere front-door settings can't be changed from. */
  elsewhere: `Change ${WRITE_SUBJECT} on the computer DorkOS runs on.`,
} as const;

/** The sentences an Undo of a standing yes refuses with. */
export const GLOBAL_MCP_UNDO = {
  badRequest: 'Send an agent and one rule for this server to undo.',
  badRule: "That rule can't be undone here.",
  noAgent: 'There is no agent by that id.',
  noRule: 'That agent no longer has that rule.',
  notAPlainFile:
    'That agent’s settings file isn’t a plain file in its folder, so it was left alone.',
  unreadable: 'That agent’s settings file couldn’t be read. Nothing changed.',
} as const;

/** The sentence for a server name that names nothing. */
export const NO_SUCH_SERVER = 'There is no MCP server by that name.';

/** Every refusal these doors answer with, by tool code. */
export const GLOBAL_MCP_TOOL_REFUSALS: Readonly<Record<string, GlobalMcpToolRefusal>> = {
  GLOBAL_MCP_NOT_FOUND: {
    code: 'not_found',
    detail: NO_SUCH_SERVER,
    alsoSays: [GLOBAL_MCP_UNDO.noAgent, GLOBAL_MCP_UNDO.noRule],
  },
  GLOBAL_MCP_FRONT_DOOR: {
    code: 'operator_only',
    detail: GLOBAL_MCP_FRONT_DOOR.notTheOwner,
    alsoSays: [GLOBAL_MCP_FRONT_DOOR.elsewhere],
  },
  GLOBAL_MCP_UNREADABLE: {
    code: 'temporarily_unavailable',
    detail: "The saved servers couldn't be read. Nothing changed.",
  },
  GLOBAL_MCP_CHANGED: {
    code: 'precondition_failed',
    detail: 'This server changed since you looked. Reload it and try again.',
  },
  GLOBAL_MCP_SECRET_LEFT: {
    code: 'secret_left',
    detail: "The server is removed, but its saved key couldn't be deleted.",
  },
  GLOBAL_MCP_UNDO_REFUSED: {
    code: 'invalid_request',
    detail: GLOBAL_MCP_UNDO.badRequest,
    alsoSays: [GLOBAL_MCP_UNDO.badRule],
  },
  GLOBAL_MCP_UNDO_CONFLICT: {
    code: 'conflict',
    detail: GLOBAL_MCP_UNDO.unreadable,
    alsoSays: [GLOBAL_MCP_UNDO.notAPlainFile],
  },
};
