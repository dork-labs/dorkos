import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings' Terminal command (DOR-3105): only the app's own window may read,
 * install or remove `~/.local/bin/dorkos`. A page that is not ours is refused
 * before anything is read, written or run: the handler never even asks Electron
 * where the home folder is. Only Electron is faked; the module's own code is real.
 */

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

const OWN_ORIGIN = 'http://localhost:4242';
type Result = import('../state').TerminalCommandResult;
type ElectronMock = typeof import('../../__tests__/electron-mock');

async function electron(): Promise<ElectronMock> {
  return (await import('electron')) as unknown as ElectronMock;
}

async function arm(channel: string): Promise<(url: string) => Promise<Result>> {
  const { ipcMain } = await electron();
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
  vi.restoreAllMocks();
  (await electron()).resetElectronMock();
});

describe.each(['terminal-command:status', 'terminal-command:install', 'terminal-command:remove'])(
  '%s',
  (channel) => {
    it('refuses a page that is not the app’s own window, before doing anything', async () => {
      const invoke = await arm(channel);
      const getPath = vi.spyOn((await electron()).app, 'getPath');
      expect(await invoke('https://made-up.example/page')).toEqual({
        ok: false,
        message: 'DorkOS only takes this from its own window.',
      });
      expect(getPath).not.toHaveBeenCalledWith('home');
    });

    it('never rejects: a failure is a plain refusal', async () => {
      const invoke = await arm(channel);
      vi.spyOn((await electron()).app, 'getPath').mockImplementation(() => {
        throw new Error('made-up failure');
      });
      expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({
        ok: false,
        message: 'something went wrong. Try again.',
      });
    });
  }
);

// The test app is not packaged, which is a dev build: nothing to install.
describe('a dev build, asked by the app’s own window', () => {
  it('reports no Terminal command, so the row stays hidden', async () => {
    const invoke = await arm('terminal-command:status');
    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({ ok: true, status: { state: 'unavailable' } });
  });

  it('installs nothing, and says why', async () => {
    const invoke = await arm('terminal-command:install');
    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({
      ok: false,
      message: 'the Terminal command comes with the Mac app.',
    });
  });
});
