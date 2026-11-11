/** The same protected paths reach each native file approval seam. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED_PATHS } from '../protected-paths.js';
import {
  isProtectedPath,
  searchTouchesProtectedPath,
  type ProtectedPathRoots,
} from '../protected-path-check.js';
import { protectedFileVerdict } from '../../../opencode/messaging/protected-files.js';
import { DoeApprovals } from '../../../doe/approvals.js';

type FileApproval = ReturnType<DoeApprovals['callback']>;

let root: string;
let roots: ProtectedPathRoots;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'protected-file-conformance-'));
  roots = {
    cwd: path.join(root, 'desk'),
    data: path.join(root, 'data'),
    home: path.join(root, 'home'),
    accounts: [path.join(root, 'account')],
    agentFolders: [path.join(root, 'desk')],
    agentHomes: [path.join(root, 'agent')],
  };
  for (const folder of [roots.cwd, roots.data, roots.home, ...roots.accounts, ...roots.agentHomes])
    mkdirSync(folder, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const adapters = ['shared', 'opencode', 'doe'] as const;
async function refused(
  adapter: (typeof adapters)[number],
  file: string,
  operation: 'read' | 'write'
) {
  if (adapter === 'shared') return isProtectedPath(file, operation, roots);
  if (adapter === 'opencode')
    return (
      protectedFileVerdict(
        {
          toolName: operation === 'write' ? 'edit' : 'read',
          input: JSON.stringify({ filepath: file }),
        },
        roots
      ) === 'deny'
    );
  const signal = new AbortController().signal;
  const tool: Parameters<FileApproval>[0] = {
    name: operation,
    description: 'Probe',
    schema: {},
    execute: async () => ({ content: [] }),
  };
  const context: Parameters<FileApproval>[2] = {
    sessionId: 'probe',
    scope: 'main',
    workingDirectory: roots.cwd,
    signal,
    emit: () => {},
  };
  return (
    (await new DoeApprovals().callback(
      'bypassPermissions',
      () => {},
      signal,
      false,
      new Set(),
      roots
    )(tool, { path: file }, context)) === 'deny'
  );
}

describe.each(adapters)('%s native file protection', (adapter) => {
  it.each(PROTECTED_PATHS)('refuses $deny at $root/$path', async (entry) => {
    const base =
      entry.root === 'data'
        ? roots.data
        : entry.root === 'home'
          ? roots.home
          : entry.root === 'account'
            ? roots.accounts[0]!
            : entry.root === 'agent-home'
              ? roots.agentHomes[0]!
              : roots.cwd;
    const file = path.join(
      base,
      ...(entry.root === 'anywhere' || entry.root === 'agent-folder' ? ['nested'] : []),
      entry.path.replaceAll('*', 'sample')
    );
    expect(await refused(adapter, file, entry.deny)).toBe(true);
  });

  // DOR-3613: an agent that reads the person's DorkOS sign-in, or the agent
  // browser's cookies, can act as the person (and press Resume on a paused
  // browser). Each of these is a real file those stores keep.
  it.each([
    [
      'the desktop app’s cookie store (macOS)',
      'home',
      'Library/Application Support/DorkOS/Cookies',
    ],
    ['its newer cookie store', 'home', 'Library/Application Support/DorkOS/Network/Cookies'],
    [
      'its page storage, where the person proof lives',
      'home',
      'Library/Application Support/DorkOS/Local Storage/leveldb/000003.log',
    ],
    [
      'its built-in browser’s sign-ins',
      'home',
      'Library/Application Support/DorkOS/Partitions/dorkos-local-browser/Cookies',
    ],
    ['the desktop app’s cookie store (Windows)', 'home', 'AppData/Roaming/DorkOS/Network/Cookies'],
    ['the desktop app’s cookie store (Linux)', 'home', '.config/DorkOS/Cookies'],
    [
      'a development build’s cookie store',
      'home',
      'Library/Application Support/@dorkos/desktop/Network/Cookies',
    ],
    // macOS folders are case-insensitive: the same file under other letters.
    ['the cookie store spelt in other case', 'home', 'library/application support/dorkos/Cookies'],
    ['its page storage in capitals', 'home', 'LIBRARY/APPLICATION SUPPORT/DORKOS/Local Storage/x'],
    ['the agent browser’s saved sign-in', 'data', 'browser/storage-state.json'],
    ['the agent browser’s own cookies', 'data', 'browser/profile/Default/Cookies'],
    ['a named profile’s cookies', 'data', 'browser-profiles/made-up-profile/Default/Cookies'],
    ['the local browser’s saved logins', 'data', 'local-browser/saved-logins/Default/Cookies'],
    ['the default data folder’s agent browser', 'home', '.dork/browser/profile/Default/Cookies'],
  ] as const)('refuses reading %s', async (_what, root, file) => {
    const base = root === 'home' ? roots.home : roots.data;
    expect(await refused(adapter, path.join(base, file), 'read')).toBe(true);
  });

  it('follows a link to the desktop app’s folder, and a link to its cookie file', async () => {
    const appData = path.join(roots.home, 'Library', 'Application Support', 'DorkOS');
    mkdirSync(path.join(appData, 'Network'), { recursive: true });
    writeFileSync(path.join(appData, 'Network', 'Cookies'), 'made-up');
    symlinkSync(appData, path.join(roots.cwd, 'app-data'));
    symlinkSync(path.join(appData, 'Network', 'Cookies'), path.join(roots.cwd, 'jar.db'));
    expect(
      await refused(adapter, path.join(roots.cwd, 'app-data', 'Network', 'Cookies'), 'read')
    ).toBe(true);
    expect(await refused(adapter, path.join(roots.cwd, 'jar.db'), 'read')).toBe(true);
  });

  it('follows a link to an agent browser profile', async () => {
    const profile = path.join(roots.data, 'browser-profiles', 'made-up-profile');
    mkdirSync(path.join(profile, 'Default'), { recursive: true });
    writeFileSync(path.join(profile, 'Default', 'Cookies'), 'made-up');
    symlinkSync(profile, path.join(roots.cwd, 'profile-link'));
    expect(
      await refused(adapter, path.join(roots.cwd, 'profile-link', 'Default', 'Cookies'), 'read')
    ).toBe(true);
  });

  // DOR-4136: an agent that writes a browser sign-in store can start every later
  // agent browser signed in to an account it chose, or wipe the person's own.
  it.each([
    ['the saved session every agent browser starts from', 'data', 'browser/storage-state.json'],
    ['the saved session’s temp file', 'data', 'browser/.storage-state.json.123.made-up.tmp'],
    ['the login profile’s cookies', 'data', 'browser/profile/Default/Cookies'],
    ['a named profile’s cookies', 'data', 'browser-profiles/made-up-profile/Default/Cookies'],
    ['the local browser’s saved logins', 'data', 'local-browser/saved-logins/Default/Cookies'],
    [
      'the desktop app’s cookie store',
      'home',
      'Library/Application Support/DorkOS/Network/Cookies',
    ],
    ['its page storage', 'home', 'Library/Application Support/DorkOS/Local Storage/leveldb/1.log'],
    ['its built-in browser', 'home', 'Library/Application Support/DorkOS/Partitions/x/Cookies'],
    ['a development build’s cookie store', 'home', '.config/@dorkos/desktop/Cookies'],
    ['the cookie store in other case', 'home', 'library/application support/dorkos/cookies'],
    ['the default data folder’s saved session', 'home', '.dork/browser/storage-state.json'],
    // The config every agent browser starts with, which keeps it off DorkOS Cloud.
    ['the agent browser’s guard config', 'data', 'browser/agent-browser-guard.json'],
    ['its temp file', 'data', 'browser/agent-browser-guard.json.123.456.tmp'],
    ['the default data folder’s guard config', 'home', '.dork/browser/agent-browser-guard.json'],
  ] as const)('refuses writing %s', async (_what, root, file) => {
    const base = root === 'home' ? roots.home : roots.data;
    expect(await refused(adapter, path.join(base, file), 'write')).toBe(true);
  });

  it('refuses a write through a link to the saved session or a profile', async () => {
    const browser = path.join(roots.data, 'browser');
    mkdirSync(path.join(browser, 'profile', 'Default'), { recursive: true });
    writeFileSync(path.join(browser, 'storage-state.json'), '{}');
    symlinkSync(path.join(browser, 'storage-state.json'), path.join(roots.cwd, 'state.json'));
    symlinkSync(path.join(browser, 'profile'), path.join(roots.cwd, 'profile'));
    expect(await refused(adapter, path.join(roots.cwd, 'state.json'), 'write')).toBe(true);
    expect(
      await refused(adapter, path.join(roots.cwd, 'profile', 'Default', 'Cookies'), 'write')
    ).toBe(true);
  });

  it('still lets an agent write its own files beside the browser folders', async () => {
    expect(await refused(adapter, path.join(roots.cwd, 'storage-state.json'), 'write')).toBe(false);
    expect(await refused(adapter, path.join(roots.data, 'browser-notes.txt'), 'write')).toBe(false);
  });

  it('still reads ordinary files beside the desktop app’s folder', async () => {
    const other = path.join(roots.home, 'Library/Application Support/Other App/Cookies');
    expect(await refused(adapter, other, 'read')).toBe(false);
  });

  it('keeps normal files and templates accessible', async () => {
    for (const file of ['notes.txt', '.env.example', 'id_rsa.pub', 'credentials/guide.md']) {
      expect(await refused(adapter, path.join(roots.cwd, file), 'read')).toBe(false);
      expect(await refused(adapter, path.join(roots.cwd, file), 'write')).toBe(false);
    }
  });

  it('follows a harmless-looking alias into a secret', async () => {
    const secret = path.join(roots.data, 'host.key');
    writeFileSync(secret, 'made-up');
    const alias = path.join(roots.cwd, 'notes.txt');
    symlinkSync(secret, alias);
    expect(await refused(adapter, alias, 'read')).toBe(true);
  });

  it('resolves a link before a parent segment', async () => {
    mkdirSync(path.join(roots.data, 'child'));
    symlinkSync(path.join(roots.data, 'child'), path.join(roots.cwd, 'link'));
    const raw = `${roots.cwd}/link/../host.key`;
    expect(await refused(adapter, raw, 'read')).toBe(true);
  });

  it('refuses a new file through an alias of a person-only folder', async () => {
    mkdirSync(path.join(roots.data, 'permissions'));
    symlinkSync(path.join(roots.data, 'permissions'), path.join(roots.cwd, 'setup'));
    expect(await refused(adapter, path.join(roots.cwd, 'setup', 'new.json'), 'write')).toBe(true);
  });

  it('refuses a future agent home before registry refresh', async () => {
    expect(
      await refused(adapter, path.join(roots.data, 'agents', 'new', '.dork', 'agent.json'), 'write')
    ).toBe(true);
  });
});

it('refuses every file in an OpenCode multi-file edit, including rename targets', () => {
  expect(
    protectedFileVerdict(
      {
        toolName: 'edit',
        input: JSON.stringify({
          files: [
            { filePath: path.join(roots.cwd, 'notes.txt') },
            {
              filePath: path.join(roots.cwd, 'moved.txt'),
              movePath: path.join(roots.data, 'config.json'),
            },
          ],
        }),
      },
      roots
    )
  ).toBe('deny');
});

it('refuses an OpenCode file ask with no usable path', () => {
  for (const input of ['bad json', '{}', 'null', '{"patterns":["*"]}'])
    expect(protectedFileVerdict({ toolName: 'edit', input }, roots)).toBe('deny');
});

it('refuses an OpenCode edit that could read a secret into its diff', () => {
  expect(
    protectedFileVerdict(
      {
        toolName: 'edit',
        input: JSON.stringify({ filepath: path.join(roots.cwd, 'fixture.key') }),
      },
      roots
    )
  ).toBe('deny');
});

it('allows searches of clean roots and refuses only trees containing protected files', () => {
  const clean = path.join(roots.cwd, 'clean');
  mkdirSync(clean);
  writeFileSync(path.join(clean, 'notes.txt'), 'ordinary text');
  expect(searchTouchesProtectedPath(clean, roots)).toBe(false);
  for (const toolName of ['grep', 'glob']) {
    expect(
      protectedFileVerdict({ toolName, input: JSON.stringify({ dorkosSearchRoot: clean }) }, roots)
    ).toBe('allow');
    writeFileSync(path.join(clean, 'fixture.key'), 'made-up');
    expect(
      protectedFileVerdict({ toolName, input: JSON.stringify({ dorkosSearchRoot: clean }) }, roots)
    ).toBe('deny');
    rmSync(path.join(clean, 'fixture.key'));
  }
});

it('checks aliased descendants before allowing a folder search', () => {
  const clean = path.join(roots.cwd, 'clean');
  mkdirSync(clean);
  writeFileSync(path.join(roots.data, 'host.key'), 'made-up');
  symlinkSync(path.join(roots.data, 'host.key'), path.join(clean, 'notes.txt'));
  expect(searchTouchesProtectedPath(clean, roots)).toBe(true);
});

it('keeps a protected name refused when its link points to an ordinary file', () => {
  const clean = path.join(roots.cwd, 'clean');
  mkdirSync(clean);
  const ordinary = path.join(roots.cwd, 'ordinary.txt');
  writeFileSync(ordinary, 'ordinary text');
  symlinkSync(ordinary, path.join(clean, 'fixture.key'));
  expect(searchTouchesProtectedPath(clean, roots)).toBe(true);
});
