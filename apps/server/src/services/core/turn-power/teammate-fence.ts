/**
 * What a teammate's turn may use: reads of the agent's own folder, and the DorkOS tools that
 * reach only the room it answers (DOR-2955). Everything else is refused, unasked.
 *
 * ## Why a fence, on top of "nobody is asked" and "read-only"
 *
 * A teammate turn already has nobody to ask and is held to read access
 * (`rooms/limits/teammate-turn.ts`). Neither stops the DorkOS agent tools: they skip the card on
 * purpose, because each carries its own authorization, and that authorization is the AGENT's.
 * The agent is a member of the owner's other rooms and chats, so on a teammate's say-so it could
 * read them (`read_room_history`, `search_member_rooms`, `chat_read`) and post what it found back
 * into the space. The fence takes the room the turn answers as the only room there is.
 *
 * It is enforced where nothing can skip it: a hook that sees every call before the runtime's own
 * permission rules, so a rule the owner once saved ("Always allow" on a tool) does not carry a
 * teammate past it either (`runtimes/claude-code/teammate-fence-hook.ts`).
 *
 * ## Built to be extended by the teammate tier, not replaced
 *
 * C7 of `specs/everything-is-a-space` gives a teammate "ask the owner": a card that shows the exact
 * operation and its arguments. That is one more {@link TeammateToolRule} kind beside the two here,
 * applied to rows of the same table, so each tool's decision stays in one reviewed place and a tool
 * nobody decided about stays refused. Nothing here is a list of what is dangerous; it is the list
 * of what a teammate may reach, and everything not on it is out.
 *
 * @module services/core/turn-power/teammate-fence
 */

/** The room a teammate's turn answers, and so the only room its DorkOS tools may reach. */
export interface TeammateFence {
  /** The local room id the turn answers in (`MessageOpts.roomTurn.roomId`). */
  roomId: string;
}

/**
 * What a teammate turn may do with one tool:
 *
 * - `this-room`: run, when its `roomId` argument is the room the turn answers, and then only as
 *   the rest of the gate decides;
 * - `refuse`: never, with the reason kept for the reviewer reading this table.
 */
export type TeammateToolRule = { kind: 'this-room' } | { kind: 'refuse'; why: string };

const THIS_ROOM: TeammateToolRule = { kind: 'this-room' };
const refuse = (why: string): TeammateToolRule => ({ kind: 'refuse', why });

/**
 * Every DorkOS in-session tool an agent may call without a card, and what a teammate's turn may do
 * with it. A DorkOS tool missing from this table is refused, so a new tool reaches a teammate only
 * once somebody decides it should, here.
 */
export const TEAMMATE_DORKOS_TOOLS: Readonly<Record<string, TeammateToolRule>> = {
  // The room it answers: replying and reading are the whole point of being asked.
  post_to_room: THIS_ROOM,
  react_to_room_entry: THIS_ROOM,
  read_room_history: THIS_ROOM,
  search_room_history: THIS_ROOM,
  get_room: THIS_ROOM,
  read_canvas: THIS_ROOM,
  // Every other room the agent is in is the owner's business.
  list_member_rooms: refuse('lists every room the agent is in, the owner’s private ones included'),
  search_member_rooms: refuse('searches every room the agent is in'),
  find_room: refuse('looks rooms up across everything the agent can see'),
  create_room: refuse('opens a new room on the owner’s computer'),
  add_room_members: refuse('changes who is in the owner’s rooms'),
  remove_room_members: refuse('changes who is in the owner’s rooms'),
  update_room: refuse('changes a room’s settings, which are the owner’s'),
  leave_room: refuse('takes the agent out of a room for good'),
  archive_room: refuse('closes a room for everyone in it'),
  // Chats are the owner's conversations with their agents.
  chat_send: refuse('starts or steers work in another chat'),
  chat_read: refuse('reads another chat'),
  chat_stop: refuse('stops work in another chat'),
  // Reaching the owner is what "ask the owner" (C7) will do, with a card that says who asked.
  request_permission: refuse('asks the owner to unblock something; C7 adds a card for this'),
  relay_notify_user: refuse('sends the owner a note outside the app'),
  relay_list_endpoints: refuse('lists the owner’s connected chats'),
  // The owner's agents and this machine.
  mesh_list: refuse('lists the owner’s agents'),
  mesh_inspect: refuse('reads another agent’s setup'),
  mesh_discover: refuse('scans the owner’s folders for agents'),
  mesh_register: refuse('adds an agent'),
  mesh_status: refuse('reads the owner’s agent network'),
  mesh_query_topology: refuse('reads the owner’s agent network'),
  get_agent: refuse('reads an agent’s setup'),
  // Durable state that outlives the turn.
  memory_write: refuse('writes notes every later conversation reads, the owner’s included'),
  compact_my_session: refuse('rewrites what this conversation remembers'),
  // The owner's screen.
  control_ui: refuse('drives the owner’s app'),
  get_ui_state: refuse('reads what the owner has open'),
};

/**
 * The runtime's own tools a teammate turn may use: reading and searching files, which the runtime
 * still keeps to the agent's folder, and a to-do list that stays in the turn. No shell, no writes,
 * no web (a fetch can carry what was read to anywhere).
 */
export const TEAMMATE_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite',
]);

/** One tool call, as the fence sees it. */
export interface TeammateFenceCall {
  /** Where the tool comes from: DorkOS's own server, another MCP server, or the runtime. */
  source: 'dorkos' | 'mcp' | 'built-in';
  /** The tool's bare name (no server prefix for a DorkOS tool). */
  name: string;
  /** The arguments it was called with. */
  input: Record<string, unknown>;
}

/** The reason the model is handed when the fence refuses a call. */
export const TEAMMATE_FENCE_DENIAL =
  'Refused: a teammate in a shared space started this turn, so it can read files here and use ' +
  'this room only. Tell them what you could not do.';

/**
 * Whether a teammate turn may make this call: `null` to let the rest of the gate decide, or the
 * reason it is refused. Another MCP server's tool is always refused: those are the owner's
 * connected apps and tools.
 *
 * @param fence - The room the turn answers.
 * @param call - The tool, where it comes from, and its arguments.
 */
export function teammateFenceRefusal(fence: TeammateFence, call: TeammateFenceCall): string | null {
  if (call.source === 'built-in') {
    return TEAMMATE_BUILT_IN_TOOLS.has(call.name) ? null : TEAMMATE_FENCE_DENIAL;
  }
  if (call.source === 'mcp') return TEAMMATE_FENCE_DENIAL;
  const rule = Object.hasOwn(TEAMMATE_DORKOS_TOOLS, call.name)
    ? TEAMMATE_DORKOS_TOOLS[call.name]!
    : undefined;
  if (rule?.kind === 'this-room' && call.input.roomId === fence.roomId) return null;
  return TEAMMATE_FENCE_DENIAL;
}
