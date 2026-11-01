/** The handoff's outsider check against real turn origins, as startup wires it. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { noteTurnOrigin, resetOutsiderTurns } from '../../origin/outsider-turns.js';
import { BrowserHandover } from '../handover.js';
import { liveOutsideTurnCheck } from '../outside-turn.js';
import type { SignInWindow } from '../sign-in-window.js';

let dataDirectory: string;
beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'outside-turn-'));
});
afterEach(() => {
  resetOutsiderTurns();
  rmSync(dataDirectory, { recursive: true, force: true });
});

function handover() {
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
  subject.useOutsideTurnCheck(liveOutsideTurnCheck(async () => null));
  return { subject, browser };
}

describe('liveOutsideTurnCheck', () => {
  it('refuses a handoff on a turn a stranger started, before anything pauses', async () => {
    noteTurnOrigin('chat-1', { kind: 'outside-sender' });
    const { subject, browser } = handover();
    await expect(subject.ask('chat-1', 'password')).rejects.toMatchObject({ code: 'outside_turn' });
    expect(browser.pause).not.toHaveBeenCalled();
    expect(browser.selectTab).not.toHaveBeenCalled();
  });

  it('refuses a turn a bridged chat started', async () => {
    noteTurnOrigin('chat-1', { kind: 'relay-binding' });
    await expect(liveOutsideTurnCheck(async () => null)('chat-1')).resolves.toBe(true);
  });

  it('lets a person’s own turn hand the browser over', async () => {
    noteTurnOrigin('chat-1', { kind: 'interactive' });
    const { subject, browser } = handover();
    await expect(subject.ask('chat-1', 'wall')).resolves.toMatchObject({
      site: 'accounts.example.com',
    });
    expect(browser.pause).toHaveBeenCalledOnce();
  });
});
