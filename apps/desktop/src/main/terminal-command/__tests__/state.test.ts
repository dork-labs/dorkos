/** The Terminal command's five states, in a throwaway home folder. Nothing here runs a shell. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalCommandScript } from '../script';
import {
  installTerminalCommand,
  placeNew,
  readTerminalCommand,
  removeTerminalCommand,
  type TerminalCommandDeps,
} from '../state';

const target = {
  helper:
    '/Applications/DorkOS.app/Contents/Frameworks/DorkOS Helper.app/Contents/MacOS/DorkOS Helper',
  command: '/Applications/DorkOS.app/Contents/Resources/app.asar.unpacked/dist/cli/dorkos.mjs',
};

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'terminal-command-'));
  file = path.join(home, '.local', 'bin', 'dorkos');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(
  found: string | null = ''
): TerminalCommandDeps & { findDorkos: ReturnType<typeof vi.fn> } {
  return {
    home,
    target,
    loginShell: '/bin/zsh',
    findDorkos: vi.fn(async () => found),
  };
}

const zshAdvice = { shellFile: '~/.zshrc', line: "alias dorkos='~/.local/bin/dorkos'" };

describe('readTerminalCommand', () => {
  it('is unavailable without the Mac app’s parts, and asks no shell', async () => {
    const none = { ...deps(), target: null };
    expect(await readTerminalCommand(none)).toEqual({ state: 'unavailable' });
    expect(none.findDorkos).not.toHaveBeenCalled();
  });

  it('state 1: not installed', async () => {
    expect(await readTerminalCommand(deps())).toEqual({ state: 'not-installed' });
  });

  it('state 2: installed, and Terminal finds this script', async () => {
    await installTerminalCommand(deps(file));
    expect(await readTerminalCommand(deps(file))).toEqual({
      state: 'installed',
      path: '~/.local/bin/dorkos',
    });
  });

  it('state 2 through the alias the row suggests', async () => {
    await installTerminalCommand(deps());
    const alias = "alias dorkos='~/.local/bin/dorkos'";
    expect(await readTerminalCommand(deps(alias))).toMatchObject({ state: 'installed' });
  });

  it('state 3: installed, but Terminal finds no dorkos', async () => {
    await installTerminalCommand(deps());
    expect(await readTerminalCommand(deps(''))).toEqual({
      state: 'not-found',
      path: '~/.local/bin/dorkos',
      ...zshAdvice,
    });
  });

  it('state 4: another dorkos first, with its version read from disk, never run', async () => {
    await installTerminalCommand(deps());
    const pkg = path.join(home, 'made-up-npm', 'lib', 'node_modules', 'dorkos');
    mkdirSync(path.join(pkg, 'dist', 'bin'), { recursive: true });
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'dorkos', version: '0.99.1' })
    );
    const other = path.join(pkg, 'dist', 'bin', 'cli.js');
    writeFileSync(other, '#!/usr/bin/env node\nthrow new Error("must not run")\n', { mode: 0o755 });
    const bin = path.join(home, 'made-up-npm', 'bin');
    mkdirSync(bin);
    symlinkSync(other, path.join(bin, 'dorkos'));
    expect(await readTerminalCommand(deps(path.join(bin, 'dorkos')))).toEqual({
      state: 'shadowed',
      path: '~/.local/bin/dorkos',
      ...zshAdvice,
      otherPath: path.join(bin, 'dorkos'),
      otherVersion: '0.99.1',
    });
  });

  it('state 4 with another alias, and no version', async () => {
    await installTerminalCommand(deps());
    expect(await readTerminalCommand(deps("alias dorkos='npx dorkos'"))).toMatchObject({
      state: 'shadowed',
      otherPath: 'npx dorkos',
      otherVersion: null,
    });
  });

  it('names the file for the person’s shell', async () => {
    await installTerminalCommand(deps());
    const bash = { ...deps(''), loginShell: '/bin/bash' };
    expect(await readTerminalCommand(bash)).toMatchObject({ shellFile: '~/.bashrc' });
  });

  it('says installed, not "add a line", when the shell couldn’t be asked', async () => {
    await installTerminalCommand(deps());
    expect(await readTerminalCommand(deps(null))).toMatchObject({ state: 'installed' });
  });

  it('reads a script for a moved copy of the app as not installed', async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      terminalCommandScript({ ...target, helper: '/Users/sam/Downloads/Helper' })
    );
    expect(await readTerminalCommand(deps())).toEqual({ state: 'not-installed' });
  });
});

describe('installTerminalCommand', () => {
  it('writes the script, runnable, without an admin password', async () => {
    const result = await installTerminalCommand(deps(file));
    expect(result).toEqual({
      ok: true,
      status: { state: 'installed', path: '~/.local/bin/dorkos' },
    });
    expect(readFileSync(file, 'utf8')).toBe(terminalCommandScript(target));
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it('rewrites a script for a moved copy of the app', async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, terminalCommandScript({ ...target, helper: '/old/Helper' }));
    expect((await installTerminalCommand(deps(file))).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(terminalCommandScript(target));
  });

  // A person's own file at that path is theirs: Install never replaces it.
  it.each([
    ['a script of their own', () => writeFileSync(file, '#!/bin/sh\necho mine\n')],
    ['a link to another program', () => symlinkSync('/usr/bin/true', file)],
    ['a folder', () => mkdirSync(file)],
  ])('refuses to replace %s', async (_label, plant) => {
    mkdirSync(path.dirname(file), { recursive: true });
    plant();
    expect(await installTerminalCommand(deps())).toEqual({
      ok: false,
      message: 'another file is already at ~/.local/bin/dorkos.',
    });
  });

  it('says why in plain words when the folder can’t be written', async () => {
    mkdirSync(path.join(home, '.local'), { mode: 0o500 });
    const result = await installTerminalCommand(deps());
    rmSync(path.join(home, '.local'), { recursive: true, force: true });
    expect(result).toEqual({ ok: false, message: 'DorkOS can’t write to ~/.local/bin.' });
  });

  it('refuses without the Mac app’s parts', async () => {
    expect(await installTerminalCommand({ ...deps(), target: null })).toEqual({
      ok: false,
      message: 'the Terminal command comes with the Mac app.',
    });
  });
});

describe('removeTerminalCommand', () => {
  it('deletes the script DorkOS wrote', async () => {
    await installTerminalCommand(deps());
    expect(await removeTerminalCommand(deps())).toEqual({
      ok: true,
      status: { state: 'not-installed' },
    });
    expect(() => statSync(file)).toThrow();
  });

  it('never deletes a person’s own file', async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\necho mine\n');
    expect(await removeTerminalCommand(deps())).toEqual({
      ok: false,
      message: 'the file at ~/.local/bin/dorkos isn’t the one DorkOS added.',
    });
    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('is fine when nothing is there', async () => {
    expect((await removeTerminalCommand(deps())).ok).toBe(true);
  });
});

// Security (#3679): a file that appears between Install's check and its write must never be
// replaced. A fresh install goes through placeNew, which fails rather than replace anything.
describe('placeNew', () => {
  function temp(text: string): string {
    mkdirSync(path.dirname(file), { recursive: true });
    const made = path.join(path.dirname(file), 'made-up.tmp');
    writeFileSync(made, text, { mode: 0o755 });
    return made;
  }

  it('puts a new script in place', async () => {
    await placeNew(temp('new'), file);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it.each([
    ['a file of the person’s own', () => writeFileSync(file, '#!/bin/sh\necho mine\n')],
    ['a link to another program', () => symlinkSync('/usr/bin/true', file)],
  ])('refuses, and leaves alone, %s that appeared after the check', async (_label, plant) => {
    const made = temp('ours');
    plant();
    await expect(placeNew(made, file)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(file, 'utf8')).not.toBe('ours');
  });
});
