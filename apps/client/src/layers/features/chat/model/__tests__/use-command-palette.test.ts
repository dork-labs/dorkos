/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CommandEntry } from '@dorkos/shared/types';
import type { PaletteCommandEntry } from '@/layers/entities/command';
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

describe('useCommandPalette — disabled-row keyboard navigation (DOR-109 VC3)', () => {
  const gated: PaletteCommandEntry[] = [
    { fullCommand: '/compact', description: 'Compact', disabled: true },
    { fullCommand: '/clear', description: 'Start fresh' },
    { fullCommand: '/context', description: 'Show usage' },
  ];

  it('lands the initial selection on the first enabled row, skipping a disabled one', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands: gated, input: '/', cursorPos: 1 })
    );
    act(() => {
      result.current.detectCommandTrigger('/', 1);
    });
    // Row 0 (/compact) is disabled, so selection starts on row 1 (/clear).
    expect(result.current.selectedIndex).toBe(1);
  });

  it('arrow navigation skips the disabled row when wrapping', () => {
    const { result } = renderHook(() =>
      useCommandPalette({ commands: gated, input: '/', cursorPos: 1 })
    );
    act(() => {
      result.current.detectCommandTrigger('/', 1);
    });
    // From /clear (1) → /context (2) → wrap past disabled /compact (0) → /clear (1).
    act(() => result.current.handleArrowDown());
    expect(result.current.selectedIndex).toBe(2);
    act(() => result.current.handleArrowDown());
    expect(result.current.selectedIndex).toBe(1);
    // Arrow up from /clear (1) wraps backward past disabled /compact (0) → /context (2).
    act(() => result.current.handleArrowUp());
    expect(result.current.selectedIndex).toBe(2);
  });
});

describe('useCommandPalette — selecting a command keeps the rest of the line (DOR-480)', () => {
  const deploy: CommandEntry = { fullCommand: '/deploy', description: 'Deploy' };

  /** Opens the palette with the caret at `cursor`, then picks `cmd`. */
  function selectWithCaretAt(input: string, cursor: number, cmd = deploy): string {
    const { result } = renderHook(() =>
      useCommandPalette({ commands: [deploy], input, cursorPos: cursor })
    );
    act(() => {
      result.current.detectCommandTrigger(input, cursor);
    });
    let next = '';
    act(() => {
      next = result.current.handleCommandSelect(cmd);
    });
    return next;
  }

  it('preserves text after the caret', () => {
    // Real sequence: type `/deploy staging`, click back to just after `/deploy`
    // (which reopens the palette), then press Enter believing you are sending.
    // The tail used to be deleted AND nothing was sent — the words were gone.
    expect(selectWithCaretAt('/deploy staging', 7)).toBe('/deploy staging');
  });

  it('preserves text after the caret when the command is mid-line', () => {
    expect(selectWithCaretAt('look at @src/app.ts /dep and report back', 24)).toBe(
      'look at @src/app.ts /deploy and report back'
    );
  });

  it('preserves a multi-word tail verbatim', () => {
    expect(selectWithCaretAt('/dep staging --dry-run then tell me', 4)).toBe(
      '/deploy staging --dry-run then tell me'
    );
  });

  it('still appends one trailing space when there is nothing after the caret', () => {
    expect(selectWithCaretAt('/dep', 4)).toBe('/deploy ');
  });

  it('does not double the separating space', () => {
    expect(selectWithCaretAt('/deploy staging', 7)).not.toContain('  ');
  });

  it('keyboard selection preserves the tail too', () => {
    const input = '/deploy staging';
    const { result } = renderHook(() =>
      useCommandPalette({ commands: [deploy], input, cursorPos: 7 })
    );
    act(() => {
      result.current.detectCommandTrigger(input, 7);
    });

    let next: string | null = null;
    act(() => {
      next = result.current.handleKeyboardSelect();
    });

    expect(next).toBe('/deploy staging');
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
