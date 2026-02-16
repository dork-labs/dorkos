import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock @inquirer/prompts before importing init-wizard
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

import { input, select, confirm } from '@inquirer/prompts';
import { runInitWizard } from '../init-wizard.js';
import type { ConfigStore } from '../config-commands.js';
import type { UserConfig } from '@dorkos/shared/config-schema';

const MOCK_CONFIG: UserConfig = {
  version: 1,
  server: { port: 4242, cwd: null },
  tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
  ui: { theme: 'system' },
};

/**
 * Create a mock ConfigStore for testing.
 *
 * @returns Mock store with spy functions
 */
function createMockStore(): ConfigStore {
  return {
    getAll: vi.fn(() => ({ ...MOCK_CONFIG })),
    getDot: vi.fn(),
    setDot: vi.fn(() => ({})),
    reset: vi.fn(),
    validate: vi.fn(() => ({ valid: true })),
    path: '/tmp/.dork/config.json',
  };
}

/**
 * Create a temporary directory for testing.
 *
 * @returns Path to temporary directory
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-init-test-'));
}

describe('runInitWizard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('--yes flag (skip prompts)', () => {
    it('resets config to defaults without prompting', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      await runInitWizard({ yes: true, dorkHome: tmpDir, store });

      expect(store.reset).toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Config initialized with defaults'));

      logSpy.mockRestore();
    });

    it('prints correct config path', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      await runInitWizard({ yes: true, dorkHome: tmpDir, store });

      const expectedPath = path.join(tmpDir, 'config.json');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(expectedPath));

      logSpy.mockRestore();
    });
  });

  describe('interactive mode', () => {
    it('prompts for overwrite when config already exists and user declines', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();
      // Create existing config file
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

      vi.mocked(confirm).mockResolvedValueOnce(false);

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(confirm).toHaveBeenCalledWith({
        message: 'Config already exists. Overwrite with new settings?',
        default: false,
      });
      expect(store.reset).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Aborted.');

      logSpy.mockRestore();
    });

    it('proceeds with wizard when config exists and user confirms overwrite', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

      vi.mocked(confirm)
        .mockResolvedValueOnce(true)  // overwrite confirmation
        .mockResolvedValueOnce(false); // tunnel enabled

      vi.mocked(input)
        .mockResolvedValueOnce('4242') // port
        .mockResolvedValueOnce('');     // cwd

      vi.mocked(select).mockResolvedValueOnce('system'); // theme

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(confirm).toHaveBeenCalledTimes(2);
      expect(store.reset).toHaveBeenCalled();

      logSpy.mockRestore();
    });

    it('runs full wizard and applies all settings', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('8080')   // port
        .mockResolvedValueOnce('');       // cwd (empty)

      vi.mocked(select).mockResolvedValueOnce('dark'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(false); // tunnel enabled

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(store.reset).toHaveBeenCalled();
      expect(store.setDot).toHaveBeenCalledWith('server.port', 8080);
      expect(store.setDot).toHaveBeenCalledWith('ui.theme', 'dark');
      expect(store.setDot).toHaveBeenCalledWith('tunnel.enabled', false);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Config saved'));

      logSpy.mockRestore();
    });

    it('sets cwd when non-empty value provided', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('4242')             // port
        .mockResolvedValueOnce('/home/user/proj'); // cwd

      vi.mocked(select).mockResolvedValueOnce('system'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(false);   // tunnel

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(store.setDot).toHaveBeenCalledWith('server.cwd', path.resolve('/home/user/proj'));

      logSpy.mockRestore();
    });

    it('does not set cwd when empty string provided', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('4242') // port
        .mockResolvedValueOnce('');     // cwd (empty)

      vi.mocked(select).mockResolvedValueOnce('light'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(true);   // tunnel

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      // Verify server.cwd was NOT called (only port, theme, tunnel)
      const cwdCalls = vi.mocked(store.setDot).mock.calls.filter(
        ([key]) => key === 'server.cwd'
      );
      expect(cwdCalls).toHaveLength(0);

      logSpy.mockRestore();
    });

    it('does not set cwd when whitespace-only string provided', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('4242') // port
        .mockResolvedValueOnce('   ');  // cwd (whitespace only)

      vi.mocked(select).mockResolvedValueOnce('dark'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(false); // tunnel

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      // Verify server.cwd was NOT called
      const cwdCalls = vi.mocked(store.setDot).mock.calls.filter(
        ([key]) => key === 'server.cwd'
      );
      expect(cwdCalls).toHaveLength(0);

      logSpy.mockRestore();
    });

    it('resolves relative cwd paths to absolute', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('4242')    // port
        .mockResolvedValueOnce('../test'); // relative cwd

      vi.mocked(select).mockResolvedValueOnce('system'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(false);   // tunnel

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      // Verify path was resolved (not just passed through)
      const cwdCalls = vi.mocked(store.setDot).mock.calls.filter(
        ([key]) => key === 'server.cwd'
      );
      expect(cwdCalls).toHaveLength(1);
      const resolvedPath = cwdCalls[0][1] as string;
      expect(path.isAbsolute(resolvedPath)).toBe(true);

      logSpy.mockRestore();
    });

    it('enables tunnel when user confirms', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('4242') // port
        .mockResolvedValueOnce('');     // cwd

      vi.mocked(select).mockResolvedValueOnce('light'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(true);   // tunnel enabled

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(store.setDot).toHaveBeenCalledWith('tunnel.enabled', true);

      logSpy.mockRestore();
    });

    it('converts port string to number', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      vi.mocked(input)
        .mockResolvedValueOnce('3000') // port as string
        .mockResolvedValueOnce('');     // cwd

      vi.mocked(select).mockResolvedValueOnce('system'); // theme
      vi.mocked(confirm).mockResolvedValueOnce(false);   // tunnel

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      // Verify port is converted to number
      expect(store.setDot).toHaveBeenCalledWith('server.port', 3000);

      logSpy.mockRestore();
    });
  });

  describe('prompt order', () => {
    it('prompts in correct order: port, theme, tunnel, cwd', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const store = createMockStore();

      const callOrder: string[] = [];

      vi.mocked(input).mockImplementation(async (options: any) => {
        callOrder.push(`input:${options.message}`);
        return options.default || '';
      });

      vi.mocked(select).mockImplementation(async (options: any) => {
        callOrder.push(`select:${options.message}`);
        return 'system';
      });

      vi.mocked(confirm).mockImplementation(async (options: any) => {
        callOrder.push(`confirm:${options.message}`);
        return false;
      });

      await runInitWizard({ yes: false, dorkHome: tmpDir, store });

      expect(callOrder).toEqual([
        'input:Default port:',
        'select:UI theme:',
        'confirm:Enable tunnel by default?',
        'input:Default working directory (leave empty for current directory):',
      ]);

      logSpy.mockRestore();
    });
  });
});
