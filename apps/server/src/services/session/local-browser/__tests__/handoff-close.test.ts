import { expect, it, vi } from 'vitest';
import { BrowserPageClosing } from '../leases/page-closing.js';
import { captureHandoffClose } from '../handoff-guards/handoff-close.js';
import { prepareHandoffPage, requireHandoffPage } from '../handoff-guards/prepare-handoff.js';
import type { HandoverBrowser } from '../handover.js';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';

function fixture() {
  const closing = new BrowserPageClosing();
  const identity = {
    lifecycle: 1,
    connectionId: 'connection-a' as string | null,
    sessionId: 'chat-a' as string | null,
    profileId: 'profile-a' as string | null,
    status: 'connected',
  };
  let settle!: () => void;
  let fail!: (error: Error) => void;
  const physical = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const disconnect = vi.fn(() =>
    closing.run(
      () => {
        identity.lifecycle++;
      },
      async () => {
        await physical;
        identity.connectionId = identity.sessionId = null;
        identity.status = 'disconnected';
      }
    )
  );
  const authority = vi.fn();
  const host = {
    closing,
    identity: () => ({ ...identity }),
    disconnect,
    assertAuthority: authority,
  };
  return { closing, identity, settle, fail, disconnect, host, authority };
}

it('joins only the admitted pending close, without issuing a second close', async () => {
  const f = fixture();
  const closing = f.disconnect();
  const proof = captureHandoffClose(f.host);
  expect(proof.completed()).toBe(false);
  f.settle();
  await closing;
  expect(proof.completed()).toBe(true);
  await proof.close();
  expect(f.disconnect).toHaveBeenCalledOnce();
});

it('certifies its own requested close after capturing a connected admission', async () => {
  const f = fixture();
  const proof = captureHandoffClose(f.host);
  const closing = proof.close();
  f.settle();
  await closing;
  expect(proof.completed()).toBe(true);
  expect(() => proof.assertClosed()).not.toThrow();
});

it('a disconnected or crashed state without this close receipt never proves completion', () => {
  const f = fixture();
  const proof = captureHandoffClose(f.host);
  f.identity.status = 'closed';
  expect(proof.completed()).toBe(false);
  expect(() => proof.assertClosed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
  f.identity.status = 'disconnected';
  f.identity.connectionId = f.identity.sessionId = null;
  expect(() => proof.assertClosed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
});

it('a failed physical close never yields a receipt', async () => {
  const f = fixture();
  const closing = f.disconnect();
  const refused = expect(closing).rejects.toMatchObject({ code: 'busy' });
  const proof = captureHandoffClose(f.host);
  f.fail(new Error('close failed'));
  await refused;
  expect(proof.completed()).toBe(false);
  expect(() => proof.assertClosed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
});

it.each(['lifecycle', 'connection', 'chat', 'profile', 'crash'] as const)(
  'refuses %s substitution even after a successful owned close',
  async (change) => {
    const f = fixture();
    const closing = f.disconnect();
    const proof = captureHandoffClose(f.host);
    f.settle();
    await closing;
    if (change === 'lifecycle') f.identity.lifecycle++;
    if (change === 'connection') f.identity.connectionId = 'replacement';
    if (change === 'chat') f.identity.sessionId = 'other-chat';
    if (change === 'profile') f.identity.profileId = 'other-profile';
    if (change === 'crash') f.identity.status = 'closed';
    expect(() => proof.completed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
  }
);

it('revocation remains a refusal after the close has completed', async () => {
  const f = fixture();
  const closing = f.disconnect();
  const proof = captureHandoffClose(f.host);
  f.settle();
  await closing;
  f.authority.mockImplementation(() => {
    throw Object.assign(new Error('revoked'), { code: 'profile_not_allowed' });
  });
  expect(() => proof.completed()).toThrow(expect.objectContaining({ code: 'profile_not_allowed' }));
});

it('freezes the admitted URL, profile and chat before waiting', () => {
  const tab = { id: 'tab-a', url: 'https://example.test/admitted', title: 'Example' };
  const state = {
    status: 'connected',
    connectionId: 'connection-a',
    sessionId: 'chat-a',
    mode: 'new-window',
    selectedTabId: tab.id,
    tabs: [tab],
  } as LocalBrowserState;
  let profile = 'profile-a';
  const browser = {
    currentProfileId: () => profile,
    requireExclusiveProfile: vi.fn(),
  } as unknown as HandoverBrowser;
  const snapshot = prepareHandoffPage(browser, state, 'chat-a');
  tab.url = 'https://other.test/replaced';
  state.sessionId = 'other-chat';
  profile = 'other-profile';
  expect(snapshot.tab.url).toBe('https://example.test/admitted');
  expect(snapshot.profileId).toBe('profile-a');
  expect(snapshot.chatId).toBe('chat-a');
  expect(() => requireHandoffPage(browser, snapshot, state)).toThrow(
    expect.objectContaining({ code: 'site_changed' })
  );
});

it('refuses a mismatched chat as site_changed without restoring the retired sharing refusal', () => {
  const state = {
    status: 'connected',
    sessionId: 'other-chat',
    selectedTabId: 'tab-a',
    tabs: [{ id: 'tab-a', url: 'https://example.test/' }],
  } as LocalBrowserState;
  expect(() => prepareHandoffPage({} as HandoverBrowser, state, 'chat-a')).toThrow(
    expect.objectContaining({
      code: 'site_changed',
      message: 'The page changed. Read it again before acting.',
    })
  );
});

it('refuses a replacement already pending when admission names the previous connection', () => {
  const f = fixture();
  expect(() =>
    captureHandoffClose(f.host, {
      connectionId: 'old-connection',
      sessionId: 'chat-a',
      profileId: 'profile-a',
    })
  ).toThrow(expect.objectContaining({ code: 'site_changed' }));
});
