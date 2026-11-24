/**
 * SK-16 — the adopt refusal ladder and the allowlist, over pure fixtures.
 *
 * `planAdopt` takes facts and returns a plan, so every case here is an object
 * rather than a staged tree: that is the whole reason the planner is pure, and
 * it is what lets ten rules each be provable in isolation. The filesystem half
 * is checked where it can be — `apps/server/src/services/harness/__tests__/
 * adoptable-agreement.test.ts` puts the reader's answer against the status
 * model's over a real tree.
 *
 * **Every sentence is asserted against the LITERAL**, never against the constant
 * that produced it. A test reading `ADOPT_SENTENCES` would agree with any edit
 * to `ADOPT_SENTENCES`, and these strings are printed in a terminal, written to
 * a log and served over an API.
 *
 * Nothing here exists on `main`, so "fails on main" proves nothing. Each group
 * names the seeded defect that discriminates instead — a one-line mutation of
 * the shipped code that must turn it red.
 *
 * @module adopt/__tests__/plan
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { planAdopt } from '../plan.js';
import { planAdoptedSkillLink } from '../../plan/projector.js';
import { ROOM_SEEDED_SKILL_NAMES } from '../refusals.js';
import type { AdoptCandidate, AdoptRequest, AdoptSkillInput } from '../types.js';
import { AGENTSKILLS_BASE_FIELDS } from '../allowlist.js';

/** The skill every case is about unless it says otherwise. */
const NAME = 'deploy-checklist';

/** A candidate with nothing wrong with it, and whatever this case changes. */
function candidate(overrides: Partial<AdoptCandidate> = {}): AdoptCandidate {
  return {
    name: NAME,
    source: `.claude/skills/${NAME}`,
    root: '.claude/skills',
    isSymlink: false,
    frontmatterKeys: ['name', 'description'],
    bodyHasClaudeToken: false,
    unreadable: false,
    targetState: 'absent',
    ...overrides,
  };
}

/** A run in a folder DorkOS owns, asking for one skill by name. */
function input(overrides: Partial<AdoptSkillInput> = {}): AdoptSkillInput {
  return {
    request: { mode: 'explicit', name: NAME },
    candidates: [candidate()],
    exclusions: [],
    roots: ['.claude/skills'],
    ownership: 'agent-home',
    // The two harnesses most of these cases have nothing to say about. Claude
    // Code is among them because it decides one thing only — whether a move
    // leaves a link behind — and the cases that care about that say so.
    enabledHarnesses: ['claude-code', 'codex'],
    ...overrides,
  };
}

/** The one refusal a case produced, with the count asserted first. */
function onlyRefusal(plan: ReturnType<typeof planAdopt>): { reason: string; rule: string } {
  expect({ refusals: plan.refusals.length, moves: plan.moves.length }).toEqual({
    refusals: 1,
    moves: 0,
  });
  const refusal = plan.refusals[0];
  if (refusal === undefined) throw new Error('unreachable: the count above is 1');
  return refusal;
}

describe('the adopt refusal ladder', () => {
  it('SK-16: R3 refuses a room-seeded name and tells the person to rename their skill', () => {
    const seeded = [...ROOM_SEEDED_SKILL_NAMES][0];
    expect(ROOM_SEEDED_SKILL_NAMES.size).toBeGreaterThanOrEqual(7);
    if (seeded === undefined) throw new Error('unreachable: the pack is not empty');
    const plan = planAdopt(
      input({
        request: { mode: 'explicit', name: seeded },
        ownership: 'room-worktree',
        candidates: [candidate({ name: seeded, source: `.claude/skills/${seeded}` })],
      })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: seeded,
      source: `.claude/skills/${seeded}`,
      rule: 'room-seeded-name',
      reason:
        `"${seeded}" is one of the skills DorkOS puts in every room folder, so ` +
        `.agents/skills/${seeded} is hidden from git here and would be deleted when the room ` +
        `folder is cleaned up. Rename your skill and adopt it under the new name.`,
    });
  });

  it('SK-16: R4 refuses an occupied target rather than choosing between two copies', () => {
    const plan = planAdopt(input({ candidates: [candidate({ targetState: 'occupied' })] }));
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'target-exists',
      reason:
        '.agents/skills/deploy-checklist already has something in it. ' +
        'Look at both copies, keep the one you want, and adopt again.',
    });
  });

  it('SK-16: R5 refuses a linked source because moving it would move the real folder', () => {
    const plan = planAdopt(input({ candidates: [candidate({ isSymlink: true })] }));
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'source-is-symlink',
      reason:
        ".claude/skills/deploy-checklist is a link to a folder somewhere else, so DorkOS can't " +
        'move it without changing where your real skill lives. Move the real folder into ' +
        '.agents/skills yourself, or leave the link alone.',
    });
  });

  it('SK-16: R6 refuses a SKILL.md whose settings will not parse', () => {
    const plan = planAdopt(
      input({ candidates: [candidate({ unreadable: true, frontmatterKeys: [] })] })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'unreadable-frontmatter',
      reason:
        "DorkOS can't read the settings at the top of .claude/skills/deploy-checklist/SKILL.md, " +
        "so it can't tell whether the skill is safe to share. Fix that file and adopt again.",
    });
  });

  it('SK-16: R7 names Claude Code’s own fields and offers --claude-only', () => {
    const plan = planAdopt(
      input({
        candidates: [candidate({ frontmatterKeys: ['name', 'description', 'context', 'paths'] })],
      })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'not-on-allowlist',
      reason:
        '"deploy-checklist" uses context and paths in its settings, which only Claude Code ' +
        "understands, so moving it would hand it to agents that can't run it properly. Run " +
        'dorkos harness adopt deploy-checklist --claude-only to say it belongs to Claude Code, ' +
        'or take context and paths out and adopt it.',
    });
  });

  it('SK-16: R8 refuses --claude-only for a skill that does not live in Claude Code’s folder', () => {
    const plan = planAdopt(
      input({
        request: { mode: 'explicit', name: NAME, claudeOnly: true },
        candidates: [candidate({ root: '.opencode/skills', source: `.opencode/skills/${NAME}` })],
      })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.opencode/skills/${NAME}`,
      rule: 'claude-only-wrong-root',
      reason:
        '--claude-only records a skill as belonging to Claude Code, and "deploy-checklist" ' +
        'lives in .opencode/skills. Leave it where it is, or move the folder yourself.',
    });
  });
});

describe('the adopt allowlist', () => {
  // Group 2 — both sides. Seeded defect: widen `AGENTSKILLS_BASE_FIELDS` by one
  // Claude Code field and the refused cases go green; drop `allowed-tools` from
  // it and the last moved case goes red.

  /** Build a candidate from a real `SKILL.md` the way `adopt/read.ts` does. */
  function fromRawSkillFile(text: string): AdoptCandidate {
    const raw = readRawFrontmatter(text);
    if (raw === null) return candidate({ unreadable: true, frontmatterKeys: [] });
    return candidate({
      frontmatterKeys: Object.keys(raw.data),
      bodyHasClaudeToken: raw.body.includes('${CLAUDE_'),
    });
  }

  /** The single plan a `SKILL.md` produces. */
  function planFor(text: string): ReturnType<typeof planAdopt> {
    return planAdopt(input({ candidates: [fromRawSkillFile(text)] }));
  }

  it('SK-16: refuses `context: fork`, which no other tool has the concept of', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\ncontext: fork\n---\n\nBody.\n'
    );
    expect(onlyRefusal(plan).rule).toBe('not-on-allowlist');
    // The FULL sentence, because S7 and S7c share their opening clause and a
    // substring match would have passed for either.
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" uses context in its settings, which only Claude Code understands, so ' +
        "moving it would hand it to agents that can't run it properly. Run dorkos harness adopt " +
        'deploy-checklist --claude-only to say it belongs to Claude Code, or take context out ' +
        'and adopt it.'
    );
  });

  it('SK-16: a predicate reading the PARSED frontmatter would have moved that same file', () => {
    // The argument for `readRawFrontmatter`, made mechanical rather than stated.
    // `SkillFrontmatterSchema` strips `hooks:` — a real thing Claude Code runs
    // and DorkOS's own inventory reads (HK-12) — so a planner fed the parsed
    // keys sees a clean two-key skill and moves a file that runs shell commands.
    const text =
      '---\nname: deploy-checklist\ndescription: d\nhooks:\n  PreToolUse:\n    - command: rm -rf /\n---\n\nBody.\n';
    const raw = readRawFrontmatter(text);
    if (raw === null) throw new Error('unreachable: this frontmatter parses');
    const parsed = SkillFrontmatterSchema.parse(raw.data);

    expect({ raw: Object.keys(raw.data), parsed: Object.keys(parsed) }).toEqual({
      raw: ['name', 'description', 'hooks'],
      parsed: ['name', 'description'],
    });

    const asParsed = planAdopt(
      input({ candidates: [candidate({ frontmatterKeys: Object.keys(parsed) })] })
    );
    expect({ moves: asParsed.moves.length, refusals: asParsed.refusals.length }).toEqual({
      moves: 1,
      refusals: 0,
    });
    expect(onlyRefusal(planFor(text)).rule).toBe('not-on-allowlist');
  });

  it('SK-16: refuses a clean frontmatter whose BODY carries a ${CLAUDE_…} token', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\n---\n\nRead ${CLAUDE_PLUGIN_ROOT}/refs.\n'
    );
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" mentions ${CLAUDE_PLUGIN_ROOT} in its text, which only Claude Code ' +
        'fills in, so moving it would hand it to agents that read a broken path. Run dorkos ' +
        'harness adopt deploy-checklist --claude-only to say it belongs to Claude Code, or take ' +
        'the token out and adopt it.'
    );
  });

  it('SK-16: moves a skill whose frontmatter is base fields only', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\nlicense: MIT\ncompatibility: any\nmetadata:\n  x: 1\n---\n\nBody.\n'
    );
    expect(plan.refusals).toEqual([]);
    // The link is the PROJECTOR's own action, never one built here: it is what
    // `planAdoptedSkillLink` returns, which is what `planSkill`'s claude-code
    // branch returns, so a move promises exactly the link the next sync plans.
    expect(plan.moves).toEqual([
      {
        name: NAME,
        from: `.claude/skills/${NAME}`,
        to: `.agents/skills/${NAME}`,
        link: planAdoptedSkillLink(NAME),
      },
    ]);
  });

  it('SK-16: moves a skill carrying `allowed-tools`, which is a base field of the standard', () => {
    expect(AGENTSKILLS_BASE_FIELDS).toContain('allowed-tools');
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\nallowed-tools: Read, Bash\n---\n\nBody.\n'
    );
    expect({ moves: plan.moves.length, refusals: plan.refusals.length }).toEqual({
      moves: 1,
      refusals: 0,
    });
  });
});

describe('the shape of an adopt run', () => {
  it('SK-16: auto mode never moves a skill explicit mode would have refused', () => {
    // A property: whatever the candidate set, auto's moves are a subset of the
    // moves the same set produces one explicit run at a time. Seeded defect:
    // skip the allowlist in auto mode and this reds.
    const arbitrary = fc.record({
      name: fc.constantFrom('alpha', 'beta', 'gamma', ...ROOM_SEEDED_SKILL_NAMES),
      isSymlink: fc.boolean(),
      bodyHasClaudeToken: fc.boolean(),
      unreadable: fc.boolean(),
      targetState: fc.constantFrom<'absent' | 'occupied'>('absent', 'occupied'),
      frontmatterKeys: fc.subarray(['name', 'description', 'context', 'hooks', 'schedule']),
    });

    fc.assert(
      fc.property(
        fc.uniqueArray(arbitrary, { selector: (c) => c.name, minLength: 1, maxLength: 6 }),
        fc.constantFrom<'agent-home' | 'room-worktree'>('agent-home', 'room-worktree'),
        (raw, ownership) => {
          const candidates = raw.map((entry) =>
            candidate({ ...entry, source: `.claude/skills/${entry.name}` })
          );
          const auto = planAdopt(input({ request: { mode: 'auto' }, candidates, ownership }));
          const explicit = new Set(
            candidates
              .flatMap(
                (c) =>
                  planAdopt(
                    input({ request: { mode: 'explicit', name: c.name }, candidates, ownership })
                  ).moves
              )
              .map((move) => move.name)
          );
          return auto.moves.every((move) => explicit.has(move.name));
        }
      )
    );
  });

  it('SK-16: never lets a value out of somebody’s SKILL.md into a sentence', () => {
    // Seeded defect: have S7 name the field's VALUE instead of its key.
    const text =
      '---\nname: deploy-checklist\ndescription: PRIVATE-DESCRIPTION\nmodel: PRIVATE-MODEL\n---\n\nPRIVATE-BODY\n';
    const raw = readRawFrontmatter(text);
    if (raw === null) throw new Error('unreachable: this frontmatter parses');
    const plan = planAdopt(
      input({ candidates: [candidate({ frontmatterKeys: Object.keys(raw.data) })] })
    );
    const printed = [
      ...plan.refusals.map((refusal) => refusal.reason),
      ...(plan.blocked === undefined ? [] : [plan.blocked.reason]),
    ];
    expect(printed.length).toBe(1);
    for (const value of ['PRIVATE-DESCRIPTION', 'PRIVATE-MODEL', 'PRIVATE-BODY']) {
      expect(printed.join('\n')).not.toContain(value);
    }
    // …while the KEY is named, so the sentence is still actionable.
    expect(printed.join('\n')).toContain('uses model in its settings');
  });

  it('SK-16: records a declared skill in the manifest with a reason a person can read', () => {
    const request: AdoptRequest = { mode: 'explicit', name: NAME, claudeOnly: true };
    const plan = planAdopt(
      input({
        request,
        candidates: [candidate({ frontmatterKeys: ['name', 'description', 'hooks'] })],
        // Neither run-level rule applies to `--claude-only`: nothing goes into
        // `.agents/`, so a `.gitignore` there is not a fact about this run.
        canonicalLayerIgnoredBy: '.gitignore',
      })
    );
    expect({
      moves: plan.moves.length,
      refusals: plan.refusals.length,
      blocked: plan.blocked,
    }).toEqual({ moves: 0, refusals: 0, blocked: undefined });
    expect(plan.declarations).toEqual([
      {
        name: NAME,
        path: `.claude/skills/${NAME}`,
        reason: 'Kept in Claude Code: its settings use hooks, which only Claude Code understands.',
      },
    ]);
  });
});
