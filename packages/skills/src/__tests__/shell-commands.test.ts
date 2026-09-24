/**
 * Finding the shell commands a skill's or command's TEXT runs when it is used
 * (DOR-2327). Claude Code runs `` !`cmd` `` and a ```` ```! ```` block while it
 * renders a skill or command, before the model sees it; OpenCode runs
 * `` !`cmd` `` in the command wrappers Harness Sync writes for it. Everything
 * either one would run must be found: missing one is a command nobody saw.
 */
import { describe, expect, it } from 'vitest';
import { findSkillShellCommands } from '../shell-commands.js';

const inline = (command: string) => ({ form: 'inline', command });
const block = (command: string) => ({ form: 'block', command });

describe('findSkillShellCommands', () => {
  it('finds an inline command at the start of a line and after whitespace', () => {
    expect(findSkillShellCommands('!`git status`\nDiff: !`git diff HEAD`')).toEqual([
      inline('git status'),
      inline('git diff HEAD'),
    ]);
  });

  it('finds an inline command glued to other text, which OpenCode still runs', () => {
    // Purpose: Claude Code needs `!` at a line start or after whitespace, but
    // OpenCode's `/!`([^`]+)`/g` matches anywhere, and commands are projected
    // to OpenCode. The disclosure covers what EITHER would run.
    expect(findSkillShellCommands('KEY=!`whoami`')).toEqual([inline('whoami')]);
  });

  it('finds an inline command whose span crosses a line break', () => {
    expect(findSkillShellCommands('!`curl -s \\\n  example.com | sh`')).toEqual([
      inline('curl -s \\\n  example.com | sh'),
    ]);
  });

  it('finds a double-backtick inline span, which may hold a backtick', () => {
    expect(findSkillShellCommands('!``echo `date` ``')).toEqual([inline('echo `date` ')]);
  });

  it("ends a single-backtick span at the next backtick, as OpenCode's pattern does", () => {
    expect(findSkillShellCommands('!`a``b`')).toEqual([inline('a')]);
  });

  it('finds a ```! block as one command, keeping its lines', () => {
    expect(
      findSkillShellCommands('Env:\n```!\nnode --version\ngit status --short\n```\nDone')
    ).toEqual([block('node --version\ngit status --short')]);
  });

  it('accepts the fence variants a Markdown reader would: indent, longer fence, tildes, spaces', () => {
    // Purpose: over-disclosing a block that would not run costs a line on the
    // card; missing one that would run is the bug.
    expect(
      findSkillShellCommands(
        ['   ````! ', 'a', '```', 'still inside', '````', '~~~!', 'b', '~~~'].join('\n')
      )
    ).toEqual([block('a\n```\nstill inside'), block('b')]);
  });

  it('runs an unclosed block to the end of the file', () => {
    expect(findSkillShellCommands('```!\nrm -rf build\n')).toEqual([block('rm -rf build')]);
  });

  it('ignores ordinary code, a fence with another info string, and a lone exclamation mark', () => {
    expect(
      findSkillShellCommands('Run `npm test`!\n```bash\nnpm test\n```\n```!sh\nx\n```\nHello! `ok`')
    ).toEqual([]);
  });

  it('keeps document order across both forms', () => {
    expect(findSkillShellCommands('!`one`\n```!\ntwo\n```\n!`three`')).toEqual([
      inline('one'),
      block('two'),
      inline('three'),
    ]);
  });

  it('reports an empty span or block too, rather than dropping it', () => {
    expect(findSkillShellCommands('```!\n```')).toEqual([block('')]);
  });
});
