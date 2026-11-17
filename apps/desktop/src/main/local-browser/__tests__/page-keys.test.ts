import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_INPUT_GRACE_MS,
  createAgentInputGate,
  forwardGuestShortcuts,
  guestShortcut,
  type GuestShortcut,
} from '../page-keys';
import { pageTransport } from '../page-transport';

// The Agent browser's keys from inside the native page (DOR-4432, spec §13).
// Only Electron itself is faked; every host is made up.

type KeyInput = {
  type?: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  key: string;
  code: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
};

function input(init: KeyInput) {
  return {
    type: 'keyDown',
    meta: false,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...init,
  } as Electron.Input;
}

const MAC_MOD = { meta: true };
const PC_MOD = { control: true };

describe('guestShortcut', () => {
  it.each<[string, KeyInput, NodeJS.Platform, GuestShortcut]>([
    ['⌘L', { key: 'l', code: 'KeyL', ...MAC_MOD }, 'darwin', 'focus-address'],
    ['Ctrl+L', { key: 'l', code: 'KeyL', ...PC_MOD }, 'win32', 'focus-address'],
    ['⌘R', { key: 'r', code: 'KeyR', ...MAC_MOD }, 'darwin', 'reload'],
    ['Ctrl+R', { key: 'r', code: 'KeyR', ...PC_MOD }, 'linux', 'reload'],
    ['F5', { key: 'F5', code: 'F5' }, 'win32', 'reload'],
    ['⌘⇧C', { key: 'C', code: 'KeyC', shift: true, ...MAC_MOD }, 'darwin', 'copy-address'],
    ['Ctrl+Shift+C', { key: 'C', code: 'KeyC', shift: true, ...PC_MOD }, 'win32', 'copy-address'],
  ])('%s', (_name, init, platform, expected) => {
    expect(guestShortcut(input(init), platform)).toBe(expected);
  });

  // As in Chrome, the page sees these first: an editor's outdent, a terminal's
  // Ctrl+[ and a page's own Esc never navigate or stop a load (DOR-4432 review).
  it.each<[string, KeyInput, NodeJS.Platform]>([
    ['⌘[', { key: '[', code: 'BracketLeft', ...MAC_MOD }, 'darwin'],
    ['⌘]', { key: ']', code: 'BracketRight', ...MAC_MOD }, 'darwin'],
    ['Ctrl+[', { key: '[', code: 'BracketLeft', ...PC_MOD }, 'win32'],
    ['Ctrl+]', { key: ']', code: 'BracketRight', ...PC_MOD }, 'linux'],
    ['Alt+←', { key: 'ArrowLeft', code: 'ArrowLeft', alt: true }, 'win32'],
    ['Alt+→', { key: 'ArrowRight', code: 'ArrowRight', alt: true }, 'linux'],
    ['Esc', { key: 'Escape', code: 'Escape' }, 'darwin'],
  ])('leaves the page-first key %s to the page', (_name, init, platform) => {
    expect(guestShortcut(input(init), platform)).toBeNull();
  });

  it.each<[string, KeyInput, NodeJS.Platform]>([
    ['a key release', { type: 'keyUp', key: 'r', code: 'KeyR', ...MAC_MOD }, 'darwin'],
    ['plain typing', { key: 'r', code: 'KeyR' }, 'darwin'],
    ['copy', { key: 'c', code: 'KeyC', ...MAC_MOD }, 'darwin'],
    ['Ctrl+R on a Mac', { key: 'r', code: 'KeyR', control: true }, 'darwin'],
    ['⌘R off a Mac', { key: 'r', code: 'KeyR', meta: true }, 'win32'],
    ['Option+← on a Mac', { key: 'ArrowLeft', code: 'ArrowLeft', alt: true }, 'darwin'],
    ['⇧⌘R', { key: 'R', code: 'KeyR', shift: true, ...MAC_MOD }, 'darwin'],
  ])('leaves %s to the page', (_name, init, platform) => {
    expect(guestShortcut(input(init), platform)).toBeNull();
  });
});

describe('createAgentInputGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is open while an agent key is in flight and for a short grace after', async () => {
    const gate = createAgentInputGate();
    expect(gate.active()).toBe(false);
    let finish!: () => void;
    const running = gate.run(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(gate.active()).toBe(true);
    finish();
    await running;
    expect(gate.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(AGENT_INPUT_GRACE_MS + 1);
    expect(gate.active()).toBe(false);
  });

  it('stays open while any of several overlapping keys is in flight, and after a failure', async () => {
    const gate = createAgentInputGate();
    let finishFirst!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = gate.run(() => Promise.reject(new Error('Browser did not answer')));
    await expect(second).rejects.toThrow('Browser did not answer');
    await vi.advanceTimersByTimeAsync(AGENT_INPUT_GRACE_MS + 1);
    expect(gate.active()).toBe(true);
    finishFirst();
    await first;
    await vi.advanceTimersByTimeAsync(AGENT_INPUT_GRACE_MS + 1);
    expect(gate.active()).toBe(false);
  });
});

function fakeGuest() {
  return new EventEmitter();
}

function keyEvent() {
  return { preventDefault: vi.fn() };
}

describe('forwardGuestShortcuts', () => {
  it('forwards a person’s chord to the app and keeps it from the page and the app menu', () => {
    const contents = fakeGuest();
    const send = vi.fn();
    forwardGuestShortcuts(contents as never, {
      platform: 'darwin',
      gate: createAgentInputGate(),
      personFocused: () => true,
      send,
    });
    const event = keyEvent();
    contents.emit('before-input-event', event, input({ key: 'r', code: 'KeyR', ...MAC_MOD }));
    expect(send).toHaveBeenCalledWith('reload');
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('no longer forwards Back, Forward or Esc, and leaves them to the page', () => {
    const contents = fakeGuest();
    const send = vi.fn();
    forwardGuestShortcuts(contents as never, {
      platform: 'win32',
      gate: createAgentInputGate(),
      personFocused: () => true,
      send,
    });
    for (const init of [
      { key: '[', code: 'BracketLeft', ...PC_MOD },
      { key: ']', code: 'BracketRight', ...PC_MOD },
      { key: 'ArrowLeft', code: 'ArrowLeft', alt: true },
      { key: 'ArrowRight', code: 'ArrowRight', alt: true },
      { key: 'Escape', code: 'Escape' },
    ]) {
      const event = keyEvent();
      contents.emit('before-input-event', event, input(init));
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores keys while the window is not the one the person is using', () => {
    const contents = fakeGuest();
    const send = vi.fn();
    forwardGuestShortcuts(contents as never, {
      platform: 'darwin',
      gate: createAgentInputGate(),
      personFocused: () => false,
      send,
    });
    const event = keyEvent();
    contents.emit('before-input-event', event, input({ key: 'r', code: 'KeyR', ...MAC_MOD }));
    expect(send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('an agent’s key never counts as the person’s, and reaches the page untouched', async () => {
    const contents = fakeGuest();
    const send = vi.fn();
    const gate = createAgentInputGate();
    forwardGuestShortcuts(contents as never, {
      platform: 'darwin',
      gate,
      personFocused: () => true,
      send,
    });
    const event = keyEvent();
    await gate.run(async () => {
      contents.emit('before-input-event', event, input({ key: 'r', code: 'KeyR', ...MAC_MOD }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', () => {
    const contents = fakeGuest();
    const dispose = forwardGuestShortcuts(contents as never, {
      platform: 'darwin',
      gate: createAgentInputGate(),
      personFocused: () => true,
      send: vi.fn(),
    });
    dispose();
    expect(contents.eventNames()).toEqual([]);
  });
});

describe('the agent’s own ⌘R through its page transport', () => {
  it('never hands the page to the person', async () => {
    const gate = createAgentInputGate();
    const contents = Object.assign(new EventEmitter(), {
      id: 7,
      isDestroyed: () => false,
    });
    const debuggerApi = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        // The worst case: Chromium runs the shell's key hook while the agent's key is
        // dispatched, before the command answers. Unchecked on real Electron; the gate
        // is defense in depth and has to hold if it does.
        if (method === 'Input.dispatchKeyEvent' && params?.type === 'rawKeyDown') {
          contents.emit(
            'before-input-event',
            keyEvent(),
            input({ key: 'r', code: 'KeyR', ...MAC_MOD })
          );
        }
        return { targetInfo: { targetId: 'owned-page', type: 'page' } };
      }),
    });
    Object.assign(contents, { debugger: debuggerApi });
    const send = vi.fn();
    forwardGuestShortcuts(contents as never, {
      platform: 'darwin',
      gate,
      personFocused: () => true,
      send,
    });
    const transport = pageTransport(contents as unknown as WebContents, gate);
    transport.onmessage = vi.fn();
    transport.send({
      id: 1,
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: 'r', code: 'KeyR', modifiers: 4 },
      sessionId: 'dorkos-page-7',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'rawKeyDown' }),
      undefined
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('only the agent’s input commands hold the gate', async () => {
    const gate = createAgentInputGate();
    let seen: boolean | undefined;
    const contents = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false });
    const debuggerApi = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn(async () => {
        seen = gate.active();
        return {};
      }),
    });
    Object.assign(contents, { debugger: debuggerApi });
    const transport = pageTransport(contents as unknown as WebContents, gate);
    transport.onmessage = vi.fn();
    transport.send({ id: 1, method: 'Page.navigate', params: {}, sessionId: 'dorkos-page-8' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toBe(false);
    transport.send({ id: 2, method: 'Input.insertText', params: {}, sessionId: 'dorkos-page-8' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toBe(true);
  });

  it('a transport cannot be made without the gate', () => {
    // Checked by the desktop typecheck, which includes this file: if the gate ever
    // turns optional again, this expected error goes unused and the typecheck fails.
    // The function is never called, so nothing attaches here.
    const withoutGate = (contents: WebContents) =>
      // @ts-expect-error -- the input gate is required
      pageTransport(contents);
    expect(withoutGate).toBeTypeOf('function');
  });
});
