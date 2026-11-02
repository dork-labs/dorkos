/** The handoff's outsider check against what a chat keeps, as startup wires it. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { BrowserHandover } from '../handover.js';
import { liveOutsideTurnCheck, type OutsideTurnSources } from '../outside-turn.js';
import type { SignInWindow } from '../sign-in-window.js';

let dataDirectory: string;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'outside-turn-'));
});
afterEach(() => {
  noteRoomTurnWords('chat-1', false);
  rmSync(dataDirectory, { recursive: true, force: true });
});

/** A check that reads only what the test stores: no agent home, the given launch origin. */
function check(launchOrigin: string | null): ReturnType<typeof liveOutsideTurnCheck> {
  const sources: OutsideTurnSources = {
    agentPathOf: async () => null,
    launchOriginOf: () => launchOrigin,
  };
  return liveOutsideTurnCheck(sources);
}

function handover(launchOrigin: string | null) {
  const state: LocalBrowserState = {
    connectionId: 'c1',
    sessionId: 'chat-1',
    mode: 'new-window',
    status: 'connected',
    paused: false,
    tabs: [{ id: 't1', url: 'https://accounts.example.com/', title: 'Sign in' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
  };
  const browser = {
    state: vi.fn(async () => state),
    currentProfileId: () => null,
    open: vi.fn(async () => state),
    selectTab: vi.fn(async () => state),
    pause: vi.fn(async () => state),
    resume: vi.fn(async () => state),
    disconnect: vi.fn(async () => state),
  };
  const signIns = { current: null, active: false, holds: () => false } as unknown as SignInWindow;
  const subject = new BrowserHandover(browser, signIns, () => dataDirectory);
  subject.useOutsideTurnCheck(check(launchOrigin));
  return { subject, browser };
}

describe('liveOutsideTurnCheck', () => {
  it('refuses a handoff in a chat an outside agent started, before anything pauses', async () => {
    const { subject, browser } = handover('outside-sender');
    await expect(subject.ask('chat-1', 'password')).rejects.toMatchObject({ code: 'outside_turn' });
    expect(browser.pause).not.toHaveBeenCalled();
    expect(browser.selectTab).not.toHaveBeenCalled();
  });

  it.each(['relay-binding', 'connector-event'])('refuses a chat a %s started', async (origin) => {
    await expect(check(origin)('chat-1')).resolves.toBe(true);
  });

  it('refuses a room turn that answered someone outside this machine', async () => {
    noteRoomTurnWords('chat-1', true);
    await expect(check('room')('chat-1')).resolves.toBe(true);
  });

  it('lets a person’s own chat hand the browser over', async () => {
    const { subject, browser } = handover('interactive');
    await expect(subject.ask('chat-1', 'wall')).resolves.toMatchObject({
      site: 'accounts.example.com',
    });
    expect(browser.pause).toHaveBeenCalledOnce();
  });

  it('treats an unreadable launch origin as unknown, not as a stranger', async () => {
    const throwing = liveOutsideTurnCheck({
      agentPathOf: async () => null,
      launchOriginOf: () => {
        throw new Error('no database');
      },
    });
    await expect(throwing('chat-1')).resolves.toBe(false);
  });
});
