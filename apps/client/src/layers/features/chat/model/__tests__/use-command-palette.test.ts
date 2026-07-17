/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CommandEntry } from '@dorkos/shared/types';
import { useCommandPalette } from '../use-command-palette';
import { buildPaletteCommands } from '../build-palette-commands';

const commands: CommandEntry[] = [
  { fullCommand: '/usage', description: 'Show context usage', aliases: ['cost', 'stats'] },
  { fullCommand: '/compact', description: 'Compact the conversation' },
];

describe('useCommandPalette — alias fuzzy matching (DOR-108)', () => {
  it('surfaces a command when the query matches one of its aliases', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands, input: '/cost', cursorPos: 5 })
    );

    act(() => {
      result.current.detectCommandTrigger('/cost', 5);
    });

    expect(result.current.filteredCommands.map((c) => c.fullCommand)).toContain('/usage');
  });

  it('matches by alias without surfacing unrelated commands', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands, input: '/stats', cursorPos: 6 })
    );

    act(() => {
      result.current.detectCommandTrigger('/stats', 6);
    });

    const names = result.current.filteredCommands.map((c) => c.fullCommand);
    expect(names).toContain('/usage');
    expect(names).not.toContain('/compact');
  });

  it('still matches by primary command name', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands, input: '/compact', cursorPos: 8 })
    );

    act(() => {
      result.current.detectCommandTrigger('/compact', 8);
    });

    expect(result.current.filteredCommands.map((c) => c.fullCommand)).toContain('/compact');
  });
});

describe('useCommandPalette — ranking & alias provenance (DOR-119/120)', () => {
  const ranked: CommandEntry[] = [
    { fullCommand: '/statusline', description: 'Configure the status line' },
    { fullCommand: '/usage', description: 'Show context usage', aliases: ['cost', 'stats'] },
  ];

  it('ranks an alias-exact match above an unrelated name subsequence', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands: ranked, input: '/stats', cursorPos: 6 })
    );

    act(() => {
      result.current.detectCommandTrigger('/stats', 6);
    });

    // '/usage' (alias 'stats') must outrank '/statusline' ('stats' name subsequence).
    expect(result.current.filteredCommands[0].fullCommand).toBe('/usage');
    expect(result.current.filteredCommands[0].matchedAlias).toBe('stats');
  });

  it('tags no alias when a command matches by its own name', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands: ranked, input: '/usage', cursorPos: 6 })
    );

    act(() => {
      result.current.detectCommandTrigger('/usage', 6);
    });

    const first = result.current.filteredCommands[0];
    expect(first.fullCommand).toBe('/usage');
    expect(first.matchedAlias).toBeUndefined();
  });
});

describe('useCommandPalette — command-intent alias hints (DOR-109)', () => {
  it('surfaces the compact intent with a "matched" alias when the query is a cross-agent alias', () => {
    // Typing an agent's own word for compaction (/summarize) resolves to the
    // /compact intent and shows which alias matched — muscle memory carries over.
    const commands = buildPaletteCommands([]);
    const { result } = renderHook(() =>
      useCommandPalette({ commands, input: '/summarize', cursorPos: 10 })
    );

    act(() => {
      result.current.detectCommandTrigger('/summarize', 10);
    });

    const first = result.current.filteredCommands[0];
    expect(first.fullCommand).toBe('/compact');
    expect(first.matchedAlias).toBe('/summarize');
  });
});
