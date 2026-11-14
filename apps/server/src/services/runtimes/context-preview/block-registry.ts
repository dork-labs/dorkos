/**
 * Every block DorkOS can put in front of a model, with what a person needs to
 * know about each: where it comes from, why it is included, and whether it is
 * locked (spec `context-viewer` phase 3, Security ruling 1).
 *
 * **The registry holds facts ABOUT blocks, never their text.** The text always
 * comes from the real builders (`preview.ts` runs them), so there is no second
 * copy of the prompt that could drift. A block the builders write that this
 * registry does not name fails `block-registry.test.ts`, and so does an entry
 * no builder ever writes.
 *
 * **Locked is the default.** Only the blocks Security's ruling 2 names are
 * editable: the persona, the boundaries, the user profile, and files a person
 * already edits (`ROOM.md`, folder instructions). Everything that tells the
 * model what text to trust or what it may do is locked for everyone, the
 * person included, and phase 5's override routes refuse a locked id.
 *
 * @module services/runtimes/context-preview/block-registry
 */
import type { ContextKind } from '@dorkos/shared/additional-context';
import type {
  InstructionsCondition,
  InstructionsPlace,
  InstructionsRuntime,
} from '@dorkos/shared/agent-instructions-schemas';

/** What the registry knows about one block. */
export interface ContextBlockSpec {
  /** The block's tag, or a named id for an untagged block. */
  readonly id: string;
  /** A short name a person reads (app copy: sentence case, a few words). */
  readonly title: string;
  /** The file or code that writes it. */
  readonly source: string;
  readonly condition: InstructionsCondition;
  /** When it is included, in at most 15 words. */
  readonly conditionNote: string;
  /** Shown only, for everyone (Security ruling 1). */
  readonly locked: boolean;
  /** Where a person changes it today, for an editable block. */
  readonly editIn?: string;
  /** The runtimes that carry it. */
  readonly runtimes: readonly InstructionsRuntime[];
  /**
   * For an untagged block: how to recognise it in the builders' output. A
   * tagged block is recognised by its tag.
   */
  readonly match?: RegExp;
  /** The places this block is included in; every place when absent. */
  readonly places?: readonly InstructionsPlace[];
}

const ALL: readonly InstructionsRuntime[] = ['claude-code', 'codex', 'opencode', 'doe'];
const CLAUDE: readonly InstructionsRuntime[] = ['claude-code'];

/** Locked tool documentation: it says what the agent may call. */
function toolDoc(id: string, title: string, conditionNote: string): ContextBlockSpec {
  return {
    id,
    title,
    source: 'claude-code/messaging/context-builder.ts',
    condition: 'setting',
    conditionNote,
    locked: true,
    runtimes: CLAUDE,
  };
}

/**
 * The session's blocks — the append a runtime sends once per session (or, on
 * OpenCode and Doe, on its system channel each turn). Listed in the order the
 * Claude Code builder writes them; each view orders by what the builders
 * actually wrote.
 */
export const SESSION_BLOCKS: readonly ContextBlockSpec[] = [
  { ...toolDoc('dorkos_tools', 'How to call DorkOS tools', 'Always.'), condition: 'always' },
  toolDoc('chat_tools', 'Chat tools', 'Agent chats, unless Messages is blocked.'),
  toolDoc('mesh_tools', 'Agent directory tools', 'Unless the Other agents area is blocked.'),
  toolDoc(
    'adapter_tools',
    'Chat connection tools',
    'When chat connections are on and not blocked.'
  ),
  toolDoc('tasks_tools', 'Schedule tools', 'When Tasks is on and not blocked.'),
  toolDoc('marketplace_tools', 'Marketplace tools', 'Unless Tools & packages is blocked.'),
  {
    id: 'room_tools',
    title: 'Room tools',
    source: 'runtimes/shared/room-tools-context.ts',
    condition: 'always',
    conditionNote: 'When this chat carries the room tools.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'blocked_areas',
    title: 'Blocked areas',
    source: 'runtimes/shared/permission-tool-filter.ts',
    condition: 'setting',
    conditionNote: 'One line per permission area set to Blocked.',
    locked: true,
    runtimes: ALL,
    match: /^.+ is blocked for you\. If you need it, ask with the tool /,
  },
  toolDoc('ui_tools', 'App window tools', 'Always.'),
  {
    id: 'gen_ui',
    title: 'Inline widgets',
    source: 'runtimes/shared/gen-ui-context.ts',
    condition: 'always',
    conditionNote: 'Always.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'agent_identity',
    title: 'Who the agent is',
    source: 'agent.json',
    condition: 'agent',
    conditionNote: 'When the chat belongs to an agent.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'agent_persona',
    title: 'Persona',
    source: 'SOUL.md and personality traits',
    condition: 'setting',
    conditionNote: 'When the persona file is on and not empty.',
    locked: false,
    editIn: 'Profile › Instructions',
    runtimes: ALL,
  },
  {
    id: 'agent_safety_boundaries',
    title: 'Boundaries',
    source: 'NOPE.md',
    condition: 'setting',
    conditionNote: 'When the boundaries file is on and not empty.',
    locked: false,
    editIn: 'Profile › Boundaries',
    runtimes: ALL,
  },
  {
    id: 'session_model',
    title: 'One of many chats',
    source: 'runtimes/shared/agent-context.ts',
    condition: 'agent',
    conditionNote: 'When the chat belongs to an agent.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'working_rules',
    title: 'Working rules',
    source: 'runtimes/shared/agent-context.ts',
    condition: 'always',
    conditionNote: 'Always.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'agent_memory',
    title: 'Memory',
    source: 'MEMORY.md, fenced',
    condition: 'setting',
    conditionNote: 'When memory is on and MEMORY.md or notes exist.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'dorkos_context',
    title: 'What DorkOS is',
    source: 'runtimes/shared/agent-context.ts',
    condition: 'setting',
    conditionNote: 'When DorkOS knowledge is on.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'dorkos_areas',
    title: 'What the agent can do here',
    source: 'runtimes/shared/awareness/dorkos-areas.ts',
    condition: 'setting',
    conditionNote: 'When DorkOS knowledge is on.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'agent_browser',
    title: 'Signed-in browser notice',
    source: 'mesh/agent-browser-preset.ts',
    condition: 'state',
    conditionNote: 'Only when its signed-in browser has no saved sign-in.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'user_profile',
    title: 'Who the agent works for',
    source: 'Your profile',
    condition: 'setting',
    conditionNote: 'When your profile has a name, work or tools.',
    locked: false,
    editIn: 'Settings › You',
    runtimes: ALL,
  },
  {
    id: 'env',
    title: 'This computer',
    source: 'runtimes/shared/agent-context.ts',
    condition: 'always',
    conditionNote: 'Always.',
    locked: true,
    runtimes: ALL,
  },
  {
    id: 'dorkos_tool_schemas',
    title: 'Loaded chat tools',
    source: 'runtimes/doe/context.ts',
    condition: 'agent',
    conditionNote: 'Agent chats on DorkOS (built-in), when its tools connect.',
    locked: true,
    runtimes: ['doe'],
    match: /^Chat tools? .+ (is|are) loaded: /,
  },
  {
    id: 'task_scheduler',
    title: 'Scheduled run frame',
    source: 'tasks/task-append.ts',
    condition: 'tasks',
    conditionNote: 'On a scheduled or started task run.',
    locked: true,
    runtimes: ALL,
    match: /^=== TASK SCHEDULER CONTEXT ===/,
    places: ['task'],
  },
  {
    id: 'dorkos_room_conventions',
    title: 'Room conventions',
    source: 'ROOM.md in the room’s files',
    condition: 'rooms',
    conditionNote: 'In a room whose files have a ROOM.md.',
    locked: false,
    editIn: 'The room’s files',
    runtimes: ALL,
    places: ['room'],
  },
  {
    id: 'folder_instructions',
    title: 'Folder instructions',
    source: 'claude-code/folder-settings/launch-folder-config.ts',
    condition: 'state',
    conditionNote: 'When this folder’s own settings are held back.',
    locked: false,
    editIn: 'The folder’s files',
    runtimes: CLAUDE,
  },
];

/** A per-turn block: always locked, built from live state each turn. */
function turn(
  title: string,
  source: string,
  condition: InstructionsCondition,
  conditionNote: string,
  places?: readonly InstructionsPlace[]
): Omit<ContextBlockSpec, 'id'> {
  return {
    title,
    source,
    condition,
    conditionNote,
    locked: true,
    runtimes: ALL,
    ...(places ? { places } : {}),
  };
}

/**
 * This turn's list (ADR-0273), one entry per {@link ContextKind}: the
 * `satisfies` is what makes a new kind a compile error here until somebody
 * says what it is.
 */
const TURN_BLOCK_SPECS = {
  git_status: turn(
    'Git status',
    'session/context-assembler.ts',
    'state',
    'When the folder is a git repo.'
  ),
  ui_state: turn(
    'What the app shows',
    'session/context-assembler.ts',
    'state',
    'When a window is open on the chat.',
    ['direct']
  ),
  queue_note: turn(
    'Queued message note',
    'session/context-assembler.ts',
    'state',
    'When the message was typed during a reply.'
  ),
  staged_context: turn(
    'Staged context',
    'session/staged-context-store.ts',
    'state',
    'When something was staged for the next turn.'
  ),
  env: turn('Environment', 'session/context-assembler.ts', 'state', 'Reserved; not sent today.'),
  relay_context: turn(
    'Relayed message',
    'relay',
    'connection',
    'When the turn answers a relayed message.'
  ),
  room_context: turn(
    'Room messages',
    'runtimes/shared/room-context-block.ts',
    'rooms',
    'In a room turn: what was said, fenced.',
    ['room']
  ),
  seed_context: turn(
    'Why this chat started',
    'runtimes/shared/seed-context-block.ts',
    'state',
    'On the first turn of a spin-off chat.'
  ),
  approval_verdict: turn(
    'Approval answer',
    'runtimes/shared/approval-verdict-block.ts',
    'state',
    'When a person answered an approval card.'
  ),
  direct_notes: turn(
    'Direct notes',
    'runtimes/shared/prose/direct-notes-block.ts',
    'state',
    'When a person left a note for this turn.'
  ),
  accounts_access: turn(
    'Connected accounts',
    'runtimes/shared/accounts-access-context.ts',
    'connection',
    'When the agent can use a connected account.'
  ),
  doc_events: turn(
    'Canvas events',
    'canvas/doc-channel/prompt.ts',
    'state',
    'When a canvas page sent events.'
  ),
  context_warning: turn(
    'Context nearly full',
    'session/agent-compaction/context-warning-block.ts',
    'state',
    'When the chat’s context is nearly full.'
  ),
  turn_cutoff: turn(
    'Turn cut off',
    'session/turn-cutoff/turn-cutoff.ts',
    'state',
    'When the last turn was stopped early.'
  ),
  new_since_last_run: turn(
    'New since last run',
    'session/new-since/turn-note.ts',
    'tasks',
    'On a heartbeat or task run, what changed since.'
  ),
} satisfies Record<ContextKind, Omit<ContextBlockSpec, 'id'>>;

/** This turn's list, in the order the assembler pushes it. */
export const TURN_BLOCKS: readonly ContextBlockSpec[] = (
  Object.entries(TURN_BLOCK_SPECS) as [ContextKind, Omit<ContextBlockSpec, 'id'>][]
).map(([id, spec]) => ({ id, ...spec }));

/**
 * The ids a person may never override, on either route, for any agent — what
 * phase 5's override routes check against (Security ruling 1).
 */
export const LOCKED_BLOCK_IDS: ReadonlySet<string> = new Set(
  [...SESSION_BLOCKS, ...TURN_BLOCKS].filter((block) => block.locked).map((block) => block.id)
);

/**
 * The session block a segment of the builders' output is, or `undefined`.
 *
 * @param segment - One top-level segment of the assembled text.
 */
export function sessionBlockFor(segment: string): ContextBlockSpec | undefined {
  const tag = /^<([a-z_]+)[\s>]/.exec(segment)?.[1];
  if (tag) return SESSION_BLOCKS.find((block) => block.id === tag && !block.match);
  return SESSION_BLOCKS.find((block) => block.match?.test(segment));
}
