import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalBrowserState, LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import { BrowserHandover, type HandoverBrowser } from '../handover.js';
import type { SignInWindow } from '../sign-in-window.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('M1: another profile’s sign-in blocks acts through preparation and saving, while reads work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'signin-act-'));
  directories.push(dir);
  const state: LocalBrowserState = {
    connectionId: 'browser',
    sessionId: 'nova',
    mode: 'new-window',
    status: 'connected',
    paused: false,
    preparation: null,
    revision: 1,
    selectedTabId: 'nova-tab',
    tabs: [{ id: 'nova-tab', url: 'https://nova.example/', title: 'Nova' }],
  };
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const browser: HandoverBrowser = {
    state: vi.fn(async () => state),
    usesPageLeases: () => true,
    capabilities: () => ({ newWindow: true }),
    currentProfileId: () => 'agent-profile',
    profileExists: () => true,
    open: vi.fn(),
    selectTab: vi.fn(),
    navigate: vi.fn(),
    pause: vi.fn(),
    handToPerson: vi.fn(),
    resume: vi.fn(),
    disconnect: vi.fn(),
  };
  let record: LocalBrowserSignIn | null = null;
  const signIns = {
    get current() {
      return record;
    },
    get active() {
      return record?.status === 'open' || record?.status === 'saving';
    },
    holds: () => false, // The person signs into a different profile from the agent.
    start: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      record = { profileId: null, site: 'person.example', status: 'open', startedAt: 'now' };
      return record;
    },
  };
  const handover = new BrowserHandover(browser, signIns as unknown as SignInWindow, () => dir);
  const signingIn = handover.signIn({ url: 'https://person.example/' });
  await waiting;
  try {
    expect(() => handover.requireAgentMayAct()).toThrow(
      expect.objectContaining({
        code: 'signing_in_elsewhere',
      })
    );
    await expect(handover.requireAgentMayUse('nova')).resolves.toBeUndefined();
  } finally {
    release();
  }
  await signingIn;
  for (const status of ['open', 'saving'] as const) {
    record = { profileId: null, site: 'person.example', status, startedAt: 'now' };
    expect(() => handover.requireAgentMayAct()).toThrow(
      expect.objectContaining({
        code: 'signing_in_elsewhere',
      })
    );
    await expect(handover.requireAgentMayUse('nova')).resolves.toBeUndefined();
  }
  for (const status of ['saved', 'failed'] as const) {
    record = { profileId: null, site: 'person.example', status, startedAt: 'now' };
    expect(() => handover.requireAgentMayAct()).not.toThrow();
  }
});
