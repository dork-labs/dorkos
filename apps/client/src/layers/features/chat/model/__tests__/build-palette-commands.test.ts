import { describe, it, expect } from 'vitest';
import type { CommandEntry } from '@dorkos/shared/types';
import { buildPaletteCommands } from '../build-palette-commands';

/** Count how many palette rows carry a given `/token`. */
function countByToken(rows: { fullCommand: string }[], token: string): number {
  return rows.filter((r) => r.fullCommand === token).length;
}

describe('buildPaletteCommands', () => {
  it('projects exactly one row per canonical intent', () => {
    // VC2: the three intents each appear once, ahead of everything else.
    const rows = buildPaletteCommands([]);
    expect(countByToken(rows, '/compact')).toBe(1);
    expect(countByToken(rows, '/clear')).toBe(1);
    expect(countByToken(rows, '/context')).toBe(1);
    expect(rows.slice(0, 3).map((r) => r.fullCommand)).toEqual(['/compact', '/clear', '/context']);
  });

  it('carries the cross-agent aliases on each intent so the ranker + hint light up', () => {
    // The aliases field is what powers the fuzzy ranker and the "matched /{alias}" hint.
    const rows = buildPaletteCommands([]);
    const compact = rows.find((r) => r.fullCommand === '/compact');
    expect(compact?.aliases).toEqual(['/compress', '/summarize']);
    const context = rows.find((r) => r.fullCommand === '/context');
    expect(context?.aliases).toEqual(['/usage', '/cost', '/stats', '/status']);
  });

  it('keeps the /rename native command (a non-intent native passes through)', () => {
    const rows = buildPaletteCommands([]);
    expect(countByToken(rows, '/rename')).toBe(1);
  });

  it('dedupes a runtime command that collides with an intent by its canonical token', () => {
    // Claude's own /compact must fold into the compact intent row, not double it.
    const runtimeCommands: CommandEntry[] = [
      { command: 'compact', fullCommand: '/compact', description: 'Compact (runtime)' },
    ];
    const rows = buildPaletteCommands(runtimeCommands);
    expect(countByToken(rows, '/compact')).toBe(1);
    // The surviving row is the intent's (its description), not the runtime's.
    expect(rows.find((r) => r.fullCommand === '/compact')?.description).toBe(
      'Shrink the conversation to free up context'
    );
  });

  it('dedupes a runtime command that collides with an intent alias token', () => {
    // Claude's SDK /usage command is a context alias — it must fold into the
    // context intent row rather than render as a second /usage entry.
    const runtimeCommands: CommandEntry[] = [
      { command: 'usage', fullCommand: '/usage', description: 'Show usage (runtime)' },
    ];
    const rows = buildPaletteCommands(runtimeCommands);
    expect(countByToken(rows, '/usage')).toBe(0);
    expect(countByToken(rows, '/context')).toBe(1);
  });

  it('dedupes a runtime command whose OWN alias collides with an intent token', () => {
    // A runtime command named /shrink that aliases /compress folds into compact —
    // dedupe is by canonical token AND any alias.
    const runtimeCommands: CommandEntry[] = [
      { command: 'shrink', fullCommand: '/shrink', description: 'Shrink', aliases: ['/compress'] },
    ];
    const rows = buildPaletteCommands(runtimeCommands);
    expect(countByToken(rows, '/shrink')).toBe(0);
  });

  it('keeps a runtime command that does not collide with any intent or native token', () => {
    const runtimeCommands: CommandEntry[] = [
      { command: 'review', fullCommand: '/review', description: 'Review the diff' },
    ];
    const rows = buildPaletteCommands(runtimeCommands);
    expect(countByToken(rows, '/review')).toBe(1);
  });

  describe('honest capability gating (DOR-109 VC3)', () => {
    it('disables the compact row when the runtime declares compact unsupported', () => {
      // Codex cannot compact — the row shows, greyed out, with the honest reason.
      const rows = buildPaletteCommands([], {
        commandIntents: { compact: { supported: false } },
        runtimeLabel: 'Codex',
      });
      const compact = rows.find((r) => r.fullCommand === '/compact');
      expect(compact?.disabled).toBe(true);
      expect(compact?.disabledReason).toBe('Not supported by Codex');
    });

    it('leaves the compact row enabled when the runtime supports compact', () => {
      const rows = buildPaletteCommands([], {
        commandIntents: { compact: { supported: true } },
        runtimeLabel: 'Claude Code',
      });
      const compact = rows.find((r) => r.fullCommand === '/compact');
      expect(compact?.disabled).toBeUndefined();
      expect(compact?.disabledReason).toBeUndefined();
    });

    it('never gates the client-native intents (clear/context) regardless of caps', () => {
      // clear/context are DorkOS-native and universal — a false compact cap must
      // not leak onto them.
      const rows = buildPaletteCommands([], {
        commandIntents: { compact: { supported: false } },
        runtimeLabel: 'Codex',
      });
      expect(rows.find((r) => r.fullCommand === '/clear')?.disabled).toBeUndefined();
      expect(rows.find((r) => r.fullCommand === '/context')?.disabled).toBeUndefined();
    });

    it('leaves compact enabled while caps are still loading (optimistic)', () => {
      // A missing caps map must not falsely disable — the submit path re-gates.
      const rows = buildPaletteCommands([], { runtimeLabel: '' });
      expect(rows.find((r) => r.fullCommand === '/compact')?.disabled).toBeUndefined();
    });
  });
});
