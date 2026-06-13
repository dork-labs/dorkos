/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CommandEntry } from '@dorkos/shared/types';
import { useCommandPalette } from '../use-command-palette';

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
