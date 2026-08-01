import { describe, it, expect } from 'vitest';
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
      expect(chip.history).toEqual(['searched (12 hits)']);
    });

    it('omits hit details when the grep result says nothing countable', () => {
      const chip = only(accumulateTouchChips([toolCall('Grep', { pattern: 'accumulate' })]));
      expect(chip.history).toEqual(['searched']);
    });

    it('labels a web search with its query', () => {
      const chip = only(
        accumulateTouchChips([toolCall('WebSearch', { query: 'calm tech motion' })])
      );

      expect(chip.verb).toBe('search');
      expect(chip.kind).toBe('command');
      expect(chip.label).toBe('🔍 calm tech motion');
      expect(chip.fullTarget).toBe('calm tech motion');
    });

    it('makes one read chip out of a glob pattern', () => {
      const chip = only(accumulateTouchChips([toolCall('Glob', { pattern: 'src/**/*.ts' })]));

      expect(chip.verb).toBe('read');
      expect(chip.kind).toBe('file');
      expect(chip.label).toBe('src/**/*.ts');
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

    it('groups by kind then first touch when the tray sorts that way', () => {
      const chips = [...accumulateTouchChips(parts)].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.firstSeq - b.firstSeq
      );

      expect(chips.map((chip) => chip.label)).toEqual([
        'pnpm test',
        'one.ts',
        'two.ts',
        'example.com',
      ]);
    });

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
});
