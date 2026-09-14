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
  type MessageSearchTarget,
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

/**
 * The search params of a target that goes somewhere.
 *
 * Throws rather than returning `undefined` for a hit that opens nothing, so a
 * case that stopped being openable fails on the assertion it was written for
 * instead of quietly comparing two `undefined`s.
 *
 * @param target - The resolved target.
 */
function searchOf(target: MessageSearchTarget) {
  if (target.kind === 'unopenable') throw new Error('expected a target that opens something');
  return target.search;
}

describe('where a search hit opens', () => {
  it('opens a room hit ON the message, not merely in the channel', () => {
    // The `seq` is the whole of DOR-687. A room addresses its own rows by it,
    // and `ordinal` IS the entry's `seq` for this source — so the coordinate
    // the index already returns is an address, with nothing added to the wire.
    expect(messageSearchTarget(hit())).toEqual({
      kind: 'room',
      to: '/channels',
      search: { id: 'room-1', entry: 7 },
    });
  });

  it('carries the hit’s own seq, not a constant', () => {
    // The positive control for the line above: without it, a target hard-coding
    // any number at all would pass.
    expect(searchOf(messageSearchTarget(hit({ ordinal: 412 })))).toEqual({
      id: 'room-1',
      entry: 412,
    });
  });

  it('opens a conversation hit ON the message when the source’s ids are verified', () => {
    // The other half of DOR-687, closed by DOR-1579. `claude-code` stores the
    // JSONL record uuid and the session view renders the message under the same
    // uuid, so the id is an address there.
    expect(
      searchOf(
        messageSearchTarget(
          hit({
            source: 'claude-code',
            container: 'sess-9',
            sessionId: 'sess-9',
            containerPath: '/work/api',
            messageId: 'uuid-1',
          })
        )
      )
    ).toEqual({ session: 'sess-9', dir: '/work/api', message: 'uuid-1' });
  });

  it('opens an OpenCode hit on the message too', () => {
    // The second verified source: the index stores OpenCode's own `message.id`
    // and its session view renders that message under the same id.
    expect(
      searchOf(
        messageSearchTarget(
          hit({
            source: 'opencode',
            container: 'ses_a',
            sessionId: '9f4c1d2e-0000-5000-8000-000000000001',
            messageId: 'msg_7',
          })
        )
      )
    ).toEqual({
      session: '9f4c1d2e-0000-5000-8000-000000000001',
      dir: undefined,
      message: 'msg_7',
    });
  });

  it('opens the DorkOS session, never the runtime’s own container id', () => {
    // DOR-2020, and the sharpest form of it. An OpenCode `ses_…` and a Codex
    // thread id name a conversation inside another program; `/session` resolves
    // neither, so the box found the message and opened an empty screen. Red if
    // anything goes back to passing `container` through.
    for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
      const target = messageSearchTarget(
        hit({ source: runtime, container: 'native-id', sessionId: 'dorkos-uuid' })
      );
      expect(searchOf(target)).toMatchObject({ session: 'dorkos-uuid' });
    }
  });

  it('sends no message for a source whose ids have not been verified', () => {
    // Codex carries a perfectly good `response_item` id in the index, and the
    // session view rebuilds a Codex conversation from DorkOS's own event log
    // under `user-<seq>` / `assistant-<seq>`. The two never match, so a param
    // would be dead weight pretending to be a link. Red if the allowlist is
    // dropped and "has an id" becomes the whole test.
    expect(
      searchOf(
        messageSearchTarget(
          hit({
            source: 'codex',
            container: 'thread-3',
            sessionId: 'dorkos-uuid-c',
            messageId: 'item_42',
          })
        )
      )
    ).toEqual({ session: 'dorkos-uuid-c', dir: undefined });
  });

  it('sends no message for a verified source when the hit has no id', () => {
    // The paired control for the case above: the allowlist is not the only
    // gate. A `claude-code` row indexed before ids existed, or from a record
    // that carried none, degrades to opening the conversation.
    expect(
      searchOf(
        messageSearchTarget(
          hit({ source: 'claude-code', container: 'sess-9', sessionId: 'sess-9' })
        )
      )
    ).toEqual({
      session: 'sess-9',
      dir: undefined,
    });
  });

  it('sends a conversation hit to the conversation and drops its ordinal', () => {
    // The honest half. A transcript hit's `ordinal` counts only the messages
    // the projection KEPT — tool calls, tool results, thinking and command
    // records are all skipped — so it indexes nothing the session view holds,
    // and `messages[ordinal]` there is reliably a different message. A link
    // that lands on the wrong line is worse than one that lands in the right
    // conversation, so the ordinal is deliberately not passed on.
    expect(
      searchOf(
        messageSearchTarget(
          hit({
            source: 'claude-code',
            container: 'sess-9',
            sessionId: 'sess-9',
            containerPath: '/work/api',
            ordinal: 3,
          })
        )
      )
    ).toEqual({ session: 'sess-9', dir: '/work/api' });
  });

  it('opens a transcript hit in the conversation, carrying its directory', () => {
    // `dir` is not decoration: the durable stream resolves a conversation's
    // history from it, so a session id arriving under whatever directory
    // happened to be on screen reads another project's transcript (DOR-928).
    expect(
      messageSearchTarget(
        hit({
          source: 'claude-code',
          container: 'sess-9',
          sessionId: 'sess-9',
          containerPath: '/work/api',
        })
      )
    ).toEqual({
      kind: 'session',
      to: '/session',
      search: { session: 'sess-9', dir: '/work/api' },
    });
  });

  it('sends no directory rather than a wrong one when the container never named one', () => {
    expect(
      searchOf(
        messageSearchTarget(
          hit({
            source: 'claude-code',
            container: 'sess-9',
            sessionId: 'sess-9',
            containerPath: null,
          })
        )
      )
    ).toEqual({ session: 'sess-9', dir: undefined });
  });

  it('still opens a conversation whose directory has been deleted', () => {
    // §6.4: the conversation happened and the transcript is on disk, so the hit
    // is returned with its path and stays openable. What changes is what the
    // open action REPORTS, never whether it works.
    const gone = hit({
      source: 'claude-code',
      container: 'sess-old',
      sessionId: 'sess-old',
      containerPath: '/removed/worktree',
    });
    expect(messageSearchTarget(gone)).toEqual({
      kind: 'session',
      to: '/session',
      search: { session: 'sess-old', dir: '/removed/worktree' },
    });
  });

  it('opens nothing for a conversation DorkOS never ran', () => {
    // The bare-CLI case, on every runtime. The transcript is on this machine
    // and the words are searchable; there is no DorkOS session behind them, so
    // the honest answer is a row with no link rather than one that opens an
    // empty screen.
    for (const runtime of ['claude-code', 'codex', 'opencode', 'some-future-source'] as const) {
      expect(messageSearchTarget(hit({ source: runtime, container: 'native-id' }))).toEqual({
        kind: 'unopenable',
      });
    }
  });

  it('sends a source it has never heard of to the conversation route', () => {
    // The default is the forward-compatible one on purpose. `rooms` is the only
    // source whose container is a room; every other source in the registry is a
    // conversation with a runtime, and `/session` already resolves those across
    // runtimes. A future source needs no change here — as long as the server
    // tells it which session the hit opens.
    expect(
      messageSearchTarget(hit({ source: 'codex', container: 'thread-3', sessionId: 'dork-1' })).kind
    ).toBe('session');
    expect(
      messageSearchTarget(hit({ source: 'opencode', container: 'oc-3', sessionId: 'dork-2' })).kind
    ).toBe('session');
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
