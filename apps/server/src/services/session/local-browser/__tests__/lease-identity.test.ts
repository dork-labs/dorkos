import { expect, it, vi } from 'vitest';
import * as access from '../profile-access.js';
import type { Page } from 'playwright-core';
import type { LocalBrowserPageSession } from '../leases/page-session.js';
import { captureAgentPage } from '../leases/agent-page-handle.js';
import { BrowserPageCustody } from '../leases/page-custody.js';
import { heldProtocolCall } from './page-leases-fixture.js';

it.each(['agent', 'runtime', 'folder', 'binding', 'missing'] as const)(
  'birth proof refuses changed %s facts',
  (change) => {
    let row: { runtime: string; agentPath: string } | undefined = {
      runtime: 'claude-code',
      agentPath: '/agents/atlas',
    };
    let agent = 'agent-atlas';
    let folder = '/agents/atlas';
    let bound = true;
    const capture = access.createLocalBrowserProfileProof({
      profiles: { isBound: () => bound },
      sessionFacts: () => row,
      guardsOf: () => ({ protectedPaths: true }),
      agentIdAtPath: () => agent,
      realFolder: () => folder,
    });
    const proof = capture('profile-a', 'chat-a', 'agent-atlas');
    expect(() => proof()).not.toThrow();
    if (change === 'agent') agent = 'agent-other';
    if (change === 'runtime') row!.runtime = 'other-runtime';
    if (change === 'folder') folder = '/agents/moved';
    if (change === 'binding') bound = false;
    if (change === 'missing') row = undefined;
    expect(() => proof()).toThrow();
  }
);

it.each(['page', 'epoch', 'lifecycle'] as const)(
  'a lease rejects changed %s during authorization without inner page fences',
  async (change) => {
    const gate = heldProtocolCall();
    const current = {
      lifecycle: 1,
      epoch: 1,
      page: { isClosed: () => false } as Page,
      status: 'connected',
      sessionId: 'chat-a',
    };
    const session = {
      handover: { isOpenFor: () => false },
      requireProfileAccess: vi.fn(gate.run),
    } as unknown as LocalBrowserPageSession;
    const lease = captureAgentPage(session, () => ({ ...current }));
    const authorization = lease.requireProfileAccess('chat-a');
    await gate.started;
    if (change === 'page') current.page = { isClosed: () => false } as Page;
    else current[change]++;
    gate.release();
    await expect(authorization).rejects.toMatchObject({ code: 'stale_page' });
    expect(() => lease.assertCurrent()).toThrow(expect.objectContaining({ code: 'stale_page' }));
  }
);

it('custody closes agent admission in the same tick as taking the page', async () => {
  const gate = heldProtocolCall();
  const custody = new BrowserPageCustody(() => undefined, gate.run);
  const taking = custody.hold();
  try {
    expect(custody.held).toBe(true);
    expect(custody.epoch).toBe(1);
  } finally {
    gate.release();
    await taking;
  }
});
