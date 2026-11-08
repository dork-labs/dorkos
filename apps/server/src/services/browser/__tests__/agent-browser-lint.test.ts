import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Never the real Claude accounts: a test reads only the made-up files below.
vi.mock('../../runtimes/claude-code/claude-config-dir.js', () => ({
  resolveClaudeRootSet: () => {
    throw new Error('a test must not read the real Claude accounts');
  },
}));
vi.mock('../../runtimes/claude-code/accounts/account-login-metadata.js', () => ({
  claudeUserConfigFile: () => {
    throw new Error('a test must not read the real Claude accounts');
  },
}));

import {
  browserServerRisks,
  createScanBrowserWarner,
  findRiskyAgentBrowsers,
  warnRiskyAgentBrowsers,
} from '../agent-browser-lint.js';

const playwright = (...args: string[]) => ({
  command: 'npx',
  args: ['-y', '@playwright/mcp@0.0.83', ...args],
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-browser-lint-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('browserServerRisks', () => {
  it('flags a browser on a real Chrome', () => {
    expect(browserServerRisks(playwright('--extension'))).toEqual([
      'it attaches to a real Chrome and its sign-ins (--extension)',
      'it can open any site, DorkOS included (no origin limit)',
    ]);
  });

  it.each([
    '--user-data-dir=/made/up/profile',
    '--cdp-endpoint=http://127.0.0.1:9222',
    '--no-isolated',
  ])('flags a real profile (%s)', (flag) => {
    expect(browserServerRisks(playwright('--allowed-origins=https://a.test', flag))).toEqual([
      `it uses a real browser profile (${flag.split('=')[0]})`,
    ]);
  });

  it('flags the bare default: a profile on disk and no origin limit', () => {
    expect(browserServerRisks(playwright())).toEqual([
      'it keeps a browser profile on disk (no --isolated)',
      'it can open any site, DorkOS included (no origin limit)',
    ]);
  });

  it('passes an isolated browser with an origin limit, by flag or variable', () => {
    expect(
      browserServerRisks(playwright('--isolated', '--allowed-origins', 'https://a.test'))
    ).toEqual([]);
    expect(
      browserServerRisks({
        ...playwright('--isolated'),
        env: { PLAYWRIGHT_MCP_BLOCKED_ORIGINS: 'http://localhost:*' },
      })
    ).toEqual([]);
  });

  it('ignores servers that are not a local Playwright browser', () => {
    expect(browserServerRisks({ command: 'npx', args: ['shadcn@latest', 'mcp'] })).toEqual([]);
    expect(browserServerRisks({ type: 'http', url: 'https://mcp.example' })).toEqual([]);
    expect(browserServerRisks('not an entry')).toEqual([]);
  });
});

describe('findRiskyAgentBrowsers', () => {
  it('reads each agent folder’s .mcp.json, and each account’s every-project and per-folder servers', () => {
    const agent = path.join(root, 'agents', 'atlas');
    const other = path.join(root, 'agents', 'other');
    writeJson(path.join(agent, '.mcp.json'), {
      mcpServers: {
        browser: playwright('--extension'),
        shadcn: { command: 'npx', args: ['shadcn'] },
      },
    });
    const account = writeJson(path.join(root, 'claude', '.claude.json'), {
      mcpServers: { playwright: playwright() },
      projects: {
        [agent]: { mcpServers: { local: playwright('--isolated') } },
        [other]: { mcpServers: { unrelated: playwright() } },
      },
    });
    const found = findRiskyAgentBrowsers({ agentPaths: [agent], claudeConfigFiles: [account] });
    expect(found.map(({ source, server }) => ({ source, server }))).toEqual([
      { source: path.join(agent, '.mcp.json'), server: 'browser' },
      { source: `${account} (every project)`, server: 'playwright' },
      { source: `${account} (project ${agent})`, server: 'local' },
    ]);
  });

  it('skips a missing, garbled or linked file instead of failing', () => {
    const agent = path.join(root, 'agent');
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(agent, '.mcp.json'), '{ not json');
    const real = writeJson(path.join(root, 'real.json'), { mcpServers: { p: playwright() } });
    const link = path.join(root, 'link.json');
    fs.symlinkSync(real, link);
    expect(
      findRiskyAgentBrowsers({
        agentPaths: [agent, path.join(root, 'none')],
        claudeConfigFiles: [link],
      })
    ).toEqual([]);
  });
});

describe('warnings', () => {
  it('names the file, the server and the problems, never the command line or a variable', () => {
    const agent = path.join(root, 'agent');
    writeJson(path.join(agent, '.mcp.json'), {
      mcpServers: {
        browser: {
          ...playwright('--user-data-dir=/made/up/secret-profile'),
          env: { TOKEN: 'made-up-secret' },
        },
      },
    });
    const warn = vi.fn();
    warnRiskyAgentBrowsers({ agentPaths: [agent], claudeConfigFiles: [] }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('"browser"');
    expect(line).toContain(path.join(agent, '.mcp.json'));
    expect(line).toContain('--user-data-dir');
    expect(line).not.toContain('secret-profile');
    expect(line).not.toContain('made-up-secret');
    expect(line).not.toContain('npx');
  });

  it('warns per scanned folder without repeating the every-project servers', () => {
    const agent = path.join(root, 'agent');
    writeJson(path.join(agent, '.mcp.json'), {
      mcpServers: { browser: playwright('--extension') },
    });
    const account = writeJson(path.join(root, '.claude.json'), {
      mcpServers: { playwright: playwright() },
    });
    const warn = vi.fn();
    const files = vi.fn(() => [account]);
    const scan = createScanBrowserWarner({ warn }, files);
    scan(agent);
    scan(path.join(root, 'empty'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"browser"');
    expect(files).toHaveBeenCalledTimes(1);
  });

  it('never throws from a scan, even when the account list cannot be read', () => {
    const warn = vi.fn();
    const scan = createScanBrowserWarner({ warn }, () => {
      throw new Error('no accounts');
    });
    expect(() => scan(root)).not.toThrow();
  });
});
