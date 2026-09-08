/**
 * The rule ladder, one rule at a time, against SYNTHETIC facts.
 *
 * Every other test of this code drives it through the real table, which means
 * three things go untested. A cell no vendor uses today — `onInvalidName: 'skip'`
 * and `'warn-and-load'`, `dedupe: 'by-name'` — has no row to reach it, so
 * deleting its branch reds nothing. A rule that fires on two harnesses at once is
 * only ever observed jointly. And an OMISSION is invisible: the plan and the
 * coverage walk share this ladder, so a rule missing from it is missing from both
 * answers and they agree, wrongly, in perfect step (the `nameRequired` case
 * below is exactly that, found by reading Copilot's page rather than by any test).
 *
 * `evaluateSkillRules` takes `facts` as a parameter, so each case here builds the
 * one row it is about. That makes this file answer to the vendor pages rather
 * than to the rest of the engine — which is the only kind of test that can catch
 * the ladder being wrong rather than merely inconsistent.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSkillRules, summariseSkillRules } from '../skill-rules.js';
import type { SkillsFacts } from '../types.js';

/**
 * A facts row that decides nothing: every cell documented, no rule to break.
 * Each case overrides exactly the cell it is about, so a failure names one rule.
 */
function permissiveFacts(overrides: Partial<SkillsFacts> = {}): SkillsFacts {
  return {
    readPaths: { project: ['.claude/skills'], user: [] },
    walk: 'fixed',
    identity: 'dir',
    nameMustMatchDir: false,
    nameRequired: false,
    onInvalidName: 'unknown',
    dedupe: 'by-realpath',
    symlinks: 'followed',
    liveReload: 'test fixture',
    source: { url: 'https://example.invalid/docs', fetchedAt: '2026-09-08' },
    verified: 'docs',
    ...overrides,
  };
}

/** The input for a tidy skill, with whatever this case changes. */
function skill(overrides: Partial<Parameters<typeof evaluateSkillRules>[2]> = {}) {
  return { dirName: 'tidy', frontmatterName: 'tidy', reachedThroughSymlink: false, ...overrides };
}

describe('evaluateSkillRules — one rule at a time', () => {
  it('R0: says a tidy skill loads, keyed by its directory, with nothing undecided', () => {
    const outcome = evaluateSkillRules('cursor', permissiveFacts(), skill());
    expect(outcome).toEqual({
      key: 'tidy',
      reasons: [],
      undecided: [],
      droppedByRule: false,
      loads: true,
    });
    expect(summariseSkillRules(outcome)).toBe('');
  });

  it('R1 symlinks: undecidable only when the vendor documents nothing about links', () => {
    const followed = evaluateSkillRules(
      'cursor',
      permissiveFacts({ symlinks: 'followed' }),
      skill({ reachedThroughSymlink: true })
    );
    expect(followed.loads).toBe(true);

    const unknown = evaluateSkillRules(
      'cursor',
      permissiveFacts({ symlinks: 'unknown' }),
      skill({ reachedThroughSymlink: true })
    );
    expect(unknown.loads).toBe(false);
    expect(unknown.reasons).toEqual([
      'it is reached through a symlink, and Cursor does not document whether it follows one',
    ]);
  });

  it('R2 identity: keys by the frontmatter name, and refuses when there is none', () => {
    const keyed = evaluateSkillRules(
      'opencode',
      permissiveFacts({ identity: 'frontmatter' }),
      skill({ dirName: 'folder', frontmatterName: 'declared' })
    );
    expect({ key: keyed.key, loads: keyed.loads }).toEqual({ key: 'declared', loads: true });

    const nameless = evaluateSkillRules('opencode', permissiveFacts({ identity: 'frontmatter' }), {
      dirName: 'folder',
      reachedThroughSymlink: false,
    });
    expect({ key: nameless.key, loads: nameless.loads }).toEqual({ key: 'folder', loads: false });
    expect(nameless.reasons[0]).toContain('keys a skill by its frontmatter name');
  });

  it('R2b identity unknown: undecidable only when the two names differ', () => {
    const agreeing = evaluateSkillRules(
      'copilot',
      permissiveFacts({ identity: 'unknown' }),
      skill({ dirName: 'same', frontmatterName: 'same' })
    );
    expect(agreeing.loads).toBe(true);

    const differing = evaluateSkillRules(
      'copilot',
      permissiveFacts({ identity: 'unknown' }),
      skill({ dirName: 'folder', frontmatterName: 'declared' })
    );
    expect(differing.loads).toBe(false);
    expect(differing.reasons[0]).toContain('does not document whether a skill is keyed by');
  });

  it('R3 charset: a name that breaks a stated pattern is a violation, and no pattern is no rule', () => {
    const noRule = evaluateSkillRules(
      'gemini',
      permissiveFacts(),
      skill({ dirName: 'My_Skill', frontmatterName: 'My_Skill' })
    );
    expect(noRule.loads).toBe(true);

    const broken = evaluateSkillRules(
      'cursor',
      permissiveFacts({ nameRegex: /^[a-z0-9-]+$/ }),
      skill({ dirName: 'My_Skill', frontmatterName: 'My_Skill' })
    );
    expect(broken.loads).toBe(false);
    expect(broken.reasons[0]).toContain("breaks Cursor's documented charset rule");
  });

  it('R4 must-match-dir: `true` is a violation, `unknown` is a refusal, `false` is neither', () => {
    const mismatch = skill({ dirName: 'folder', frontmatterName: 'declared' });

    expect(
      evaluateSkillRules('cursor', permissiveFacts({ nameMustMatchDir: false }), mismatch).loads
    ).toBe(true);

    const required = evaluateSkillRules(
      'opencode',
      permissiveFacts({ nameMustMatchDir: true }),
      mismatch
    );
    expect(required.loads).toBe(false);
    expect(required.reasons[0]).toContain('which OpenCode documents as required');

    const unstated = evaluateSkillRules(
      'gemini',
      permissiveFacts({ nameMustMatchDir: 'unknown' }),
      mismatch
    );
    expect(unstated.loads).toBe(false);
    expect(unstated.reasons[0]).toContain('does not document whether it must');

    // `true` with no name at all is the other half of the same rule.
    const absent = evaluateSkillRules('opencode', permissiveFacts({ nameMustMatchDir: true }), {
      dirName: 'folder',
      reachedThroughSymlink: false,
    });
    expect(absent.reasons[0]).toContain('must match its directory, and this SKILL.md has no name');
  });

  it('R5 name-required: a missing name breaks a stated rule, and is not said twice', () => {
    // The rule that was missing entirely. Copilot's page says the key is
    // required; nothing else in the ladder noticed a skill without one, so it
    // "loaded" — in the plan AND in the walk, which is the omission P9c cannot
    // see.
    const nameless = { dirName: 'nameless', reachedThroughSymlink: false };

    expect(
      evaluateSkillRules('copilot', permissiveFacts({ nameRequired: false }), nameless).loads
    ).toBe(true);
    expect(
      evaluateSkillRules('copilot', permissiveFacts({ nameRequired: 'unknown' }), nameless).loads
    ).toBe(true);

    const required = evaluateSkillRules(
      'copilot',
      permissiveFacts({ nameRequired: true }),
      nameless
    );
    expect(required.loads).toBe(false);
    expect(required.reasons).toEqual([
      'Copilot documents that a SKILL.md must declare a name, and this one has none, and Copilot does not document what it does with such a skill',
    ]);

    // A harness that also requires the two names to match already reports an
    // absent name, so this rule stands down rather than saying it twice.
    const both = evaluateSkillRules(
      'opencode',
      permissiveFacts({ nameRequired: true, nameMustMatchDir: true }),
      nameless
    );
    expect(both.reasons).toHaveLength(1);
    expect(both.reasons[0]).toContain('must match its directory');
  });

  it('R6 on-invalid-name: `skip` is a documented refusal, not an undecidable one', () => {
    const facts = { nameRegex: /^[a-z0-9-]+$/ } as const;
    const bad = skill({ dirName: 'My_Skill', frontmatterName: 'My_Skill' });

    // The value no vendor row uses today, which is why nothing else reaches it:
    // deleting this branch used to red no test at all.
    const skipped = evaluateSkillRules(
      'cursor',
      permissiveFacts({ ...facts, onInvalidName: 'skip' }),
      bad
    );
    expect({
      loads: skipped.loads,
      droppedByRule: skipped.droppedByRule,
      undecided: skipped.undecided.length,
    }).toEqual({ loads: false, droppedByRule: true, undecided: 0 });
    expect(skipped.droppedReason).toContain('Cursor documents that it skips such a skill');

    // `warn-and-load` is the vendor saying it loads anyway: no refusal, no doubt.
    const warned = evaluateSkillRules(
      'cursor',
      permissiveFacts({ ...facts, onInvalidName: 'warn-and-load' }),
      bad
    );
    expect({ loads: warned.loads, droppedByRule: warned.droppedByRule }).toEqual({
      loads: true,
      droppedByRule: false,
    });

    // `unknown` is the refusal to decide, and the only one with a row today.
    const unknown = evaluateSkillRules(
      'cursor',
      permissiveFacts({ ...facts, onInvalidName: 'unknown' }),
      bad
    );
    expect({ loads: unknown.loads, droppedByRule: unknown.droppedByRule }).toEqual({
      loads: false,
      droppedByRule: false,
    });
  });

  it('says a shared vendor silence once, however many rules hit it', () => {
    // Two violations, one silence. Joining the raw `reasons` printed "and Cursor
    // does not document what it does with such a skill" twice in one line.
    const outcome = evaluateSkillRules(
      'cursor',
      permissiveFacts({ nameRegex: /^[a-z0-9-]+$/, nameMustMatchDir: true }),
      skill({ dirName: 'My_Skill', frontmatterName: 'totally-different' })
    );
    expect(outcome.reasons).toHaveLength(2);

    const summary = summariseSkillRules(outcome);
    expect(summary.match(/does not document what it does with such a skill/g)).toHaveLength(1);
    expect(summary).toContain("breaks Cursor's documented charset rule");
    expect(summary).toContain('does not match the directory "My_Skill"');
  });

  it('falls back to the full reasons when the silences differ', () => {
    // A symlink question and a name question are two different silences, so
    // collapsing them into one trailing clause would attribute both to one.
    const outcome = evaluateSkillRules(
      'cursor',
      permissiveFacts({ symlinks: 'unknown', nameRegex: /^[a-z0-9-]+$/ }),
      skill({ dirName: 'My_Skill', frontmatterName: 'My_Skill', reachedThroughSymlink: true })
    );
    expect(summariseSkillRules(outcome)).toBe(outcome.reasons.join('; '));
  });
});
