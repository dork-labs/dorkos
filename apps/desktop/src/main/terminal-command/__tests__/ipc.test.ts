import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings' Terminal command (DOR-3105): only the app's own window may read,
 * install or remove `~/.local/bin/dorkos`. A page that is not ours is refused
 * before anything is read, written or run.
 */

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

const work = vi.hoisted(() => ({
  read: vi.fn(async () => ({ state: 'not-installed' as const })),
  install: vi.fn(async () => ({ ok: true as const, status: { state: 'not-installed' as const } })),
  remove: vi.fn(async () => ({ ok: true as const, status: { state: 'not-installed' as const } })),
}));
vi.mock('../state', () => ({
  readTerminalCommand: work.read,
  installTerminalCommand: work.install,
  removeTerminalCommand: work.remove,
}));

const OWN_ORIGIN = 'http://localhost:4242';
type Result = import('../state').TerminalCommandResult;

async function arm(channel: string): Promise<(url: string) => Promise<Result>> {
  const { ipcMain } =
    (await import('electron')) as unknown as typeof import('../../__tests__/electron-mock');
  const { setupTerminalCommand } = await import('..');
  setupTerminalCommand({ getRendererUrl: () => OWN_ORIGIN });
  const call = ipcMain.handle.mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`nothing registered on ${channel}`);
  const handler = call[1] as (event: Electron.IpcMainInvokeEvent) => Promise<Result>;
  return (url) =>
    handler({ sender: { getURL: () => url } } as unknown as Electron.IpcMainInvokeEvent);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const electron =
    (await import('electron')) as unknown as typeof import('../../__tests__/electron-mock');
  electron.resetElectronMock();
});

describe.each([
  ['terminal-command:status', work.read],
  ['terminal-command:install', work.install],
  ['terminal-command:remove', work.remove],
])('%s', (channel, action) => {
  it('refuses a page that is not the app’s own window, before doing anything', async () => {
    const invoke = await arm(channel);
    expect(await invoke('https://made-up.example/page')).toEqual({
      ok: false,
      message: 'DorkOS only takes this from its own window.',
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('answers the app’s own window', async () => {
    const invoke = await arm(channel);
    expect((await invoke(`${OWN_ORIGIN}/`)).ok).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('never rejects: a failure is a plain refusal', async () => {
    action.mockRejectedValueOnce(new Error('made-up failure'));
    const invoke = await arm(channel);
    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({
      ok: false,
      message: 'something went wrong. Try again.',
    });
  });
});

describe('a dev build', () => {
  it('has no Terminal command to offer', async () => {
    const { installTerminalCommand } = await vi.importActual<typeof import('../state')>('../state');
    expect(
      await installTerminalCommand({
        home: '/made-up/home',
        target: null,
        loginShell: '/bin/zsh',
        findDorkos: async () => '',
      })
    ).toEqual({ ok: false, message: 'the Terminal command comes with the Mac app.' });
  });
});
