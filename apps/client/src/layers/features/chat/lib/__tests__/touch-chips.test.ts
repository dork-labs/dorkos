import { describe, it, expect, vi } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { accumulateTouchChips, type TouchChip } from '../touch-chips';

type ToolStatus = 'pending' | 'running' | 'complete' | 'error';

let nextId = 0;

/** Build a `tool_call` part the way the wire delivers one: input JSON-encoded. */
function toolCall(
  toolName: string,
  input: unknown,
  options: { result?: string; status?: ToolStatus } = {}
): MessagePart {
  nextId += 1;
  return {
    type: 'tool_call',
    toolCallId: `tool-${nextId}`,
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    result: options.result,
    status: options.status ?? 'complete',
  };
}

/** The one chip in a single-chip roster, or a readable failure if there is not exactly one. */
function only(chips: TouchChip[]): TouchChip {
  expect(chips).toHaveLength(1);
  return chips[0];
}

/** Find a chip by the target it points at. */
function byTarget(chips: TouchChip[], fullTarget: string): TouchChip {
  const found = chips.find((chip) => chip.fullTarget === fullTarget);
  expect(found, `no chip for ${fullTarget}`).toBeDefined();
  return found as TouchChip;
}

describe('accumulateTouchChips', () => {
  describe('dedup', () => {
    it('folds two reads of the same file into one chip counted twice', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
      ]);

      const chip = only(chips);
      expect(chip.touches).toBe(2);
      expect(chip.label).toBe('a.ts');
      expect(chip.fullTarget).toBe('/repo/src/a.ts');
      expect(chip.verb).toBe('read');
    });

    it('counts three reads as ×3 with one history entry each', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
      ]);

      const chip = only(chips);
      expect(chip.touches).toBe(3);
      expect(chip.history).toEqual(['read', 'read', 'read']);
    });

    it('folds URLs that differ only by fragment into one chip', () => {
      const chips = accumulateTouchChips([
        toolCall('WebFetch', { url: 'https://example.com/page#section1' }),
        toolCall('WebFetch', { url: 'https://example.com/page#section2' }),
      ]);

      const chip = only(chips);
      expect(chip.touches).toBe(2);
      expect(chip.key).not.toContain('#');
      expect(chip.kind).toBe('url');
      expect(chip.label).toBe('example.com');
    });

    it('keeps the query string while stripping the fragment', () => {
      const chips = accumulateTouchChips([
        toolCall('WebFetch', { url: 'https://a.com/x?q=1#frag' }),
        toolCall('WebFetch', { url: 'https://a.com/x?q=1' }),
      ]);

      const chip = only(chips);
      expect(chip.touches).toBe(2);
      expect(chip.key).toBe('url:https://a.com/x?q=1');
    });

    it('drops a leading www. from the domain label', () => {
      const chip = only(
        accumulateTouchChips([toolCall('WebFetch', { url: 'https://www.dorkos.ai/docs' })])
      );
      expect(chip.label).toBe('dorkos.ai');
    });

    it('never merges a command with a file of the same name', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: 'build.sh' }),
        toolCall('Bash', { command: 'build.sh' }),
      ]);

      expect(chips).toHaveLength(2);
      expect(chips.map((chip) => chip.verb)).toEqual(['read', 'run']);
    });

    it('never merges a grep pattern with a web search for the same words', () => {
      const chips = accumulateTouchChips([
        toolCall('Grep', { pattern: 'coordination' }),
        toolCall('WebSearch', { query: 'coordination' }),
      ]);

      expect(chips).toHaveLength(2);
    });
  });

  describe('path identity', () => {
    it('folds `./src/a.ts` into `src/a.ts`', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: 'src/a.ts' }),
          toolCall('Read', { file_path: './src/a.ts' }),
        ])
      );

      expect(chip.touches).toBe(2);
      expect(chip.fullTarget).toBe('src/a.ts');
    });

    it('walks `..` out of a path before comparing it', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
          toolCall('Read', { file_path: '/repo/src/lib/../a.ts' }),
        ])
      );

      expect(chip.touches).toBe(2);
      expect(chip.fullTarget).toBe('/repo/src/a.ts');
    });

    it('folds a relative path into the absolute chip it names', () => {
      // This is the shape that shipped a lie: the tool read the file by its full
      // path, the shell deleted it by a relative one, and the turn showed a
      // clickable chip for a file that is gone beside its own tombstone.
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: '/repo/src/old.ts' }),
          toolCall('Bash', { command: 'rm src/old.ts' }),
        ]).filter((entry) => entry.kind === 'file')
      );

      expect(chip.verb).toBe('delete');
      expect(chip.touches).toBe(2);
      expect(chip.fullTarget).toBe('/repo/src/old.ts');
    });

    it('lets an absolute path claim the relative chip that arrived first', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: './src/a.ts' }),
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
        ])
      );

      expect(chip.touches).toBe(2);
      // The full path is the one the canvas can actually open.
      expect(chip.fullTarget).toBe('/repo/src/a.ts');
      expect(chip.label).toBe('a.ts');
    });

    it('keeps two files that merely end alike apart', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: 'a/index.ts' }),
        toolCall('Read', { file_path: 'b/index.ts' }),
      ]);

      expect(chips).toHaveLength(2);
    });

    it('never folds a glob into a file whose name it ends with', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Glob', { pattern: 'src/a.ts' }),
      ]);

      expect(chips).toHaveLength(2);
    });
  });

  describe('read → edit upgrade', () => {
    it('upgrades a read file in place when it is edited', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Edit', {
          file_path: '/repo/src/a.ts',
          old_string: 'a\nb',
          new_string: 'a\nX\nY',
        }),
      ]);

      const chip = only(chips);
      expect(chip.verb).toBe('edit');
      expect(chip.upgraded).toBe(true);
      expect(chip.touches).toBe(2);
    });

    it('leaves upgraded true, and does not re-trigger, on further edits', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: '/repo/src/a.ts' }),
        toolCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
        toolCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'b', new_string: 'c' }),
      ]);

      const chip = only(chips);
      expect(chip.upgraded).toBe(true);
      expect(chip.verb).toBe('edit');
      expect(chip.touches).toBe(3);
    });

    it('does not mark a file that was only ever edited as upgraded', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
        ])
      );
      expect(chip.upgraded).toBeUndefined();
    });
  });

  describe('verb precedence', () => {
    it('keeps edit after a later read (edit wins)', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
          toolCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
        ])
      );

      expect(chip.verb).toBe('edit');
      expect(chip.touches).toBe(3);
    });

    it('lets a delete outrank an earlier edit', () => {
      const chips = accumulateTouchChips([
        toolCall('Edit', { file_path: 'old.ts', old_string: 'a', new_string: 'b' }),
        toolCall('Bash', { command: 'rm old.ts' }),
      ]);

      expect(byTarget(chips, 'old.ts').verb).toBe('delete');
    });

    it('lets a create outrank an earlier read', () => {
      const chips = accumulateTouchChips([
        toolCall('Read', { file_path: 'notes.md' }),
        toolCall(
          'Write',
          { file_path: 'notes.md' },
          { result: 'File created successfully at: notes.md' }
        ),
      ]);

      expect(only(chips).verb).toBe('create');
    });
  });

  describe('diffstat', () => {
    it('sums additions and deletions across every edit to the same file', () => {
      const chips = accumulateTouchChips([
        toolCall('Edit', {
          file_path: '/repo/src/a.ts',
          old_string: 'a\nb',
          new_string: 'a\nX\nY',
        }),
        toolCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'p', new_string: 'p\nq' }),
      ]);

      const chip = only(chips);
      // First edit: +2 −1. Second: +1 −0.
      expect(chip.additions).toBe(3);
      expect(chip.deletions).toBe(1);
    });

    it('sums a MultiEdit across its edits array', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('MultiEdit', {
            file_path: '/repo/src/a.ts',
            edits: [
              { old_string: 'a\nb', new_string: 'a\nX\nY' },
              { old_string: 'p', new_string: 'p\nq' },
            ],
          }),
        ])
      );

      expect(chip.additions).toBe(3);
      expect(chip.deletions).toBe(1);
      expect(chip.history).toEqual(['edited +3 −1']);
    });

    it('omits numbers rather than fabricating them when an edit reports no strings', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('NotebookEdit', { notebook_path: '/repo/nb.ipynb', cell_id: 'c1' }),
        ])
      );

      expect(chip.verb).toBe('edit');
      expect(chip.label).toBe('nb.ipynb');
      expect(chip.additions).toBeUndefined();
      expect(chip.deletions).toBeUndefined();
    });

    it('carries no diffstat on a read', () => {
      const chip = only(accumulateTouchChips([toolCall('Read', { file_path: 'a.ts' })]));
      expect(chip.additions).toBeUndefined();
      expect(chip.deletions).toBeUndefined();
    });
  });

  describe('rm parsing', () => {
    it('extracts a plain rm target alongside the command chip', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'rm foo.txt' })]);

      expect(chips).toHaveLength(2);
      expect(byTarget(chips, 'rm foo.txt').verb).toBe('run');
      const deleted = byTarget(chips, 'foo.txt');
      expect(deleted.verb).toBe('delete');
      expect(deleted.kind).toBe('file');
      expect(deleted.key).toBe('file:foo.txt');
    });

    it('ignores flag tokens, combined or separate', () => {
      const combined = accumulateTouchChips([toolCall('Bash', { command: 'rm -rf dist/' })]);
      expect(byTarget(combined, 'dist').verb).toBe('delete');

      const separate = accumulateTouchChips([toolCall('Bash', { command: 'rm -r -f build/' })]);
      expect(byTarget(separate, 'build').verb).toBe('delete');
    });

    it('extracts every path from a multi-argument rm', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'rm a.txt b.txt c.txt' })]);

      const deleted = chips.filter((chip) => chip.verb === 'delete').map((chip) => chip.fullTarget);
      expect(deleted).toEqual(['a.txt', 'b.txt', 'c.txt']);
    });

    it('keeps a quoted path with spaces whole', () => {
      const chips = accumulateTouchChips([
        toolCall('Bash', { command: 'rm "path with spaces.txt"' }),
      ]);

      const deleted = chips.filter((chip) => chip.verb === 'delete');
      expect(deleted).toHaveLength(1);
      expect(deleted[0].fullTarget).toBe('path with spaces.txt');
    });

    it('reads git rm too', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'git rm tracked-file.ts' })]);
      expect(byTarget(chips, 'tracked-file.ts').verb).toBe('delete');
    });

    it('finds an rm inside a compound command', () => {
      const chips = accumulateTouchChips([
        toolCall('Bash', { command: 'pnpm build && rm -rf .cache; echo done' }),
      ]);

      expect(byTarget(chips, '.cache').verb).toBe('delete');
    });

    it('produces no delete chip for a command that deletes nothing', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'pnpm test' })]);

      expect(chips).toHaveLength(1);
      expect(chips[0].verb).toBe('run');
      expect(chips[0].kind).toBe('command');
    });

    it('still reads two deletions joined on one line', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'rm a.ts && rm b.ts' })]);

      const deleted = chips.filter((chip) => chip.verb === 'delete').map((chip) => chip.fullTarget);
      expect(deleted).toEqual(['a.ts', 'b.ts']);
    });

    it('claims nothing an rm inside a heredoc never deleted', () => {
      // The `rm -rf` here is a line of a deploy script being written to disk.
      // Reading it as a deletion tells the operator their web root is gone.
      const chips = accumulateTouchChips([
        toolCall('Bash', {
          command:
            "cat > deploy.sh <<'EOF'\nset -e\nrm -rf /var/www/html\ncp -r dist /var/www\nEOF",
        }),
      ]);

      expect(chips).toHaveLength(1);
      expect(chips[0].verb).toBe('run');
    });

    it('claims nothing an rm inside a quoted echo never deleted', () => {
      const chips = accumulateTouchChips([
        toolCall('Bash', { command: 'echo "rm -rf /" > x.sh\nchmod +x x.sh' }),
      ]);

      expect(chips.filter((chip) => chip.verb === 'delete')).toEqual([]);
    });

    it('keeps a deletion on the same line as the redirect that follows it', () => {
      const chips = accumulateTouchChips([
        toolCall('Bash', { command: 'rm stale.log > /dev/null 2>&1' }),
      ]);

      expect(byTarget(chips, 'stale.log').verb).toBe('delete');
    });

    it('leaves a glob it deleted as a record rather than a link to open', () => {
      // Nobody on this side knows what `build/*.js` matched, so there is no one
      // file to open — and `*.js` is not a filename anybody has.
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'rm build/*.js' })]);

      const deleted = byTarget(chips, 'build/*.js');
      expect(deleted.verb).toBe('delete');
      expect(deleted.pattern).toBe(true);
      expect(deleted.label).toBe('build/*.js');
    });

    it('flags a variable and a home-relative target as patterns too', () => {
      const variable = accumulateTouchChips([
        toolCall('Bash', { command: 'rm $BUILD_DIR/out.js' }),
      ]);
      expect(byTarget(variable, '$BUILD_DIR/out.js').pattern).toBe(true);

      const home = accumulateTouchChips([toolCall('Bash', { command: 'rm ~/.cache/thing' })]);
      expect(byTarget(home, '~/.cache/thing').pattern).toBe(true);
    });

    it('leaves a plainly-named deletion openable', () => {
      const chips = accumulateTouchChips([toolCall('Bash', { command: 'rm src/old.ts' })]);
      expect(byTarget(chips, 'src/old.ts').pattern).toBeUndefined();
    });
  });

  describe('command labels', () => {
    it('shows a long command by its first line, truncated', () => {
      const command = `cat > deploy.sh <<'EOF'\n${'echo hello world; '.repeat(20)}\nEOF`;
      const chip = only(accumulateTouchChips([toolCall('Bash', { command })]));

      expect(chip.label).toBe("cat > deploy.sh <<'EOF'");
      // The whole script is still the identity and the tooltip.
      expect(chip.fullTarget).toBe(command);
      expect(chip.key).toBe(`run:${command}`);
    });

    it('ellipsises a first line longer than the chip can carry', () => {
      const command = `pnpm vitest run ${'a'.repeat(80)}.test.ts`;
      const chip = only(accumulateTouchChips([toolCall('Bash', { command })]));

      expect(chip.label).toHaveLength(60);
      expect(chip.label.endsWith('…')).toBe(true);
    });

    it('leaves a short command exactly as it was typed', () => {
      const chip = only(accumulateTouchChips([toolCall('Bash', { command: 'pnpm test' })]));
      expect(chip.label).toBe('pnpm test');
    });
  });

  describe('Write', () => {
    it('reads a "created" result as a create', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall(
            'Write',
            { file_path: '/tmp/new.ts' },
            { result: 'File created successfully at: /tmp/new.ts' }
          ),
        ])
      );

      expect(chip.verb).toBe('create');
      expect(chip.history).toEqual(['created']);
    });

    it('counts every line of a created file as an addition, and nothing as removed', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall(
            'Write',
            { file_path: '/tmp/new.ts', content: 'one\ntwo\nthree\n' },
            { result: 'File created successfully at: /tmp/new.ts' }
          ),
        ])
      );

      // A trailing newline ends the last line rather than starting a fourth.
      expect(chip.additions).toBe(3);
      // Not `0`: nothing was removed, and nothing measured a removal either.
      expect(chip.deletions).toBeUndefined();
      expect(chip.history).toEqual(['created +3']);
    });

    it('counts nothing for a created file the wire gave no content for', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Write', { file_path: '/tmp/new.ts' }, { result: 'File created successfully' }),
        ])
      );

      expect(chip.additions).toBeUndefined();
      expect(chip.history).toEqual(['created']);
    });

    it('claims no additions for an overwrite, whose replaced lines nobody counted', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall(
            'Write',
            { file_path: '/tmp/existing.ts', content: 'one\ntwo\nthree' },
            { result: 'The file /tmp/existing.ts has been updated.' }
          ),
        ])
      );

      expect(chip.verb).toBe('edit');
      expect(chip.additions).toBeUndefined();
      expect(chip.deletions).toBeUndefined();
    });

    it('reads any other result as an edit', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall(
            'Write',
            { file_path: '/tmp/existing.ts' },
            { result: 'The file /tmp/existing.ts has been updated.' }
          ),
        ])
      );

      expect(chip.verb).toBe('edit');
    });
  });

  describe('search and fetch targets', () => {
    it('labels a grep with its quoted pattern and records parseable hits', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Grep', { pattern: 'accumulate' }, { result: 'Found 12 matches' }),
        ])
      );

      expect(chip.verb).toBe('search');
      expect(chip.kind).toBe('command');
      expect(chip.label).toBe('"accumulate"');
      expect(chip.hits).toBe(12);
      expect(chip.history).toEqual(['searched (12 hits)']);
    });

    it('adds up the matches of two searches for the same words', () => {
      // Two searches for one pattern are usually two different searches — the
      // same words asked of a different directory — so their matches add up,
      // the way every other counter on a chip does.
      const chip = only(
        accumulateTouchChips([
          toolCall('Grep', { pattern: 'accumulate', path: 'src/' }, { result: 'Found 12 matches' }),
          toolCall('Grep', { pattern: 'accumulate', path: 'test/' }, { result: 'Found 2 matches' }),
        ])
      );

      expect(chip.hits).toBe(14);
      expect(chip.touches).toBe(2);
    });

    it('says "1 hit" rather than "1 hits" in the history line', () => {
      const chip = only(
        accumulateTouchChips([toolCall('Grep', { pattern: 'once' }, { result: 'Found 1 match' })])
      );

      expect(chip.hits).toBe(1);
      expect(chip.history).toEqual(['searched (1 hit)']);
    });

    it('omits hit details when the grep result says nothing countable', () => {
      const chip = only(accumulateTouchChips([toolCall('Grep', { pattern: 'accumulate' })]));
      expect(chip.hits).toBeUndefined();
      expect(chip.history).toEqual(['searched']);
    });

    it('counts no hits from a grep that failed', () => {
      // The result of a failed grep is an error message. Counting its lines
      // badges the chip with matches nothing ever found.
      const chip = only(
        accumulateTouchChips([
          toolCall(
            'Grep',
            { pattern: 'accumulate' },
            { result: 'rg: no such file or directory', status: 'error' }
          ),
        ])
      );

      expect(chip.hits).toBeUndefined();
      expect(chip.history).toEqual(['searched']);
    });

    it('counts no hits from a result that only tallies files', () => {
      // `files_with_matches` mode answers a different question — how many files
      // contain a match, not how many matches there are.
      const chip = only(
        accumulateTouchChips([
          toolCall('Grep', { pattern: 'accumulate' }, { result: 'Found 7 files' }),
        ])
      );

      expect(chip.hits).toBeUndefined();
    });

    it('labels a web search with its query, and no glyph of its own', () => {
      const chip = only(
        accumulateTouchChips([toolCall('WebSearch', { query: 'calm tech motion' })])
      );

      expect(chip.verb).toBe('search');
      expect(chip.kind).toBe('command');
      // The chip renders the verb's 🔍 itself; a second one in the label reads
      // as a rendering bug.
      expect(chip.label).toBe('calm tech motion');
      expect(chip.fullTarget).toBe('calm tech motion');
    });

    it('makes one read chip out of a glob pattern, flagged as naming many files', () => {
      const chip = only(accumulateTouchChips([toolCall('Glob', { pattern: 'src/**/*.ts' })]));

      expect(chip.verb).toBe('read');
      expect(chip.kind).toBe('file');
      expect(chip.label).toBe('src/**/*.ts');
      // The flag is what stops the chip trying to open `src/**/*.ts` as a file.
      expect(chip.pattern).toBe(true);
    });

    it('leaves a file reached by an exact path openable, whatever a glob called it', () => {
      // `index.ts` is a valid path and a valid glob. Once something has opened
      // it by name, the chip points at a real file again.
      const chip = only(
        accumulateTouchChips([
          toolCall('Glob', { pattern: 'index.ts' }),
          toolCall('Read', { file_path: 'index.ts' }),
        ])
      );

      expect(chip.touches).toBe(2);
      expect(chip.pattern).toBeUndefined();
    });

    it('flags nothing as a pattern when a real file is read', () => {
      const chip = only(accumulateTouchChips([toolCall('Read', { file_path: '/repo/src/a.ts' })]));
      expect(chip.pattern).toBeUndefined();
    });
  });

  describe('live and error state', () => {
    it('marks a chip live while its tool is still running', () => {
      const chip = only(
        accumulateTouchChips([toolCall('Read', { file_path: 'a.ts' }, { status: 'running' })])
      );
      expect(chip.live).toBe(true);
    });

    it('marks a chip live while its tool is pending', () => {
      const chip = only(
        accumulateTouchChips([toolCall('Read', { file_path: 'a.ts' }, { status: 'pending' })])
      );
      expect(chip.live).toBe(true);
    });

    it('settles a chip once every contributing tool is complete', () => {
      const chip = only(accumulateTouchChips([toolCall('Read', { file_path: 'a.ts' })]));
      expect(chip.live).toBe(false);
    });

    it('tints a chip whose tool failed', () => {
      const chip = only(
        accumulateTouchChips([toolCall('Read', { file_path: 'a.ts' }, { status: 'error' })])
      );
      expect(chip.error).toBe(true);
    });

    it('keeps a chip live while an earlier touch of it is still running', () => {
      // Tools run in parallel. A read that has not come back yet is still work
      // in progress on that file, whatever the edit that landed first says.
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: 'a.ts' }, { status: 'running' }),
          toolCall('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
        ])
      );

      expect(chip.live).toBe(true);
    });

    it('keeps the error sticky when a later touch succeeds', () => {
      const chip = only(
        accumulateTouchChips([
          toolCall('Read', { file_path: 'a.ts' }, { status: 'error' }),
          toolCall('Read', { file_path: 'a.ts' }, { status: 'complete' }),
        ])
      );
      expect(chip.error).toBe(true);
    });
  });

  describe('ordering', () => {
    const parts: MessagePart[] = [
      toolCall('Bash', { command: 'pnpm test' }),
      toolCall('Read', { file_path: '/repo/one.ts' }),
      toolCall('WebFetch', { url: 'https://example.com/x' }),
      toolCall('Read', { file_path: '/repo/two.ts' }),
    ];

    it('returns chips in first-touch order by default', () => {
      const chips = accumulateTouchChips(parts);

      expect(chips.map((chip) => chip.label)).toEqual([
        'pnpm test',
        'one.ts',
        'example.com',
        'two.ts',
      ]);
      expect(chips.map((chip) => chip.firstSeq)).toEqual([0, 1, 2, 3]);
    });

    // How the tray ORDERS this roster is the tray's own question, pinned against
    // the comparator it actually ships in `ChipTray.test.tsx`. A comparator
    // written out again here would stay green while the tray's changed.

    it('tracks last touch separately so the chronological lens can reorder', () => {
      const chips = accumulateTouchChips([
        toolCall('Edit', { file_path: '/repo/one.ts', old_string: 'a', new_string: 'b' }),
        toolCall('Read', { file_path: '/repo/two.ts' }),
        toolCall('Read', { file_path: '/repo/one.ts' }),
      ]);

      expect(chips.map((chip) => chip.label)).toEqual(['one.ts', 'two.ts']);
      const chronological = [...chips].sort((a, b) => a.lastSeq - b.lastSeq);
      expect(chronological.map((chip) => chip.label)).toEqual(['two.ts', 'one.ts']);
    });
  });

  describe('exclusions and bad input', () => {
    it('makes no chip for subagents, todos, or MCP tools', () => {
      const chips = accumulateTouchChips([
        toolCall('Task', { description: 'go and look' }),
        toolCall('TodoWrite', { todos: [] }),
        toolCall('mcp__foo__bar', { file_path: '/repo/a.ts' }),
      ]);

      expect(chips).toEqual([]);
    });

    it('skips a part whose input is not parseable JSON, without throwing', () => {
      expect(() =>
        accumulateTouchChips([
          toolCall('Read', '{not json'),
          toolCall('Read', { file_path: '/repo/a.ts' }),
        ])
      ).not.toThrow();

      const chips = accumulateTouchChips([
        toolCall('Read', '{not json'),
        toolCall('Read', { file_path: '/repo/a.ts' }),
      ]);
      expect(only(chips).fullTarget).toBe('/repo/a.ts');
    });

    it('skips a tool call with no input at all', () => {
      expect(
        accumulateTouchChips([
          { type: 'tool_call', toolCallId: 'x', toolName: 'Read', status: 'complete' },
        ])
      ).toEqual([]);
    });

    it('ignores parts that are not tool calls', () => {
      expect(accumulateTouchChips([{ type: 'text', text: 'hello' }])).toEqual([]);
    });

    it('returns nothing for an empty turn', () => {
      expect(accumulateTouchChips([])).toEqual([]);
    });
  });

  describe('re-parsing', () => {
    it('does not re-parse a part that has not changed', () => {
      // The fold runs on every render, and a render happens on every stream
      // frame — including each text delta, which changes nothing about any tool
      // call. Re-parsing there means `JSON.parse` over a whole written file for
      // every word the model then says.
      const write = toolCall('Write', {
        file_path: '/repo/src/big.ts',
        content: 'line\n'.repeat(500),
      });
      const parts = [write];
      accumulateTouchChips(parts);

      const parse = vi.spyOn(JSON, 'parse');
      try {
        // A fresh array holding the same part, which is exactly what the stream
        // hands the strip on every frame.
        accumulateTouchChips([...parts]);
        accumulateTouchChips([...parts]);
        expect(parse).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
      }
    });

    it('re-parses a part whose result has landed since', () => {
      const grep = toolCall('Grep', { pattern: 'x' }, { status: 'running' }) as Extract<
        MessagePart,
        { type: 'tool_call' }
      >;
      expect(only(accumulateTouchChips([grep])).hits).toBeUndefined();

      // Parts are mutated in place as a tool settles, so identity alone would
      // serve the chip that was parsed before the result existed.
      grep.result = 'Found 3 matches';
      grep.status = 'complete';

      expect(only(accumulateTouchChips([grep])).hits).toBe(3);
    });
  });
});
