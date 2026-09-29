import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseInstallArgs } from '../commands/install.js';
import { parseMarketplaceInstalledArgs } from '../commands/marketplace-installed.js';
import { parseMarketplaceOutdatedArgs } from '../commands/marketplace-outdated.js';
import { parseUninstallArgs } from '../commands/uninstall.js';
import { parseUpdateArgs } from '../commands/update.js';
import { ApiError } from '../lib/api-client.js';
import { isOlderServer, shellWord } from '../lib/package-commands.js';

describe('--project on every package command', () => {
  // The server resolves a path against ITS working directory, which for the
  // desktop app or a DorkOS started elsewhere is not the terminal's. So the CLI
  // must send the path it means: absolute, resolved against the caller's cwd.
  const parsers: Array<[string, (args: string[]) => { projectPath?: string }]> = [
    ['install', (a) => parseInstallArgs(['flow', ...a])],
    ['update', (a) => parseUpdateArgs(a)],
    ['uninstall', (a) => parseUninstallArgs(['flow', ...a])],
    ['installed', (a) => parseMarketplaceInstalledArgs(a)],
    ['outdated', (a) => parseMarketplaceOutdatedArgs(a)],
  ];

  it.each(parsers)('%s sends a relative --project as an absolute path', (_verb, parse) => {
    expect(parse(['--project', '.']).projectPath).toBe(process.cwd());
    expect(parse(['--project', 'apps/web']).projectPath).toBe(
      path.join(process.cwd(), 'apps', 'web')
    );
  });

  it.each(parsers)('%s leaves an absolute --project as it is', (_verb, parse) => {
    expect(parse(['--project', '/work/alpha']).projectPath).toBe('/work/alpha');
  });

  it.each(parsers)('%s sends no projectPath without --project', (_verb, parse) => {
    expect(parse([]).projectPath).toBeUndefined();
  });
});

describe('shellWord', () => {
  it('leaves a plain path bare', () => {
    expect(shellWord('/work/alpha-2/app_v1.2')).toBe('/work/alpha-2/app_v1.2');
  });

  it.each([
    ['a space', '/work/my app'],
    ['a dollar', '/work/$HOME'],
    ['a semicolon', '/work/a;rm -rf x'],
    ['an ampersand', '/work/a&b'],
    ['a pipe', '/work/a|b'],
    ['a backtick', '/work/`id`'],
    ['a backslash', '/work/a\\b'],
    ['a glob', '/work/*'],
    ['a double quote', '/work/"x"'],
    ['a newline', '/work/a\nb'],
  ])('single-quotes a path with %s, so a shell reads it back verbatim', (_what, value) => {
    const quoted = shellWord(value);
    expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
    expect(quoted.slice(1, -1)).toBe(value);
  });

  it("escapes a single quote as '\\''", () => {
    expect(shellWord("/work/it's")).toBe(`'/work/it'\\''s'`);
  });
});

describe('isOlderServer', () => {
  it("recognises the app's unknown-route 404 by its code", () => {
    expect(isOlderServer(new ApiError(404, { error: 'Not found', code: 'API_NOT_FOUND' }))).toBe(
      true
    );
  });

  it('treats a bare 404 with no code as an unknown route too', () => {
    expect(isOlderServer(new ApiError(404, { error: 'Not found' }))).toBe(true);
  });

  it('does not mistake a route that answered 404 for its own reason', () => {
    // Purpose: "package not installed" is a real answer, not an old server.
    expect(
      isOlderServer(new ApiError(404, { error: 'Package not installed: x', code: 'NOT_INSTALLED' }))
    ).toBe(false);
  });

  it('ignores other statuses and non-API errors', () => {
    expect(isOlderServer(new ApiError(500, { code: 'API_NOT_FOUND' }))).toBe(false);
    expect(isOlderServer(new Error('Not found'))).toBe(false);
  });
});
