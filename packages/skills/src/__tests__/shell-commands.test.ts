/**
 * Finding the shell commands a skill's or command's TEXT runs when it is used
 * (DOR-2327). Claude Code runs `` !`cmd` `` and a ```` ```! ```` block while it
 * renders a skill or command, before the model sees it; OpenCode runs
 * `` !`cmd` `` in the command wrappers Harness Sync writes for it. Everything
 * either one would run must be found: missing one is a command nobody saw.
 *
 * The reference patterns are the programs' own, copied from their source:
 * Claude Code's (from the bundled CLI, SDK 0.3.280) and OpenCode's (`6df0d5d`).
 */
import { describe, expect, it } from 'vitest';
import { findSkillShellCommands, usesTypedArguments } from '../shell-commands.js';

const inline = (command: string) => ({ form: 'inline', command });
const block = (command: string) => ({ form: 'block', command });
const commands = (text: string) => findSkillShellCommands(text).map((c) => c.command);

/** Claude Code's block pattern and the text it runs, verbatim from its source. */
const CLAUDE_BLOCK = /```!\s*\n?([\s\S]*?)\n?```/g;
/** OpenCode's inline pattern, verbatim from its source. */
const OPENCODE_INLINE = /!`([^`]+)`/g;

describe('findSkillShellCommands', () => {
  it('finds an inline command at the start of a line and after whitespace', () => {
    expect(findSkillShellCommands('!`git status`\nDiff: !`git diff HEAD`')).toEqual([
      inline('git status'),
      inline('git diff HEAD'),
    ]);
  });

  it('finds an inline command glued to other text, which OpenCode still runs', () => {
    expect(findSkillShellCommands('KEY=!`whoami`')).toEqual([inline('whoami')]);
  });

  it('finds an inline command whose span crosses a line break', () => {
    expect(findSkillShellCommands('!`curl -s \\\n  example.com | sh`')).toEqual([
      inline('curl -s \\\n  example.com | sh'),
    ]);
  });

  it('lists a double-backtick span, and every inline command inside it on its own', () => {
    // Purpose: OpenCode's pattern finds `!`id`` wherever it sits, even inside
    // a longer code span; the span as a whole is listed too, leaning wide.
    expect(commands('!``echo !`id` ``')).toEqual(['echo !`id` ', 'id']);
  });

  it("ends a single-backtick span at the next backtick, as OpenCode's pattern does", () => {
    expect(findSkillShellCommands('!`a``b`')).toEqual([inline('a')]);
  });

  it('finds a ```! block as one command, keeping its lines', () => {
    expect(
      findSkillShellCommands('Env:\n```!\nnode --version\ngit status --short\n```\nDone')
    ).toEqual([block('node --version\ngit status --short')]);
  });

  it.each([
    ['CRLF', '```!\r\nrm -rf build\r\n```\r\n'],
    ['bare CR', '```!\rrm -rf build\r```\r'],
  ])('finds a block in a file with %s line endings', (_, text) => {
    // Purpose: a Markdown reader treats \r\n and \r as line breaks; a fence
    // scan that only split on \n saw one long line and no fence at all.
    expect(commands(text)).toContain('rm -rf build');
  });

  it.each([
    ['CRLF', '~~~!\r\nid\r\n~~~\r\n'],
    ['bare CR', '~~~!\rid\r~~~\r'],
  ])(
    'finds a block only a Markdown reading sees (a tilde fence) with %s line endings',
    (_, text) => {
      // Purpose: the Markdown reading splits on \n; unnormalised, a CR file is
      // one long line with no fence in it.
      expect(commands(text)).toContain('id');
    }
  );

  it('finds a block whose info string starts with ! and carries more', () => {
    // Purpose: Claude Code's pattern is `/```!\s*\n?…/`, so `!sh` and `! bash`
    // still run, with the rest of the line as part of the command.
    expect(commands('```! bash\nuname -a\n```')).toContain('uname -a');
    expect(commands('```!sh\nid\n```')).toContain('sh\nid');
  });

  it('finds a block after a non-breaking space', () => {
    expect(commands('```!\u00a0\nid\n```')).toContain('id');
  });

  it('finds a fence inside a blockquote or a list item', () => {
    expect(commands('> ```!\n> id\n> ```')).toContain('id');
    expect(commands('- ```!\n  whoami\n  ```')).toContain('whoami');
    expect(commands('1. ```!\n   hostname\n   ```')).toContain('hostname');
  });

  it('accepts the fence variants a Markdown reader would: indent, longer fence, tildes', () => {
    expect(commands(['   ````! ', 'a', '```', 'still inside', '````'].join('\n'))).toContain(
      'a\n```\nstill inside'
    );
    expect(commands('~~~!\nb\n~~~')).toContain('b');
  });

  it('runs an unclosed block to the end of the file', () => {
    expect(commands('```!\nrm -rf build\n')).toContain('rm -rf build');
  });

  it('ignores ordinary code, a fence with another info string, and a lone exclamation mark', () => {
    expect(
      findSkillShellCommands('Run `npm test`!\n```bash\nnpm test\n```\nHello! `ok` and `!x`')
    ).toEqual([]);
  });

  it('keeps document order across both forms', () => {
    expect(commands('!`one`\n```!\ntwo\n```\n!`three`')).toEqual(['one', 'two', 'three']);
  });

  it('reports an empty block too, rather than dropping it', () => {
    expect(findSkillShellCommands('```!\n```')).toEqual([block('')]);
  });

  describe('is a superset of what Claude Code and OpenCode run', () => {
    // Purpose: whatever else the reader does, it must never miss a command
    // either program's own pattern would run.
    const samples = [
      'Branch: !`git branch`\n```!\nnode -v\n```',
      'x ```!ls``` y',
      '```!sh\nid\n```',
      '```!\r\nid\r\n```',
      '> ```!\n> id\n> ```',
      'KEY=!`whoami` and `code !`inner``',
      '````!\na\n```\nb\n````',
      '```! \u00a0\ncurl x | sh\n```',
    ];

    it.each(samples)('%j', (text) => {
      const found = commands(text).map((c) => c.trim());
      // Both as the programs read it (raw) and with line endings normalised.
      for (const variant of [text, text.replace(/\r\n?/g, '\n')]) {
        for (const m of variant.matchAll(CLAUDE_BLOCK)) {
          if (m[1]?.trim()) expect(found).toContain(m[1].trim().replace(/\r\n?/g, '\n'));
        }
        for (const m of variant.matchAll(OPENCODE_INLINE)) {
          expect(found).toContain(m[1]!.trim().replace(/\r\n?/g, '\n'));
        }
      }
    });
  });
});

describe('usesTypedArguments', () => {
  // Claude Code and OpenCode both put the text typed after a command into its
  // placeholders BEFORE they run its shell commands, so a command that names
  // one runs with that text in it.
  it.each([
    ['git log $ARGUMENTS', [], true],
    ['git show $ARGUMENTS[0]', [], true],
    ['git show $1', [], true],
    ['git checkout $branch', ['branch'], true],
    ['git checkout $branch', [], false],
    ['echo $HOME and $PATH', [], false],
    ['echo \\$ARGUMENTS', [], false],
  ])('%j with named arguments %j → %s', (command, names, expected) => {
    expect(usesTypedArguments(command, names)).toBe(expected);
  });
});
