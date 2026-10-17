/**
 * @vitest-environment node
 *
 * The dialer's pin (DOR-2946): none while the Chat from the web experiment is
 * off or the owner has paused the link, so nothing dials either way; and
 * switching the experiment off closes a live relay at once.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'sessionRelay' ? { enabled: state.enabled } : undefined)),
  },
}));

import {
  dialablePin,
  sessionRelayDialer,
  sessionRelayEnabled,
  watchSessionRelaySwitch,
} from '../index.js';
import { RelayDialer } from '../relay-dialer.js';
import { readRelayPin, withRelayPinLock, writeRelayPin, type RelayPin } from '../pin-store.js';

const PIN: RelayPin = {
  v: 2,
  computerId: 'computer-1',
  hubOrigin: 'https://dorian.hub.example.test',
  hubKey: randomBytes(32).toString('base64url'),
  relaySecret: randomBytes(32).toString('base64url'),
  pinnedAt: '2026-10-16T21:00:00.000Z',
  computerName: 'Studio Mac',
  level: 'chat',
  paused: false,
};

beforeEach(() => {
  state.enabled = true;
});

describe('the pin the dialer may use', () => {
  it('is the pin, with the experiment on and the link not paused', () => {
    expect(sessionRelayEnabled()).toBe(true);
    expect(dialablePin(() => PIN)).toEqual(PIN);
  });

  it('is none while the experiment is off, even with a pin saved', () => {
    state.enabled = false;
    expect(sessionRelayEnabled()).toBe(false);
    const read = vi.fn(() => PIN);
    expect(dialablePin(read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('is none while the owner has paused the link', () => {
    expect(dialablePin(() => ({ ...PIN, paused: true }))).toBeNull();
  });

  it('is none without a pin', () => {
    expect(dialablePin(() => null)).toBeNull();
  });
});

describe('switching the experiment off', () => {
  it('closes the live relay at once, and ignores other settings and switching on', () => {
    const close = vi.spyOn(RelayDialer.prototype, 'close');
    sessionRelayDialer();
    let listener: ((change: { paths: readonly string[] }) => void) | undefined;
    watchSessionRelaySwitch(((fn: typeof listener) => {
      listener = fn;
      return () => undefined;
    }) as never);

    listener!({ paths: ['sessionRelay'] });
    expect(close).not.toHaveBeenCalled();

    state.enabled = false;
    listener!({ paths: ['ui.theme'] });
    expect(close).not.toHaveBeenCalled();
    listener!({ paths: ['sessionRelay.enabled'] });
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });
});

describe('switching the experiment off pauses the link', () => {
  it('so switching it back on dials nothing until the owner resumes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-switch-'));
    try {
      await writeRelayPin(PIN, home);
      let listener: ((change: { paths: readonly string[] }) => void) | undefined;
      watchSessionRelaySwitch(
        ((fn: typeof listener) => {
          listener = fn;
          return () => undefined;
        }) as never,
        home
      );
      state.enabled = false;
      listener!({ paths: ['sessionRelay'] });
      // The pause runs in the pin queue; wait for the queue to drain.
      await withRelayPinLock(() => undefined);
      expect(readRelayPin(home)?.paused).toBe(true);

      state.enabled = true;
      expect(dialablePin(() => readRelayPin(home))).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does nothing without a pin', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-switch-'));
    try {
      let listener: ((change: { paths: readonly string[] }) => void) | undefined;
      watchSessionRelaySwitch(
        ((fn: typeof listener) => {
          listener = fn;
          return () => undefined;
        }) as never,
        home
      );
      state.enabled = false;
      listener!({ paths: ['sessionRelay.enabled'] });
      await withRelayPinLock(() => undefined);
      expect(readRelayPin(home)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
