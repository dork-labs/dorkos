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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { planAdopt } from '../plan.js';
import { AGENTSKILLS_BASE_FIELDS } from '../allowlist.js';
import { ROOM_SEEDED_SKILL_NAMES } from '../refusals.js';
import type { AdoptCandidate, AdoptRequest, AdoptSkillInput } from '../types.js';

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
  // Group 1 — one case per frozen SENTENCE: fourteen over ten rules. Three rules
  // have more than one sentence (R1 by what is wrong with the name, R7 by what
  // is wrong with the file), which is why the counts differ.
  //
  // Seeded defect, per rule: delete that rule's branch in `plan.ts` and its case
  // or cases go red.

  it('SK-16: B1 tells a person the flag did nothing here, and does not send them to a .gitignore', () => {
    const plan = planAdopt(input({ request: { mode: 'auto' }, ownership: 'plain' }));
    expect({ moves: plan.moves.length, refusals: plan.refusals.length }).toEqual({
      moves: 0,
      refusals: 0,
    });
    expect(plan.blocked).toEqual({
      rule: 'auto-adopt-not-permitted',
      reason:
        'harness.autoAdopt is on, and it does nothing here: DorkOS only moves skills on its own ' +
        'inside the agent folders and room folders it owns. Run dorkos harness adopt <name> to ' +
        'move one yourself.',
    });
  });

  it('SK-16: B2 names the .gitignore that would take the skill out of git for everybody', () => {
    const plan = planAdopt(input({ canonicalLayerIgnoredBy: '.gitignore' }));
    expect(plan.blocked).toEqual({
      rule: 'canonical-layer-ignored',
      reason:
        "DorkOS can't move a skill into .agents/skills here: .gitignore tells git to ignore " +
        '.agents/, so moving it would take the skill out of git for everybody who clones this ' +
        'project. Stop ignoring .agents/ in .gitignore, or leave the skill where it is.',
    });
  });

  it('SK-16: R1 says where it looked when there is no skill by that name', () => {
    const plan = planAdopt(
      input({
        request: { mode: 'explicit', name: 'nope' },
        roots: ['.claude/skills', '.opencode/skills'],
      })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: 'nope',
      source: '',
      rule: 'not-adoptable',
      reason:
        'There is no skill called "nope" in .claude/skills and .opencode/skills. ' +
        'Run dorkos harness sync --check to see what is here.',
    });
  });

  it('SK-16: R1 calls a skill that is already canonical a second copy, and names it', () => {
    const plan = planAdopt(
      input({
        candidates: [],
        exclusions: [
          {
            name: NAME,
            source: `.claude/skills/${NAME}`,
            root: '.claude/skills',
            why: 'also-canonical',
          },
        ],
      })
    );
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'not-adoptable',
      reason:
        '"deploy-checklist" is already in .agents/skills, where every agent reads it. ' +
        'The copy in .claude/skills/deploy-checklist is a second one that gets in the way — ' +
        'delete one of them.',
    });
  });

  it('SK-16: R1 points a declared skill back at the list that declared it', () => {
    const plan = planAdopt(
      input({
        candidates: [],
        exclusions: [
          { name: NAME, source: `.claude/skills/${NAME}`, root: '.claude/skills', why: 'declared' },
        ],
      })
    );
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" is listed in manifest.claudeOnlySkills, which says the ' +
        'Claude-Code-only spot is on purpose. Take it out of that list first if you want to ' +
        'share it.'
    );
  });

  it('SK-16: R2 reuses the occupant sentence verbatim, so a sync and an adopt agree', () => {
    // The reason arrives from `apply/write-path-occupants.ts` already worded; the
    // rule under test is that adopt prints it rather than paraphrasing it.
    const occupant =
      'blocked by `.agents/skills`, which is a file — DorkOS needs a folder there to write ' +
      'this. Move the file aside, then re-run';
    const plan = planAdopt(input({ candidates: [candidate({ pathBlockedReason: occupant })] }));
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'hostile-path',
      reason: occupant,
    });
  });

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

  it('SK-16: R7 names the body token when the text is what is Claude-shaped', () => {
    const plan = planAdopt(input({ candidates: [candidate({ bodyHasClaudeToken: true })] }));
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" mentions ${CLAUDE_PLUGIN_ROOT} in its text, which only Claude Code ' +
        'fills in, so moving it would hand it to agents that read a broken path. Run dorkos ' +
        'harness adopt deploy-checklist --claude-only to say it belongs to Claude Code, or take ' +
        'the token out and adopt it.'
    );
  });

  it('SK-16: R7 claims nothing about a key DorkOS has never heard of', () => {
    const plan = planAdopt(
      input({ candidates: [candidate({ frontmatterKeys: ['name', 'descripton'] })] })
    );
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" uses descripton in its settings, which DorkOS doesn\'t recognise, so ' +
        "it can't tell whether your other agents can run it. Run dorkos harness adopt " +
        'deploy-checklist --claude-only to keep it where it is, or take descripton out and ' +
        'adopt it.'
    );
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

  it('SK-16: calls a `hooks:` block Claude Code’s, because DorkOS reads it too', () => {
    // `hooks` is not in `SkillFrontmatterSchema` at all, so a classification
    // keyed on the schema's shape called it a key DorkOS does not recognise —
    // while `inventory/hooks.ts` reads it (HK-12) and the same run's manifest
    // line said "only Claude Code understands". The full literal is what pins
    // which of the two sentences this is.
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\nhooks:\n  PreToolUse:\n    - command: rm -rf /\n---\n\nBody.\n'
    );
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" uses hooks in its settings, which only Claude Code understands, so ' +
        "moving it would hand it to agents that can't run it properly. Run dorkos harness adopt " +
        'deploy-checklist --claude-only to say it belongs to Claude Code, or take hooks out and ' +
        'adopt it.'
    );
  });

  it('SK-16: S7d says a `schedule:` is DorkOS’s own, and what moving it would start', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\nschedule:\n  cron: 0 9 * * *\n---\n\nBody.\n'
    );
    expect(onlyRefusal(plan)).toEqual({
      name: NAME,
      source: `.claude/skills/${NAME}`,
      rule: 'not-on-allowlist',
      reason:
        '"deploy-checklist" uses schedule in its settings, which are DorkOS\'s own and mean ' +
        'nothing to your other agents. Moving it also changes what DorkOS does with it: a skill ' +
        'with a schedule starts running on a timer once it is in .agents/skills. Take schedule ' +
        'out and adopt it, or run dorkos harness adopt deploy-checklist --claude-only to keep ' +
        'it where it is.',
    });
  });

  it('SK-16: S7d covers `kind` too, which is DorkOS’s marketplace discriminator', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\nkind: skill\n---\n\nBody.\n'
    );
    expect(onlyRefusal(plan).reason).toContain(
      '"deploy-checklist" uses kind in its settings, which are DorkOS\'s own'
    );
    expect(onlyRefusal(plan).reason).not.toContain('only Claude Code understands');
  });

  it('SK-16: a mixed list claims nothing about whose fields they are, and names them all', () => {
    const plan = planFor(
      '---\nname: deploy-checklist\ndescription: d\ncontext: fork\nschedule:\n  cron: 0 9 * * *\n---\n\nBody.\n'
    );
    expect(onlyRefusal(plan).reason).toBe(
      '"deploy-checklist" uses context and schedule in its settings, which DorkOS doesn\'t ' +
        "recognise, so it can't tell whether your other agents can run it. Run dorkos harness " +
        'adopt deploy-checklist --claude-only to keep it where it is, or take context and ' +
        'schedule out and adopt it.'
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
    expect(plan.moves).toEqual([
      { name: NAME, from: `.claude/skills/${NAME}`, to: `.agents/skills/${NAME}` },
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
  it('SK-16: gives the ladder’s answer, not the last one that applies', () => {
    // Simultaneously a symlink, at an occupied target, and off the allowlist.
    // Seeded defect: move R4 below R5 and this reads R5's sentence instead.
    const plan = planAdopt(
      input({
        candidates: [
          candidate({
            isSymlink: true,
            targetState: 'occupied',
            frontmatterKeys: ['name', 'description', 'schedule'],
          }),
        ],
      })
    );
    expect(onlyRefusal(plan).rule).toBe('target-exists');
  });

  it('SK-16: says the .gitignore fact ONCE rather than once per candidate', () => {
    // Seeded defect: turn B2 into a per-candidate refusal and the counts red.
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
      candidate({ name, source: `.claude/skills/${name}` })
    );
    expect(six.length).toBe(6);
    const plan = planAdopt(
      input({ request: { mode: 'auto' }, candidates: six, canonicalLayerIgnoredBy: '.gitignore' })
    );
    expect({
      moves: plan.moves.length,
      refusals: plan.refusals.length,
      blocked: plan.blocked?.rule,
    }).toEqual({ moves: 0, refusals: 0, blocked: 'canonical-layer-ignored' });
  });

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

  it('SK-16: a declared DorkOS field is recorded as DorkOS’s own, not as Claude Code’s', () => {
    const plan = planAdopt(
      input({
        request: { mode: 'explicit', name: NAME, claudeOnly: true },
        candidates: [candidate({ frontmatterKeys: ['name', 'description', 'schedule'] })],
      })
    );
    expect(plan.declarations).toEqual([
      {
        name: NAME,
        path: `.claude/skills/${NAME}`,
        reason: "Kept in Claude Code: its settings use schedule, which are DorkOS's own.",
      },
    ]);
  });

  it('SK-16: a declared key DorkOS cannot place claims nothing about who understands it', () => {
    // The manifest line is read a year later by somebody deciding whether the
    // entry is still true, so it says what DorkOS actually knew.
    const plan = planAdopt(
      input({
        request: { mode: 'explicit', name: NAME, claudeOnly: true },
        candidates: [candidate({ frontmatterKeys: ['name', 'description', 'descripton'] })],
      })
    );
    expect(plan.declarations[0]?.reason).toBe(
      "Kept in Claude Code on purpose: its settings use descripton, which DorkOS doesn't " +
        'recognise.'
    );
  });

  it('SK-16: falls back to every root it could have looked in rather than printing "in ."', () => {
    // A caller that hands the planner no roots at all — `joinNames([])` is the
    // empty string, and the sentence would have read "in .".
    const plan = planAdopt(
      input({ request: { mode: 'explicit', name: 'nope' }, candidates: [], roots: [] })
    );
    expect(onlyRefusal(plan).reason).toBe(
      'There is no skill called "nope" in .claude/skills, .codex/skills, .cursor/skills, ' +
        '.gemini/skills, .github/skills and .opencode/skills. Run dorkos harness sync --check ' +
        'to see what is here.'
    );
  });

  it('SK-16: the planner imports no filesystem, so every rule is provable from facts alone', () => {
    // The acceptance bar stated as a check rather than as a comment: a planner
    // that read a disk would need a staged tree per rule, which is the shape
    // `buildPlan` has and the reason adopt deliberately does not.
    //
    // The guard is TEXTUAL and ONE HOP: it reads these four files' own import
    // statements and follows nothing. A module they import could pull `node:fs`
    // in behind them — `refusals.ts` does, through `@dorkos/operating-skills`,
    // whose barrel also exports a seeder. What it pins is the thing that
    // matters here: no code in this unit opens a path, so no rule needs a tree.
    const here = join(import.meta.dirname, '..');
    const modules = ['plan.ts', 'allowlist.ts', 'refusals.ts', 'types.ts'];
    const offenders = modules.filter((file) =>
      /from '(?:node:)?(?:fs|fs\/promises)'/.test(readFileSync(join(here, file), 'utf8'))
    );
    expect({ checked: modules.length, offenders }).toEqual({ checked: 4, offenders: [] });
  });
});
