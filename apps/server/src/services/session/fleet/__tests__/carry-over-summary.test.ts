/**
 * The default carry-over summary (spec `claude-account-fleet` D9): every
 * section, the facts read from the transcript, the pointer, the cap order, and
 * no model or runtime query anywhere on its path.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import {
  MESSAGE_MAX_CHARS,
  TRANSCRIPT_POINTER_LINE,
  buildCarryOverSummary,
  claudeTranscriptPath,
  extractTranscriptFacts,
  gatherCarryOverSummary,
  type CarryOverSummaryInput,
} from '../carry-over-summary.js';

function tool(toolName: string, input: Record<string, unknown>, result = 'TOOL OUTPUT') {
  return {
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
    input: JSON.stringify(input),
    result,
    status: 'complete' as const,
  };
}

const transcript: HistoryMessage[] = [
  { id: '1', role: 'user', content: 'Make the export button work' },
  {
    id: '2',
    role: 'assistant',
    content: 'Reading the component first.',
    toolCalls: [tool('Read', { file_path: '/p/src/Export.tsx' })],
  },
  {
    id: '3',
    role: 'assistant',
    content: 'Fixing it.',
    toolCalls: [
      tool('Edit', { file_path: '/p/src/Export.tsx' }),
      tool('Write', { file_path: '/p/src/export.test.ts' }),
      tool('NotebookEdit', { notebook_path: '/p/nb.ipynb' }),
      tool('Edit', { file_path: '/p/src/Export.tsx' }),
    ],
  },
  { id: '4', role: 'user', content: '/compact', messageType: 'command' },
  { id: '5', role: 'user', content: 'Also run the tests' },
  {
    id: '6',
    role: 'assistant',
    content: 'Running them.',
    toolCalls: [tool('Bash', { command: 'pnpm test' }, 'hundreds of lines of test output')],
  },
];

const base = {
  sessionId: 'old-session',
  accountLabel: 'Work',
  window: 'seven_day',
  resetsAt: '2026-09-28T15:00:00.000Z',
  cwd: '/p',
  transcriptPath: '/accounts/work/projects/-p/old-session.jsonl',
};

describe('extractTranscriptFacts', () => {
  it('reads edited files once each in order, the last step, the first request and the recent messages', () => {
    const facts = extractTranscriptFacts(transcript);
    expect(facts.touchedFiles).toEqual([
      '/p/src/Export.tsx',
      '/p/src/export.test.ts',
      '/p/nb.ipynb',
    ]);
    expect(facts.lastToolStep).toEqual({ name: 'Bash', target: 'pnpm test' });
    expect(facts.firstUserMessage).toBe('Make the export button work');
    expect(facts.recentMessages.map((m) => m.text)).toEqual([
      'Make the export button work',
      'Reading the component first.',
      'Fixing it.',
      'Also run the tests',
      'Running them.',
    ]);
  });

  it('keeps only the last six messages, each trimmed', () => {
    const long: HistoryMessage[] = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i} ${'x'.repeat(MESSAGE_MAX_CHARS + 50)}`,
    }));
    const facts = extractTranscriptFacts(long);
    expect(facts.recentMessages).toHaveLength(6);
    expect(facts.recentMessages[0]!.text.startsWith('3 ')).toBe(true);
    expect(facts.recentMessages[0]!.text.length).toBe(MESSAGE_MAX_CHARS);
  });
});

describe('buildCarryOverSummary', () => {
  const full: CarryOverSummaryInput = {
    ...base,
    gitBranch: 'fix-export',
    gitStatus: ' M src/Export.tsx',
    gitDiffStat: ' src/Export.tsx | 4 ++--',
    ...extractTranscriptFacts(transcript),
  };

  it('holds every section, and never tool output', () => {
    const text = buildCarryOverSummary(full);
    for (const part of [
      'Previous session: old-session, on Work.',
      'It hit the weekly limit, which resets at 2026-09-28T15:00:00.000Z.',
      'Folder: /p',
      'Git branch: fix-export',
      'git status --short:\n M src/Export.tsx',
      'git diff --stat:\n src/Export.tsx | 4 ++--',
      '- /p/src/export.test.ts',
      'Its last step: Bash on pnpm test',
      'The first request:\nMake the export button work',
      '[assistant] Running them.',
      `The full transcript is ${base.transcriptPath} (session old-session). ${TRANSCRIPT_POINTER_LINE}`,
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('TOOL OUTPUT');
    expect(text).not.toContain('hundreds of lines');
  });

  it('drops the diff stat only after every message, when messages alone are not enough', () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      text: `m${i} ${'y'.repeat(300)}`,
    }));
    const diff = 'd'.repeat(1_900);
    // ~8,400 characters of files: with the diff stat it cannot fit, without it it can.
    const files = Array.from({ length: 600 }, (_, i) => `/p/f${String(i).padStart(4, '0')}.ts`);
    const text = buildCarryOverSummary({
      ...full,
      recentMessages: messages,
      gitDiffStat: diff,
      touchedFiles: files,
    });
    expect(text.length).toBeLessThanOrEqual(SEED_CONTEXT_MAX_LENGTH);
    expect(text).not.toContain(diff);
    for (const m of messages) expect(text).not.toContain(m.text);
    expect(text).toContain('/p/f0599.ts');
  });

  it('keeps the diff stat while dropping messages is enough', () => {
    const text = buildCarryOverSummary({
      ...full,
      recentMessages: Array.from({ length: 6 }, (_, i) => ({
        role: 'user' as const,
        text: `m${i} ${'z'.repeat(1_900)}`,
      })),
    });
    expect(text.length).toBeLessThanOrEqual(SEED_CONTEXT_MAX_LENGTH);
    expect(text).toContain(' src/Export.tsx | 4 ++--');
    expect(text).not.toContain('m0 ');
  });

  it('leaves out the pointer when the transcript path is unknown', () => {
    expect(buildCarryOverSummary({ ...full, transcriptPath: null })).not.toContain(
      TRANSCRIPT_POINTER_LINE
    );
  });
});

describe('gatherCarryOverSummary', () => {
  it('reads git and the transcript through its lookups, and nothing else', async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return 'main\n';
      if (args[0] === 'status') return ' M a.ts\n';
      return ' a.ts | 1 +\n';
    });
    const readHistory = vi.fn(async () => transcript);
    const text = await gatherCarryOverSummary(base, { runGit, readHistory });
    expect(runGit.mock.calls.map((c) => c[1])).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['status', '--short'],
      ['diff', '--stat'],
    ]);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(text).toContain('Git branch: main');
    expect(text).toContain('/p/src/Export.tsx');
  });

  it('builds the summary without the git sections when git fails', async () => {
    const text = await gatherCarryOverSummary(base, {
      runGit: async () => {
        throw new Error('not a repository');
      },
      readHistory: async () => {
        throw new Error('no transcript');
      },
    });
    expect(text).toContain('Previous session: old-session');
    expect(text).not.toContain('Git branch');
  });
});

describe('claudeTranscriptPath', () => {
  it('is the account’s projects folder, the folder’s slug and the session id', () => {
    expect(claudeTranscriptPath('/accounts/work', '/p', 's-1')).toBe(
      '/accounts/work/projects/-p/s-1.jsonl'
    );
    expect(claudeTranscriptPath(null, '/p', 's-1')).toBeNull();
  });
});
