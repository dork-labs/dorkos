/**
 * The Mac app's "Confirm it's you" window handlers (DOR-3234): only the app's
 * own main frame may ask, one window at a time, and each window's preload
 * reaches only its own confirmation, from its main frame.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const windows: Array<{ webContents: { id: number }; close: () => void }> = [];
  return { handlers, windows };
});

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('electron', () => {
  let nextId = 100;
  class BrowserWindow {
    webContents: {
      id: number;
      on: () => void;
      setWindowOpenHandler: () => void;
    };
    private closedListeners: Array<() => void> = [];
    constructor() {
      this.webContents = {
        id: nextId++,
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
      };
      electron.windows.push(this);
    }
    once(name: string, listener: () => void) {
      if (name === 'closed') this.closedListeners.push(listener);
    }
    loadFile() {
      return Promise.resolve();
    }
    show() {}
    close() {
      for (const listener of this.closedListeners) listener();
    }
    static fromWebContents() {
      return null;
    }
  }
  return {
    BrowserWindow,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
        electron.handlers.set(channel, handler),
    },
  };
});

import {
  STEP_UP_CONFIRM_CHANNEL,
  STEP_UP_WINDOW_SUBMIT_CHANNEL,
  STEP_UP_WINDOW_VIEW_CHANNEL,
} from '../../../shared/step-up-page';
import { registerStepUpWindow } from '../index';

const ID = '01M66Q5GH0CX6W6HZPRTHM27CB';

/** An IPC event from `sender`, sent by its main frame unless `subframe`. */
function eventFrom(sender: { id: number }, options: { subframe?: boolean } = {}) {
  const mainFrame = { url: 'http://localhost:4242/' };
  return {
    sender: { ...sender, mainFrame },
    senderFrame: options.subframe ? { url: 'http://localhost:4242/' } : mainFrame,
  };
}

let fetch: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
let ownSender: boolean;

beforeEach(() => {
  // A window a test left open would block the next one: close it first.
  for (const window of electron.windows.splice(0)) window.close();
  electron.handlers.clear();
  ownSender = true;
  fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ reason: 'r', notes: [] }), { status: 200 })
  );
  registerStepUpWindow({
    isOwnSender: () => ownSender,
    port: () => 4242,
    fetch,
    personProof: () => null,
  });
});

const handler = (channel: string) => electron.handlers.get(channel)!;

describe('the step-up window handlers', () => {
  it('reads the app window’s page stamp from its own page and sends it (DOR-5026)', async () => {
    const executeJavaScript = vi.fn(async () => 'v1.made-up.stamp');
    void handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1, executeJavaScript } as never), ID);
    const own = electron.windows[0]!.webContents;
    await handler(STEP_UP_WINDOW_VIEW_CHANNEL)(eventFrom(own));
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('meta[name="dorkos-page-stamp"]')
    );
    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-dorkos-page-stamp']).toBe('v1.made-up.stamp');
  });

  it('sends no stamp when the app window has none', async () => {
    const executeJavaScript = vi.fn(async () => null);
    void handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1, executeJavaScript } as never), ID);
    await handler(STEP_UP_WINDOW_VIEW_CHANNEL)(eventFrom(electron.windows[0]!.webContents));
    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-dorkos-page-stamp']).toBeUndefined();
  });

  it('refuses a sender that is not the app’s own main frame, and opens nothing', async () => {
    ownSender = false;
    await expect(handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), ID)).resolves.toEqual({
      kind: 'not-confirmed',
    });
    expect(electron.windows).toHaveLength(0);
  });

  it('refuses an id that is not a held action’s', async () => {
    await expect(
      handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), '../config')
    ).resolves.toEqual({ kind: 'not-confirmed' });
    expect(electron.windows).toHaveLength(0);
  });

  it('opens one password window at a time', async () => {
    void handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), ID);
    await expect(handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), ID)).resolves.toEqual({
      kind: 'not-confirmed',
    });
    expect(electron.windows).toHaveLength(1);
  });

  it('answers a window’s preload only from that window’s main frame', async () => {
    void handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), ID);
    const own = electron.windows[0]!.webContents;
    await expect(handler(STEP_UP_WINDOW_VIEW_CHANNEL)(eventFrom(own))).resolves.toMatchObject({
      reason: 'r',
    });
    // A subframe of that window, and another page entirely, reach nothing.
    await expect(
      handler(STEP_UP_WINDOW_VIEW_CHANNEL)(eventFrom(own, { subframe: true }))
    ).resolves.toEqual({ ended: 'Nothing to confirm.', askAgain: false });
    await expect(
      handler(STEP_UP_WINDOW_SUBMIT_CHANNEL)(eventFrom({ id: 1 }), {
        kind: 'password',
        password: 'pw',
      })
    ).resolves.toEqual({ kind: 'ended', message: 'Nothing to confirm.' });
    expect(fetch.mock.calls.some(([, init]) => (init as RequestInit).method === 'POST')).toBe(
      false
    );
  });

  it('a window that closed takes no more submits', async () => {
    void handler(STEP_UP_CONFIRM_CHANNEL)(eventFrom({ id: 1 }), ID);
    const window = electron.windows[0]!;
    window.close();
    await expect(
      handler(STEP_UP_WINDOW_SUBMIT_CHANNEL)(eventFrom(window.webContents), {
        kind: 'password',
        password: 'pw',
      })
    ).resolves.toEqual({ kind: 'ended', message: 'Nothing to confirm.' });
  });
});
