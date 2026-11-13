/**
 * The one line a person adds so their Terminal finds the Terminal command (DOR-3105).
 *
 * It is an alias for `dorkos` alone, never a `PATH` line (Security, Nov 11): putting
 * all of `~/.local/bin` ahead of the system folders would let anything dropped
 * there shadow `git`, `node` and the rest. An alias also wins over any other
 * `dorkos` the shell would find, so one line covers both "not found" and "another
 * one first". It works in the person's own Terminal, not in scripts.
 *
 * @module main/terminal-command/shell-line
 */
import path from 'node:path';

/** The line to add and the file it goes in, named for the person's shell. */
export interface ShellLine {
  /** The shell's name, as the probe should run it: `zsh`, `bash` or `fish`. */
  shell: 'zsh' | 'bash' | 'fish';
  /** The startup file, in `~` form for display. */
  file: string;
  /** The exact line to copy. */
  line: string;
}

/**
 * The line for the person's login shell. Anything but bash or fish gets zsh's,
 * macOS's default since 10.15.
 *
 * @param loginShell - `$SHELL`, for example `/bin/zsh`.
 */
export function shellLineFor(loginShell: string | undefined): ShellLine {
  const name = path.basename(loginShell ?? '');
  if (name === 'bash')
    return { shell: 'bash', file: '~/.bashrc', line: "alias dorkos='~/.local/bin/dorkos'" };
  if (name === 'fish')
    return {
      shell: 'fish',
      file: '~/.config/fish/config.fish',
      line: 'alias dorkos ~/.local/bin/dorkos',
    };
  return { shell: 'zsh', file: '~/.zshrc', line: "alias dorkos='~/.local/bin/dorkos'" };
}
