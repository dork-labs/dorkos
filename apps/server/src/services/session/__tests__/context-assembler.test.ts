import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/git-status.js', () => ({
  getGitStatus: vi.fn(),
}));

import { assembleAdditionalContext } from '../context-assembler.js';
import { getGitStatus } from '../../core/git-status.js';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { ClientContextSchema } from '@dorkos/shared/additional-context';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import type { GitStatusResponse } from '@dorkos/shared/types';
import type { UiState } from '@dorkos/shared/types';

const mockedGetGitStatus = vi.mocked(getGitStatus);

function makeGitStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    detached: false,
    tracking: 'origin/main',
    ...overrides,
  };
}

const SAMPLE_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: true, relay: false, picker: false },
  sidebar: { open: true, activeTab: 'sessions' },
  agent: { id: 'agent-1', cwd: '/proj' },
};

const SAMPLE_ROOM_CONTEXT: RoomContextData = {
  room: { id: 'room-1', kind: 'channel', name: '#build', bridged: false },
  thread: null,
  members: [{ handle: 'ana', displayName: 'Ana', isPerson: false, isSelf: true, origin: 'local' }],
  working: [],
  pending: [],
  pendingTruncated: false,
  ownRecent: [],
  acknowledgments: [],
  triggerEntryId: 'entry-trigger',
  triggerAttachments: [],
  addressing: {
    responseMode: 'always',
    engagedUntil: null,
    engagedPostsLeft: null,
    addressedNow: false,
  },
  budget: {
    automaticRepliesLeftInThisRoomThisHour: 41,
    automaticRepliesLeftInTotalThisHour: 187,
    repliesLeftInThisChain: 2,
  },
};

describe('assembleAdditionalContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
  });

  it('merges git_status, ui_state, and queue_note when client signals present', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: [],
    });

    const git = bag.find((e) => e.kind === 'git_status');
    expect(git).toBeDefined();
    expect(git!.kind === 'git_status' && git!.data.isRepo).toBe(true);
    expect(git!.kind === 'git_status' && git!.data.branch).toBe('main');

    const ui = bag.find((e) => e.kind === 'ui_state');
    expect(ui).toBeDefined();
    expect(ui!.kind === 'ui_state' && ui!.data).toEqual(SAMPLE_UI_STATE);

    const queue = bag.find((e) => e.kind === 'queue_note');
    expect(queue).toBeDefined();
    expect(queue!.kind === 'queue_note' && queue!.data.composedDuringPrevTurn).toBe(true);
  });

  it('omits git_status when the runtime declares it native, keeping ui_state/queue_note', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: ['git_status'],
    });

    expect(bag.find((e) => e.kind === 'git_status')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'ui_state')).toBeDefined();
    expect(bag.find((e) => e.kind === 'queue_note')).toBeDefined();
  });

  it('yields git_status { isRepo: false } when getGitStatus returns an error', async () => {
    mockedGetGitStatus.mockResolvedValue({ error: 'not_git_repo' as const });
    const bag = await assembleAdditionalContext({ cwd: '/not-a-repo', nativeContext: [] });

    const git = bag.find((e) => e.kind === 'git_status');
    expect(git).toBeDefined();
    expect(git!.kind === 'git_status' && git!.data).toEqual({ isRepo: false });
  });

  it('omits ui_state and queue_note when no client signals are supplied', async () => {
    const bag = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
    expect(bag.find((e) => e.kind === 'ui_state')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'queue_note')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'git_status')).toBeDefined();
  });

  it('does NOT emit queue_note when queued is false', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { queued: false },
      nativeContext: [],
    });
    expect(bag.find((e) => e.kind === 'queue_note')).toBeUndefined();
  });

  it('returns { isRepo: false } when getGitStatus throws', async () => {
    mockedGetGitStatus.mockRejectedValue(new Error('git missing'));
    const bag = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
    const git = bag.find((e) => e.kind === 'git_status');
    expect(git!.kind === 'git_status' && git!.data).toEqual({ isRepo: false });
  });

  it('emits room_context only when a room triggered the turn', async () => {
    const withoutRoom = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
    expect(withoutRoom.find((e) => e.kind === 'room_context')).toBeUndefined();

    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      roomContext: SAMPLE_ROOM_CONTEXT,
      nativeContext: [],
    });
    const room = bag.find((e) => e.kind === 'room_context');
    expect(room?.kind === 'room_context' && room.data.room.name).toBe('#build');
    expect(room?.scope).toBe('per-turn');
  });

  it('omits room_context for a runtime that injects it natively', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      roomContext: SAMPLE_ROOM_CONTEXT,
      nativeContext: ['room_context'],
    });
    expect(bag.find((e) => e.kind === 'room_context')).toBeUndefined();
  });

  it('cannot be handed a room context by a client', () => {
    // Room context is server-derived on purpose: a roster a caller could supply
    // is a roster a caller could forge. `ClientContext` is what comes off the
    // wire, and it has no door for one.
    const parsed = ClientContextSchema.parse({
      queued: true,
      roomContext: SAMPLE_ROOM_CONTEXT,
    });
    expect(parsed).toEqual({ queued: true });
  });

  describe('seed_context', () => {
    it('carries a caller-supplied seed as its own entry', async () => {
      mockedGetGitStatus.mockResolvedValue(makeGitStatus());
      const bag = await assembleAdditionalContext({
        cwd: '/proj',
        seedContext: 'they came from the marketplace page',
        nativeContext: [],
      });
      expect(bag.find((e) => e.kind === 'seed_context')).toEqual({
        kind: 'seed_context',
        scope: 'per-turn',
        data: { text: 'they came from the marketplace page' },
      });
    });

    it('emits nothing when no seed was supplied', async () => {
      mockedGetGitStatus.mockResolvedValue(makeGitStatus());
      const bag = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
      expect(bag.find((e) => e.kind === 'seed_context')).toBeUndefined();
    });

    it('bounds an over-length seed HERE, not only at the HTTP route', async () => {
      // The route's `400` is a bound on one of two doors. The embedded
      // (Obsidian / DirectTransport) path never meets `SendMessageRequestSchema`,
      // so before this the same 10 MB seed that a `fetch` could not get past the
      // route went straight into the prompt in-process. This is the choke point
      // both doors share.
      mockedGetGitStatus.mockResolvedValue(makeGitStatus());
      const huge = 'x'.repeat(SEED_CONTEXT_MAX_LENGTH * 3);
      const bag = await assembleAdditionalContext({
        cwd: '/proj',
        seedContext: huge,
        nativeContext: [],
      });

      const entry = bag.find((e) => e.kind === 'seed_context');
      expect(entry).toBeDefined();
      const text = (entry as { data: { text: string } }).data.text;
      expect(text.length).toBeLessThan(huge.length);
      expect(text.startsWith('x'.repeat(SEED_CONTEXT_MAX_LENGTH))).toBe(true);
      // Cut, and SAYS it was cut — an agent reading a fragment must not take it
      // for the whole of what it was told. Dropping the entry silently is the
      // one outcome this feature must never have.
      expect(text).toContain('truncated');
    });

    it('leaves a seed at exactly the bound untouched', async () => {
      mockedGetGitStatus.mockResolvedValue(makeGitStatus());
      const exact = 'y'.repeat(SEED_CONTEXT_MAX_LENGTH);
      const bag = await assembleAdditionalContext({
        cwd: '/proj',
        seedContext: exact,
        nativeContext: [],
      });
      expect(
        (bag.find((e) => e.kind === 'seed_context') as { data: { text: string } }).data.text
      ).toBe(exact);
    });

    it('omits the seed when the runtime injects the kind natively', async () => {
      mockedGetGitStatus.mockResolvedValue(makeGitStatus());
      const bag = await assembleAdditionalContext({
        cwd: '/proj',
        seedContext: 'background',
        nativeContext: ['seed_context'],
      });
      expect(bag.find((e) => e.kind === 'seed_context')).toBeUndefined();
    });
  });

  it('never emits an env entry (env flows via systemPrompt.append, G2)', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: [],
    });
    expect(bag.find((e) => e.kind === 'env')).toBeUndefined();
  });
});
