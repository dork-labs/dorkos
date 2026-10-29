/**
 * The teammate tier (DOR-2956, `specs/everything-is-a-space` C7): what a turn that a teammate in a
 * shared space started may use, on the computer that runs it. Today that is the DorkOS tools that
 * reach only the room it answers, and a to-do list (DOR-2955). Everything else is refused, unasked,
 * files included. One table, so every decision about a teammate's reach is made, and reviewed, here.
 *
 * The tier is more than this table. The rest of it lives beside the turn: nobody to ask and read
 * access (`rooms/limits/teammate-turn.ts`), no folder grants (`rooms/room-turn-runner.ts`), no
 * settings layers, auto-memory or notes, and a prompt without the owner's profile or folder path
 * (`runtimes/claude-code/messaging/launch-resolver.ts`). This file is the part that decides per
 * tool, enforced by a hook that sees every call.
 *
 * ## Why per tool, on top of "nobody is asked" and "read-only"
 *
 * A teammate turn already has nobody to ask and is held to read access
 * (`rooms/limits/teammate-turn.ts`). Neither stops the DorkOS agent tools: they skip the card on
 * purpose, because each carries its own authorization, and that authorization is the AGENT's.
 * The agent is a member of the owner's other rooms and chats, so on a teammate's say-so it could
 * read them (`read_room_history`, `search_member_rooms`, `chat_read`) and post what it found back
 * into the space. The tier takes the room the turn answers as the only room there is.
 *
 * It is enforced where nothing can skip it: a hook that sees every call before the runtime's own
 * permission rules, so a rule the owner once saved ("Always allow" on a tool) does not carry a
 * teammate past it either (`runtimes/claude-code/teammate-tier-hook.ts`).
 *
 * ## No files, at any path
 *
 * Claude Code reads without asking inside the agent's folder AND inside every extra directory a
 * person's settings grant, which on a real machine can be another private repository or the
 * whole transcript store. A name-only allowance for `Read` therefore let a teammate read
 * whatever those grants covered. So until the tier brings scoped reads (C7: "the shared project
 * and public notes only"), a teammate's turn reads no files at all, and it may not attach
 * one to a post either: the agent's own folder can hold `.env` files, keys, its memory file and
 * MCP tokens.
 *
 * ## Extended row by row, never replaced
 *
 * C7 of `specs/everything-is-a-space` gives a teammate "ask the owner": a card that shows the exact
 * operation and its arguments. That is one more {@link TeammateToolRule} kind beside the two here,
 * applied to rows of the same table, so each tool's decision stays in one reviewed place and a tool
 * nobody decided about stays refused. Nothing here is a list of what is dangerous; it is the list
 * of what a teammate may reach, and everything not on it is out.
 *
 * @module services/core/turn-power/teammate-tier
 */

/** The room a teammate's turn answers, and so the only room its DorkOS tools may reach. */
export interface TeammateTierScope {
  /**
   * The local room id the turn answers in (`MessageOpts.roomTurn.roomId`), or `null` for a
   * teammate-marked turn that answers no room (a chat one hop on, DOR-3036): it reaches no room,
   * and replies only in its own chat.
   */
  roomId: string | null;
}

/**
 * What a teammate turn may do with one tool:
 *
 * - `this-room`: run, when its `roomId` argument is the room the turn answers and it carries
 *   none of the `without` arguments, and then only as the rest of the gate decides;
 * - `refuse`: never, with the reason kept for the reviewer reading this table.
 */
export type TeammateToolRule =
  { kind: 'this-room'; without?: readonly string[] } | { kind: 'refuse'; why: string };

const THIS_ROOM: TeammateToolRule = { kind: 'this-room' };
const refuse = (why: string): TeammateToolRule => ({ kind: 'refuse', why });

/**
 * Every DorkOS in-session tool an agent may call without a card, and what a teammate's turn may do
 * with it. A DorkOS tool missing from this table is refused, so a new tool reaches a teammate only
 * once somebody decides it should, here.
 */
export const TEAMMATE_DORKOS_TOOLS: Readonly<Record<string, TeammateToolRule>> = {
  // The room it answers: replying and reading are the whole point of being asked.
  // A post may carry no file: an attachment is a file read under another name.
  post_to_room: { kind: 'this-room', without: ['attachments'] },
  react_to_room_entry: THIS_ROOM,
  read_room_history: THIS_ROOM,
  search_room_history: THIS_ROOM,
  get_room: THIS_ROOM,
  // The list of what is on the room's canvas, but no document: one can be a file read off disk.
  read_canvas: { kind: 'this-room', without: ['documentId'] },
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
  memory_read: refuse('reads the agent’s notes files, which a teammate’s turn is never shown'),
  compact_my_session: refuse('rewrites what this conversation remembers'),
  accounts_usage: refuse('reads how much of the person’s accounts is used'),
  accounts_probe: refuse('reads a person’s account usage'),
  // The owner's screen.
  control_ui: refuse('drives the owner’s app'),
  get_ui_state: refuse('reads what the owner has open'),
};

/**
 * The runtime's own tools a teammate turn may use: a to-do list that stays in the turn. No file
 * reads at any path (see "No files, at any path" above; C7 brings scoped ones), no shell, no
 * writes, no web (a fetch can carry what was read to anywhere).
 */
export const TEAMMATE_BUILT_IN_TOOLS: ReadonlySet<string> = new Set(['TodoWrite']);

/** One tool call, as the tier sees it. */
export interface TeammateTierCall {
  /** Where the tool comes from: DorkOS's own server, another MCP server, or the runtime. */
  source: 'dorkos' | 'mcp' | 'built-in';
  /** The tool's bare name (no server prefix for a DorkOS tool). */
  name: string;
  /** The arguments it was called with. */
  input: Record<string, unknown>;
}

/** The reason the model is handed when the tier refuses a call. */
export const TEAMMATE_TIER_DENIAL =
  'Refused: a teammate in a shared space started this turn, so it can only read and post in ' +
  'this room, with no files. Tell them what you could not do.';

/**
 * Whether a teammate turn may make this call: `null` to let the rest of the gate decide, or the
 * reason it is refused. Another MCP server's tool is always refused: those are the owner's
 * connected apps and tools.
 *
 * @param scope - The room the turn answers.
 * @param call - The tool, where it comes from, and its arguments.
 */
export function teammateTierRefusal(
  scope: TeammateTierScope,
  call: TeammateTierCall
): string | null {
  if (call.source === 'built-in') {
    return TEAMMATE_BUILT_IN_TOOLS.has(call.name) ? null : TEAMMATE_TIER_DENIAL;
  }
  if (call.source === 'mcp') return TEAMMATE_TIER_DENIAL;
  const rule = Object.hasOwn(TEAMMATE_DORKOS_TOOLS, call.name)
    ? TEAMMATE_DORKOS_TOOLS[call.name]!
    : undefined;
  if (rule?.kind !== 'this-room' || call.input.roomId !== scope.roomId) return TEAMMATE_TIER_DENIAL;
  const carries = (rule.without ?? []).some((arg) => present(call.input[arg]));
  return carries ? TEAMMATE_TIER_DENIAL : null;
}

/** Whether an argument was given at all: only an absent one, or an empty list, carries nothing. */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return !Array.isArray(value) || value.length > 0;
}
