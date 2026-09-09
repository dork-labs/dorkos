/**
 * SRC-07 — the one sentence about a skill only some agent tools can see, at
 * every n and every list length.
 *
 * The sentences are asserted against the LITERAL rather than against the builder
 * that produced them: a test comparing a string with the function that made it
 * agrees with any edit to the copy, and these strings are printed in a terminal,
 * logged on boot and drawn in the app.
 *
 * @module report/__tests__/adoptable
 */
import { describe, expect, it } from 'vitest';
import { adoptCommandFor, adoptableSentence, harnessesThatCannotSee } from '../adoptable.js';

/** A repository that has turned every agent tool on, in manifest order. */
const ALL_SIX = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'opencode'] as const;

describe('SRC-07 — who cannot see a skill is computed from the vendor facts', () => {
  it('SRC-07: names Codex and Gemini for a .claude/skills skill, and nobody else', () => {
    // Seeded defect: hard-code the pair. An OpenCode-first repository is then
    // told Codex and Gemini cannot see a skill Codex reads perfectly well.
    expect(harnessesThatCannotSee('.claude/skills', ALL_SIX)).toEqual(['codex', 'gemini']);
    expect(harnessesThatCannotSee('.opencode/skills', ALL_SIX)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'copilot',
    ]);
  });

  it('SRC-07: says nothing at all when every enabled tool can already see it', () => {
    // A count of zero problems is noise, and this block is not a drift report.
    expect(
      adoptableSentence({ root: '.claude/skills', names: ['deploy-checklist'], cannotSee: [] })
    ).toBe('');
    expect(adoptableSentence({ root: '.claude/skills', names: [], cannotSee: ['codex'] })).toBe('');
  });
});

describe('SRC-07 — the headline, at every n', () => {
  it('SRC-07: at n=1 names the skill in its own command and stands alone', () => {
    expect(
      adoptableSentence({
        root: '.claude/skills',
        names: ['deploy-checklist'],
        cannotSee: ['codex', 'gemini'],
      })
    ).toBe(
      '1 skill lives only in .claude/skills and Codex and Gemini CLI cannot see it — ' +
        'dorkos harness adopt deploy-checklist moves it'
    );
    // "Gemini CLI" rather than "Gemini": the label is the one the whole product
    // already prints for that tool, and the sentence names tools the way the
    // chips and the drop list do.
  });

  it('SRC-07: at n=2 and n=3 counts the skills and names no single one', () => {
    // A headline cannot name three skills in one command, so the command carries
    // `<name>` and the caller prints one line per skill beneath it.
    expect(
      adoptableSentence({
        root: '.claude/skills',
        names: ['a', 'b'],
        cannotSee: ['codex', 'gemini'],
      })
    ).toBe(
      '2 skills live only in .claude/skills and Codex and Gemini CLI cannot see them — ' +
        'dorkos harness adopt <name> moves one'
    );
    expect(
      adoptableSentence({
        root: '.claude/skills',
        names: ['a', 'b', 'c'],
        cannotSee: ['codex', 'gemini'],
      })
    ).toBe(
      '3 skills live only in .claude/skills and Codex and Gemini CLI cannot see them — ' +
        'dorkos harness adopt <name> moves one'
    );
  });

  it('SRC-07: reads out one, two and three tools the way a person would', () => {
    const of = (cannotSee: Parameters<typeof adoptableSentence>[0]['cannotSee']): string =>
      adoptableSentence({ root: '.claude/skills', names: ['x'], cannotSee });
    expect(of(['codex'])).toContain('and Codex cannot see it');
    expect(of(['codex', 'gemini'])).toContain('and Codex and Gemini CLI cannot see it');
    expect(of(['codex', 'gemini', 'copilot'])).toContain(
      'and Codex, Gemini CLI and Copilot cannot see it'
    );
  });
});

describe('SRC-07 — the absolute form every server surface prints', () => {
  it('SRC-07: carries --project when the reader is not standing in the repository', () => {
    // A bare command means whatever folder the reader happens to be in, which is
    // the defect DOR-1921 measured. The optional path is the one switch between
    // the two forms.
    expect(
      adoptableSentence({
        root: '.claude/skills',
        names: ['deploy-checklist'],
        cannotSee: ['codex', 'gemini'],
        projectPath: '/Users/x/proj',
      })
    ).toBe(
      '1 skill lives only in .claude/skills and Codex and Gemini CLI cannot see it — ' +
        'dorkos harness adopt deploy-checklist --project /Users/x/proj moves it'
    );
    expect(
      adoptableSentence({
        root: '.claude/skills',
        names: ['a', 'b'],
        cannotSee: ['codex'],
        projectPath: '/Users/x/proj',
      })
    ).toBe(
      '2 skills live only in .claude/skills and Codex cannot see them — ' +
        'dorkos harness adopt <name> --project /Users/x/proj moves one'
    );
  });

  it('SRC-07: builds a named skill’s own line as the same command, substituted', () => {
    expect(adoptCommandFor('deploy-checklist')).toBe('dorkos harness adopt deploy-checklist');
    expect(adoptCommandFor('deploy-checklist', '/Users/x/proj')).toBe(
      'dorkos harness adopt deploy-checklist --project /Users/x/proj'
    );
  });
});
