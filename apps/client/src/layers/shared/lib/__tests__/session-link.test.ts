// @vitest-environment jsdom
/**
 * The one builder for links into a conversation (DOR-2077).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { parseAppSearch } from '../router-search';
import {
  newSessionTarget,
  sessionHref,
  sessionSearchSchema,
  toSession,
  type SessionSearch,
} from '../session-link';

describe('toSession', () => {
  it('is the session route with the params it was given', () => {
    expect(toSession({ session: 'abc', dir: '/p' })).toEqual({
      to: '/session',
      search: { session: 'abc', dir: undefined },
    });
  });

  it('passes a function of the current params through untouched', () => {
    const update = (prev: SessionSearch) => ({ ...prev, dir: '/q' });
    expect(toSession(update).search({ session: 'abc' })).toEqual({
      session: 'abc',
      dir: undefined,
    });
  });
});

describe('directory privacy', () => {
  it('rejects raw directory launch targets that have not been prepared', () => {
    expect(() => toSession({ dir: '/private/project' })).toThrow('sessionLocationTarget');
    expect(() => toSession({ session: 'new', draft: '1', dir: '/private/project' })).toThrow(
      'newSessionTarget'
    );
    expect(() => sessionHref({ dir: '/private/project' })).toThrow('agent ID');
  });
  it('removes legacy directory hints from existing links', () => {
    expect(
      sessionHref({ session: 'existing', dir: '/private/project', agentPath: '/private/agent' })
    ).toBe('/session?session=existing');
    expect(
      toSession({ session: 'existing', dir: '/private/project', agentPath: '/private/agent' })
        .search
    ).toMatchObject({ dir: undefined, agentPath: undefined });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('newSessionTarget', () => {
  it('keeps two overlapping intentional drafts for the same source distinct', async () => {
    const transport = createMockTransport();
    const firstAck = deferred<{ sessionId: string }>();
    const secondAck = deferred<{ sessionId: string }>();
    vi.mocked(transport.allocateSession)
      .mockReturnValueOnce(firstAck.promise)
      .mockReturnValueOnce(secondAck.promise);
    const first = newSessionTarget(transport, { launchRef: 'source', prompt: 'first' });
    const second = newSessionTarget(transport, { launchRef: 'source', prompt: 'second' });
    expect(transport.allocateSession).toHaveBeenCalledTimes(2);
    secondAck.resolve({ sessionId: 'second-chat' });
    firstAck.resolve({ sessionId: 'first-chat' });
    expect((await first).search).toMatchObject({ session: 'first-chat', prompt: 'first' });
    expect((await second).search).toMatchObject({ session: 'second-chat', prompt: 'second' });
  });

  it('uses the registered acknowledgement without reserving a folder', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.allocateSession).mockResolvedValue({ sessionId: 'known-ack' });
    const target = await newSessionTarget(transport, { agentId: 'registered', prompt: 'hello' });
    expect(transport.allocateSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'registered-agent',
      agentId: 'registered',
    });
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
    expect(transport.getDefaultCwd).not.toHaveBeenCalled();
    expect(target.search).toMatchObject({
      agentId: 'registered',
      session: 'known-ack',
      draft: '1',
      prompt: 'hello',
    });
  });

  it('keeps the id of a direct seat or an already-acknowledged draft', async () => {
    const transport = createMockTransport();
    const direct = await newSessionTarget(transport, { session: 'server-seat', dir: '/agent' });
    const draft = await newSessionTarget(transport, {
      session: 'server-draft',
      launchRef: 'folder',
    });
    expect(direct.search).toMatchObject({ session: 'server-seat', launchRef: 'test-location' });
    expect(draft.search).toMatchObject({ session: 'server-draft', launchRef: 'folder' });
    expect(transport.allocateSession).not.toHaveBeenCalled();
  });

  it('does not invent an id or retry when acknowledgement is refused', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.allocateSession).mockRejectedValue(new Error('allocation refused'));
    await expect(newSessionTarget(transport, { launchRef: 'folder' })).rejects.toThrow(
      'allocation refused'
    );
    expect(transport.allocateSession).toHaveBeenCalledTimes(1);
    expect(transport.createSessionLocation).not.toHaveBeenCalled();
  });
});

describe('sessionHref', () => {
  it('always has the route path in front of the session id', () => {
    // The tunnel's "copy session link" used to be the origin plus `?session=`,
    // with no `/session` — the half of DOR-2077 that was a wrong address.
    expect(sessionHref({ session: 'abc' })).toBe('/session?session=abc');
  });

  /**
   * Values a hand-built query gets wrong: a path with spaces and `&`, a prompt
   * that is a number or a boolean as far as a JSON parser is concerned, text
   * outside ASCII.
   */
  const AWKWARD: SessionSearch[] = [
    { session: 'abc' },
    { launchRef: 'location', draft: '1', prompt: '123', runtime: 'codex' },
    { session: 'abc', prompt: 'true' },
    { session: 'abc', prompt: 'null' },
    { session: 'abc', prompt: '{"a":1}' },
    { session: 'abc', prompt: 'résumé — 東京' },
    { session: 'abc', send: '1' },
  ];

  it.each(AWKWARD)('writes %o exactly as the router would', (search) => {
    // Purpose: an href is followed by the router's own parser, so the string
    // has to be the one the router writes for itself — otherwise `prompt=123`
    // comes back as a number and the route refuses it.
    expect(sessionHref(search)).toBe(`/session${defaultStringifySearch(search)}`);
  });

  it.each(AWKWARD)('reads %o back as the same params', (search) => {
    const query = sessionHref(search).slice('/session'.length);
    expect(sessionSearchSchema.parse(defaultParseSearch(query))).toEqual(search);
  });
});

describe('browser launch flag parsing', () => {
  it('preserves raw numeric URL flags as the canonical string flags', () => {
    const search = sessionSearchSchema.parse(
      parseAppSearch('?session=draft-id&launchRef=opaque&draft=1&send=1')
    );
    expect(search).toMatchObject({
      session: 'draft-id',
      launchRef: 'opaque',
      draft: '1',
      send: '1',
    });
  });
  it.each(['0', 'true', 'please'])('does not treat %s as launch consent', (value) => {
    const search = sessionSearchSchema.parse(parseAppSearch(`?draft=${value}&send=${value}`));
    expect(search.draft).toBeUndefined();
    expect(search.send).toBeUndefined();
  });
});
