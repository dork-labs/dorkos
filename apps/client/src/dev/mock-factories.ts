import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  agentAuthorRef,
  REACTION_FREQUENTS_DEFAULT,
  type AuthorRef,
  type RoomRosterEntry,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import type {
  ChatMessage,
  ToolCallState,
  HookState,
} from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/composer';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { AgentPickerCandidate, AgentRoster } from '@/layers/entities/agent';
import type { TaskItem } from '@dorkos/shared/types';

/** Shared mock session ID for playground demos that require a session context. */
export const MOCK_SESSION_ID = 'playground-session-001';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix = 'mock') {
  return `${prefix}-${++idCounter}`;
}

/** Create a user message with sensible defaults. */
export function createUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = nextId('user');
  const content = overrides.content ?? 'Hello, can you help me?';
  return {
    id,
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create an assistant message with sensible defaults. */
export function createAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = nextId('asst');
  const content = overrides.content ?? 'Sure, I can help with that.';
  return {
    id,
    role: 'assistant',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a tool call with sensible defaults. */
export function createToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolCallId: nextId('tc'),
    toolName: 'Read',
    input: JSON.stringify({ file_path: '/src/index.ts' }),
    status: 'complete',
    ...overrides,
  };
}

/** Create a task item with sensible defaults. */
export function createTaskItem(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: nextId('task'),
    subject: 'Implement feature',
    status: 'pending',
    ...overrides,
  };
}

/** Create a pending file with sensible defaults. */
export function createPendingFile(overrides: Partial<PendingFile> = {}): PendingFile {
  const id = nextId('file');
  return {
    id,
    file: new File(['content'], overrides.file?.name ?? 'document.txt', {
      type: overrides.file?.type ?? 'text/plain',
    }),
    status: 'pending',
    progress: 0,
    ...overrides,
  };
}

/** Create a queue item with sensible defaults. */
export function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: nextId('q'),
    content: 'Follow-up message',
    mine: true,
    notice: null,
    ...overrides,
  };
}

/** Create a hook state with sensible defaults. */
export function createHookState(overrides: Partial<HookState> = {}): HookState {
  return {
    hookId: nextId('hook'),
    hookName: 'pre-commit-lint',
    hookEvent: 'PreToolUse',
    status: 'running',
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * A fixed clock for room fixtures, so "joined 3 days ago" says the same thing
 * on every render.
 *
 * The room surfaces print relative times (`formatRelativeTime`), and a fixture
 * built from `Date.now()` would drift a showcase's copy between two visits to
 * the same page — which is the kind of difference a reviewer wastes a minute
 * on. Anything that has to look recent is offset from here.
 */
const MOCK_ROOM_NOW = new Date('2026-07-30T09:00:00.000Z');

/** An ISO timestamp `minutes` before {@link MOCK_ROOM_NOW}. */
export function minutesBeforeNow(minutes: number): string {
  return new Date(MOCK_ROOM_NOW.getTime() - minutes * 60_000).toISOString();
}

/** Create a room author. A person unless told otherwise — see {@link createAgentAuthor}. */
export function createRoomAuthor(overrides: Partial<AuthorRef> = {}): AuthorRef {
  return {
    id: nextId('author'),
    kind: 'human',
    displayName: 'Dorian',
    handle: null,
    ...overrides,
  };
}

/**
 * Create an agent author, with the same one-way handle the server derives.
 *
 * `agentRef` is `agentAuthorRef(agentPath)` rather than a made-up string,
 * because that is the join the sheet makes between a roster row and the fleet
 * (see `useRoomDetailsView`). A fixture that invented one would render every
 * agent faceless and make the undo path unreachable — while looking fine.
 *
 * @param agentPath - The agent's directory, as the fleet reports it.
 * @param overrides - Anything else about the author.
 */
export function createAgentAuthor(
  agentPath: string,
  overrides: Partial<AuthorRef> = {}
): AuthorRef {
  return createRoomAuthor({
    kind: 'agent',
    displayName: agentPath.split('/').pop() ?? 'agent',
    agentRef: agentAuthorRef(agentPath),
    ...overrides,
  });
}

/** Create one roster row — a membership with its author already resolved. */
export function createRoomMember(overrides: Partial<RoomRosterEntry> = {}): RoomRosterEntry {
  const author = overrides.author ?? createRoomAuthor();
  return {
    roomId: 'room-general',
    authorId: author.id,
    responseMode: 'engaged',
    joinedAt: minutesBeforeNow(60 * 24 * 3),
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    ...overrides,
    author,
  };
}

/** Create a room with its roster — the body `GET /api/rooms/:id` returns. */
export function createRoomWithRoster(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  const members = overrides.members ?? [];
  return {
    id: 'room-general',
    kind: 'channel',
    slug: 'general',
    title: 'General',
    topic: 'Where the day starts',
    archived: false,
    ambientMaxEntries: 30,
    createdAt: minutesBeforeNow(60 * 24 * 12),
    lastActivityAt: minutesBeforeNow(9),
    viewerAuthorId:
      members.find((member) => member.author.kind !== 'agent')?.authorId ?? 'author-me',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    ...overrides,
    members,
  };
}

/** Create an agent the picker may offer. */
export function createAgentPickerCandidate(
  overrides: Partial<AgentPickerCandidate> = {}
): AgentPickerCandidate {
  const agentPath = overrides.agentPath ?? '/Users/dev/agents/reviewer';
  return {
    agentPath,
    displayName: agentPath.split('/').pop() ?? 'agent',
    visual: { color: '#6366f1', emoji: '🔍' },
    description: null,
    ...overrides,
  };
}

/** Create the fleet a picker reads, loaded and without failure unless told. */
export function createAgentRoster(overrides: Partial<AgentRoster> = {}): AgentRoster {
  return {
    candidates: [],
    isLoading: false,
    isError: false,
    retry: () => {},
    ...overrides,
  };
}

/**
 * Create an agent manifest, for a showcase that drives the fleet through the
 * real `resolveAgents` read rather than handing candidates over directly.
 */
export function createAgentManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  const name = overrides.name ?? 'reviewer';
  return {
    workspace: { mode: 'home' },
    id: nextId('agent'),
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: minutesBeforeNow(60 * 24 * 30),
    registeredBy: 'playground',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}
