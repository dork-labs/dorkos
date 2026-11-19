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

/** A check that reads only what the test stores: no agent home, the given launch origin and marks. */
function check(
  launchOrigin: string | null,
  marks: ReturnType<OutsideTurnSources['marksOf']> = {}
): ReturnType<typeof liveOutsideTurnCheck> {
  const sources: OutsideTurnSources = {
    agentPathOf: async () => null,
    launchOriginOf: () => launchOrigin,
    marksOf: () => marks,
    // A Wi-Fi sign-in's hold binds the turn from its start.
    startedMarked: () => 'unknown',
  };
  return liveOutsideTurnCheck(sources);
}

function handover(launchOrigin: string | null) {
  const state: LocalBrowserState = {
    connectionId: 'c1',
    sessionId: 'chat-1',
    mode: 'embedded',
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
    profileExists: () => true,
    capabilities: () => ({ newWindow: true }),
    open: vi.fn(async () => state),
    selectTab: vi.fn(async () => state),
    navigate: vi.fn(async () => state),
    stepHistory: vi.fn(async () => state),
    pause: vi.fn(async () => state),
    handToPerson: vi.fn(async () => state),
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
    expect(browser.handToPerson).not.toHaveBeenCalled();
    expect(browser.selectTab).not.toHaveBeenCalled();
  });

  it.each(['relay-binding', 'connector-event'])('refuses a chat a %s started', async (origin) => {
    await expect(check(origin)('chat-1')).resolves.toBe('stranger_chat');
  });

  it('refuses a room turn that answered someone outside this machine', async () => {
    noteRoomTurnWords('chat-1', true);
    await expect(check('room')('chat-1')).resolves.toBe('room_outside_words');
  });

  // A Wi-Fi sign-in's hold binds the turn from its start, so it is the turn's own mark.
  it('refuses a turn a Wi-Fi sign-in’s hold marks, in a chat a person started', async () => {
    await expect(check('interactive', { outsider: true })('chat-1')).resolves.toBe('outsider_turn');
  });

  it('lets a person’s own chat with none of the three hand the browser over', async () => {
    const { subject, browser } = handover('interactive');
    await expect(subject.ask('chat-1', 'wall')).resolves.toMatchObject({
      site: 'accounts.example.com',
    });
    expect(browser.handToPerson).toHaveBeenCalledOnce();
  });

  // DOR-4693: the check says which mark it found, so the handoff can tell a page the agent read
  // from a turn a stranger started.
  it.each([
    ['outside-sender', {}, 'clean', 'stranger_chat'],
    ['interactive', { outsider: true }, 'marked', 'outsider_turn'],
    ['interactive', { outsider: true }, 'clean', 'read_outside_text'],
    ['interactive', {}, 'clean', null],
  ] as const)(
    'names the mark: %s, marks %j, started %s → %s',
    async (origin, marks, startedMarked, reason) => {
      const named = liveOutsideTurnCheck({
        agentPathOf: async () => null,
        launchOriginOf: () => origin,
        marksOf: () => marks,
        startedMarked: () => startedMarked,
      });
      await expect(named('chat-1')).resolves.toBe(reason);
    }
  );

  it('names outside words a room or chat message left on the turn', async () => {
    noteRoomTurnWords('chat-1', true);
    await expect(check('interactive')('chat-1')).resolves.toBe('room_outside_words');
  });

  it('treats an unreadable launch origin as unknown, not as a stranger', async () => {
    const throwing = liveOutsideTurnCheck({
      agentPathOf: async () => null,
      marksOf: () => ({}),
      launchOriginOf: () => {
        throw new Error('no database');
      },
    });
    await expect(throwing('chat-1')).resolves.toBeNull();
  });
});

// DOR-4693: an agent that read a block page in the owner's own chat hands it over. Reading the
// page is what marked the turn, and the page is what needs the person.
describe('a handoff on a turn marked only by what it read', () => {
  /** A handover whose turn only a read marked, on a page the classifier did or didn't refuse. */
  function readMarked(opts: { refusedHost: string | null; title?: string; url?: string }) {
    const url = opts.url ?? 'https://www.godaddy.example/';
    const state: LocalBrowserState = {
      connectionId: 'c1',
      sessionId: 'chat-1',
      mode: 'embedded',
      status: 'connected',
      paused: false,
      tabs: [{ id: 't1', url, title: opts.title ?? 'Access Denied' }],
      selectedTabId: 't1',
      revision: 1,
      preparation: null,
    };
    const browser = {
      state: vi.fn(async () => state),
      currentProfileId: () => null,
      profileExists: () => true,
      capabilities: () => ({ newWindow: true }),
      lastRefusalHost: () => opts.refusedHost,
      open: vi.fn(async () => state),
      selectTab: vi.fn(async () => state),
      navigate: vi.fn(async () => state),
      stepHistory: vi.fn(async () => state),
      pause: vi.fn(async () => state),
      handToPerson: vi.fn(async () => state),
      resume: vi.fn(async () => state),
      disconnect: vi.fn(async () => state),
    };
    const signIns = { current: null, active: false, holds: () => false } as unknown as SignInWindow;
    const subject = new BrowserHandover(browser, signIns, () => dataDirectory);
    subject.useOutsideTurnCheck(async () => 'read_outside_text');
    return { subject, browser };
  }

  it('hands over a page the classifier refused on this exact host', async () => {
    const { subject, browser } = readMarked({ refusedHost: 'www.godaddy.example' });
    await expect(subject.ask('chat-1', 'wall')).resolves.toMatchObject({
      site: 'www.godaddy.example',
    });
    expect(browser.handToPerson).toHaveBeenCalledOnce();
  });

  it.each([
    ['an ordinary page', null],
    ['a refusal on another host', 'accounts.northwind.example'],
  ])('still refuses %s, and names the mark', async (_label, refusedHost) => {
    const { subject, browser } = readMarked({ refusedHost });
    await expect(subject.ask('chat-1', 'wall')).rejects.toMatchObject({
      code: 'outside_turn',
      fields: { reason: 'read_outside_text' },
    });
    expect(browser.handToPerson).not.toHaveBeenCalled();
  });

  it('names the site from the address, never from a title that claims another', async () => {
    const { subject } = readMarked({
      refusedHost: 'www.godaddy.example',
      title: 'Sign in to accounts.northwind.example',
    });
    const handed = await subject.ask('chat-1', 'password');
    expect(handed.site).toBe('www.godaddy.example');
    expect(handed.site).not.toContain('northwind');
  });

  it.each(['stranger_chat', 'room_outside_words', 'outsider_turn'] as const)(
    'refuses %s even on a refused page',
    async (reason) => {
      const { subject, browser } = readMarked({ refusedHost: 'www.godaddy.example' });
      subject.useOutsideTurnCheck(async () => reason);
      await expect(subject.ask('chat-1', 'wall')).rejects.toMatchObject({
        code: 'outside_turn',
        fields: { reason },
      });
      expect(browser.handToPerson).not.toHaveBeenCalled();
    }
  );
});
