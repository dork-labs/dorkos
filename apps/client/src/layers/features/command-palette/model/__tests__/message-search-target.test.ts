/**
 * Where a hit opens, and what its row calls the place it was said in
 * (`specs/message-search` §8).
 *
 * @module features/command-palette/model/__tests__/message-search-target
 */
import { describe, it, expect } from 'vitest';
import type { SearchHit } from '@dorkos/shared/search-schemas';
import {
  messageSearchContainerLabel,
  messageSearchSpeaker,
  messageSearchTarget,
} from '../message-search-target';

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    source: 'rooms',
    container: 'room-1',
    containerPath: null,
    ordinal: 7,
    role: 'user',
    createdAt: '2026-08-24T10:00:00.000Z',
    excerpt: 'a pack of <mark>dogs</mark>',
    ...overrides,
  };
}

describe('where a search hit opens', () => {
  it('opens a room hit in the channel it was said in', () => {
    expect(messageSearchTarget(hit())).toEqual({
      kind: 'room',
      to: '/channels',
      search: { id: 'room-1' },
    });
  });

  it('opens a transcript hit in the conversation, carrying its directory', () => {
    // `dir` is not decoration: the durable stream resolves a conversation's
    // history from it, so a session id arriving under whatever directory
    // happened to be on screen reads another project's transcript (DOR-928).
    expect(
      messageSearchTarget(
        hit({ source: 'claude-code', container: 'sess-9', containerPath: '/work/api' })
      )
    ).toEqual({
      kind: 'session',
      to: '/session',
      search: { session: 'sess-9', dir: '/work/api' },
    });
  });

  it('sends no directory rather than a wrong one when the container never named one', () => {
    expect(
      messageSearchTarget(hit({ source: 'claude-code', container: 'sess-9', containerPath: null }))
        .search
    ).toEqual({ session: 'sess-9', dir: undefined });
  });

  it('still opens a conversation whose directory has been deleted', () => {
    // §6.4: the conversation happened and the transcript is on disk, so the hit
    // is returned with its path and stays openable. What changes is what the
    // open action REPORTS, never whether it works.
    const gone = hit({
      source: 'claude-code',
      container: 'sess-old',
      containerPath: '/removed/worktree',
    });
    expect(messageSearchTarget(gone)).toEqual({
      kind: 'session',
      to: '/session',
      search: { session: 'sess-old', dir: '/removed/worktree' },
    });
  });

  it('sends a source it has never heard of to the conversation route', () => {
    // The default is the forward-compatible one on purpose. `rooms` is the only
    // source whose container is a room; every other source in the registry is a
    // conversation with a runtime, and `/session` already resolves those across
    // runtimes. Codex and OpenCode need no change here when they are indexed.
    expect(messageSearchTarget(hit({ source: 'codex', container: 'thread-3' })).kind).toBe(
      'session'
    );
    expect(messageSearchTarget(hit({ source: 'opencode', container: 'oc-3' })).kind).toBe(
      'session'
    );
  });
});

describe('what a hit calls the place it was said in', () => {
  const titles = new Map([['room-1', '#general']]);

  it('names a room the way a person would type it', () => {
    expect(messageSearchContainerLabel(hit(), titles)).toBe('#general');
  });

  it('says what KIND of place it was when the room is not one this cockpit can see', () => {
    // Never the raw id: it is opaque, composed per source, and nobody can read
    // or act on one.
    expect(messageSearchContainerLabel(hit({ container: 'room-unknown' }), titles)).toBe('Channel');
  });

  it('names a conversation by its folder', () => {
    expect(
      messageSearchContainerLabel(
        hit({ source: 'claude-code', container: 'sess-9', containerPath: '/work/api' }),
        titles
      )
    ).toBe('api');
  });

  it('falls back for a conversation that never named a folder', () => {
    expect(
      messageSearchContainerLabel(hit({ source: 'claude-code', container: 'sess-9' }), titles)
    ).toBe('Conversation');
  });
});

describe('who said it', () => {
  it('reads the two roles the same way in a room and in a transcript', () => {
    expect(messageSearchSpeaker('user')).toBe('You');
    expect(messageSearchSpeaker('assistant')).toBe('Agent');
  });
});
