/**
 * The writes an agent may make on an agent computer, in one table (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * **Every write is refused unless it is listed here.** A write is any method
 * but `GET`, `HEAD` and `OPTIONS`. Who the agents are, what they may do, what
 * is installed, what is connected and what is scheduled are the hub's to
 * decide, and a deny-list of those routes misses each one added after it was
 * written. So the gate keeps the other list: the writes an agent's own work
 * needs (its sessions, files, documents, rooms, terminal and commitments),
 * each named by its exact method and route with the reason it is open.
 * Reads stay open to agents.
 *
 * The census test (`__tests__/agent-writes-census.test.ts`) holds every write
 * route the server serves against this table and the list of refused ones,
 * each with its reason, so a new write route fails CI until someone decides
 * which side it is on.
 *
 * **Matching is exact, on the path the router matches.** The gate is handed
 * `c.req.path`: dot segments already resolved by the URL parser, and percent
 * escapes decoded the way Hono decodes them (`decodeURI`, so `%2F` stays
 * `%2F`). A route here matches only that path, case and all, with no
 * trailing slash, no repeated slash and one segment per parameter. Any other
 * form (`/API/sessions/…`, `/api//files`, `/api/files/`) is refused, never
 * read as the route it resembles: the router answers those with a `404` or a
 * different route, and an unrecognised write is a refused one.
 *
 * Writes that never pass this table, on purpose: `/mcp` and A2A, which their
 * own authorizer decides (`./agent-gate.ts`), and every action behind them,
 * which the capability gates refuse when the hub owns it (`./hub-owned.ts`).
 *
 * @module services/core/agent-computer/agent-writes
 */
import { isAgentComputer } from '../server-role/role-checks.js';
import { HUB_OWNED_CODE } from './hub-owned.js';

/**
 * The writes open to agents on an agent computer, as `METHOD /route` in the
 * route census's form (`:name` is one path segment), each with why.
 */
export const AGENT_COMPUTER_WRITES: ReadonlyMap<string, string> = new Map([
  // Sessions: the turns an agent's work is made of.
  ['POST /api/sessions/:id/messages', 'sends a message, which starts a turn'],
  ['POST /api/sessions/:id/interrupt', 'stops a turn'],
  ['POST /api/sessions/:id/submit-answers', 'answers a question a session asked'],
  ['POST /api/sessions/:id/submit-elicitation', 'answers a question an MCP server asked'],
  ['PATCH /api/sessions/:id/queue/:messageId', 'edits a message waiting its turn'],
  ['DELETE /api/sessions/:id/queue/:messageId', 'drops a message waiting its turn'],
  ['POST /api/sessions/:id/tasks/:taskId/stop', 'stops a background task of a turn'],
  // Files: the work itself.
  ['POST /api/files', 'creates a file or folder'],
  ['POST /api/files/copy', 'copies a file'],
  ['POST /api/files/rename', 'renames or moves a file'],
  ['PUT /api/files/content', 'writes a file'],
  ['DELETE /api/files', 'deletes a file'],
  ['POST /api/uploads', 'uploads a file for a message'],
  // Shared documents.
  ['POST /api/canvas/docs/:id/events', 'edits a shared document'],
  ['POST /api/canvas/docs/:id/file-saves/:eventId/recover', 'recovers a document save'],
  // Rooms: posting and reacting, the room's canvas and files.
  ['POST /api/rooms/:id/entries', 'posts in a room'],
  ['POST /api/rooms/:id/entries/:entryId/reactions', 'reacts to a room message'],
  ['POST /api/rooms/:id/threads', 'replies in a thread'],
  ['POST /api/rooms/:id/attachments', 'attaches a file to a room message'],
  ['POST /api/rooms/:id/canvas', 'puts a document on a room canvas'],
  ['PATCH /api/rooms/:id/canvas/:documentId', 'changes a room canvas document'],
  ['DELETE /api/rooms/:id/canvas/:documentId', 'takes a document off a room canvas'],
  ['POST /api/rooms/:id/canvas/:documentId/thread', 'discusses a room canvas document'],
  ['POST /api/rooms/:id/canvas/:documentId/editing', 'says who is editing a document'],
  ['POST /api/rooms/:id/files/upload', 'adds a file to a room'],
  ['POST /api/rooms/:id/files/move', 'moves a room file'],
  ['POST /api/rooms/:id/files/delete', 'deletes a room file'],
  ['POST /api/rooms/:id/files/from-attachment', 'keeps an attachment as a room file'],
  ['POST /api/rooms/:id/halt', 'stops the agents in a room; anyone may'],
  ['POST /api/rooms/:id/halt/:authorId', 'stops one agent in a room; anyone may'],
  // The terminal: an agent already has a shell here.
  ['POST /api/terminal', 'opens a terminal'],
  ['DELETE /api/terminal/:id', 'closes a terminal'],
  // An agent's own promises, and stopping one.
  ['POST /api/agents/:id/commitments', 'records a commitment'],
  ['PATCH /api/commitments/:id', 'updates a commitment'],
  ['POST /api/agents/:id/pause', 'pauses an agent; anyone may stop any agent'],
  // Finding agents, and saying this one is alive.
  ['POST /api/agents/resolve', 'reads agents by path; a read sent as a POST'],
  ['POST /api/mesh/discover', 'lists agents on disk without registering them'],
  ['POST /api/mesh/agents/:id/heartbeat', 'says an agent is alive'],
  // Capabilities run through `registry.invoke`, which refuses the hub's own.
  ['POST /api/capabilities/:id/invoke', 'runs a capability; the hub-owned ones refuse'],
]);

/** The methods that only read. Every other method writes. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Turn a census route into a pattern for exactly the paths that route serves. */
function routePattern(route: string): RegExp {
  const source = route
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

/** The allowlist, compiled once: method, then the path patterns open to it. */
const OPEN_WRITES: ReadonlyMap<string, readonly RegExp[]> = (() => {
  const byMethod = new Map<string, RegExp[]>();
  for (const key of AGENT_COMPUTER_WRITES.keys()) {
    const [method, route] = key.split(' ') as [string, string];
    byMethod.set(method, [...(byMethod.get(method) ?? []), routePattern(route)]);
  }
  return byMethod;
})();

/** The sentence every refused write carries. */
export const AGENT_COMPUTER_WRITE_REFUSAL =
  'This is an agent computer. Only its hub makes this change.';

/** The `403` body of a refused write. */
export interface AgentComputerWriteRefusal {
  /** One plain sentence. */
  readonly error: string;
  /** Always {@link HUB_OWNED_CODE}. */
  readonly code: typeof HUB_OWNED_CODE;
}

/**
 * The refusal for a request on an agent computer, or `null` when it may go
 * on: another role, a read, or a write {@link AGENT_COMPUTER_WRITES} lists.
 *
 * @param method - The request method.
 * @param path - The path the router matches (`c.req.path`), as it arrived:
 *   not lowercased and without its query.
 */
export function agentComputerRouteRefusal(
  method: string,
  path: string
): AgentComputerWriteRefusal | null {
  if (!isAgentComputer()) return null;
  const upper = method.toUpperCase();
  if (READS.has(upper)) return null;
  const open = OPEN_WRITES.get(upper)?.some((pattern) => pattern.test(path)) ?? false;
  return open ? null : { error: AGENT_COMPUTER_WRITE_REFUSAL, code: HUB_OWNED_CODE };
}
