/**
 * `clampModeToCeiling` against every real runtime's declared modes (spec
 * `trusted-by-default-flip` §4): a turn held to a ceiling runs at the stricter
 * of its own mode and the ceiling, compared by what each mode DECLARES, so one
 * runtime's level bounds a turn on another.
 */
import { describe, it, expect } from 'vitest';
import {
  clampModeToCeiling,
  levelOfMode,
  resolveCeilingLevel,
  stricterLevel,
  READ_ONLY_LEVEL,
} from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';

const CLAUDE = CLAUDE_CODE_CAPABILITIES.permissionModes;
const CODEX = CODEX_CAPABILITIES.permissionModes;
const OPENCODE = OPENCODE_CAPABILITIES.permissionModes;

describe('a stranger’s ceiling (runtime default)', () => {
  it.each([
    ['claude-code', CLAUDE, 'bypassPermissions', 'default'],
    ['claude-code', CLAUDE, 'acceptEdits', 'default'],
    ['claude-code', CLAUDE, 'auto', 'default'],
    ['opencode', OPENCODE, 'bypassPermissions', 'default'],
    ['codex', CODEX, 'bypassPermissions', 'default'],
    ['codex', CODEX, 'acceptEdits', 'default'],
  ] as const)('%s at %s runs the turn at %s', (_name, declared, mode, expected) => {
    expect(clampModeToCeiling(declared, mode, 'runtime-default')).toBe(expected);
  });

  it('keeps a session already at its default, or below it, where it is', () => {
    expect(clampModeToCeiling(CLAUDE, 'default', 'runtime-default')).toBe('default');
    expect(clampModeToCeiling(CLAUDE, 'plan', 'runtime-default')).toBe('plan');
  });

  it('never keeps a mode the runtime does not declare', () => {
    expect(clampModeToCeiling(CLAUDE, 'made-up', 'runtime-default')).toBe('default');
  });
});

describe('another agent’s level as the ceiling', () => {
  const acceptEdits = levelOfMode(CLAUDE, 'acceptEdits')!;
  const full = levelOfMode(CLAUDE, 'bypassPermissions')!;

  it('runs a Full autonomy conversation at the poster’s Accept edits, not below it', () => {
    expect(clampModeToCeiling(CLAUDE, 'bypassPermissions', acceptEdits)).toBe('acceptEdits');
  });

  it('never grants Auto under a ceiling that is not Auto and asks', () => {
    expect(clampModeToCeiling(CLAUDE, 'auto', acceptEdits)).toBe('acceptEdits');
    expect(clampModeToCeiling(CLAUDE, 'auto', levelOfMode(CLAUDE, 'auto')!)).toBe('auto');
  });

  it('leaves the conversation alone when the poster is at least as trusted', () => {
    expect(clampModeToCeiling(CLAUDE, 'bypassPermissions', full)).toBe('bypassPermissions');
    expect(clampModeToCeiling(CLAUDE, 'acceptEdits', full)).toBe('acceptEdits');
  });

  it('never falls back to a mode looser than a ceiling below every trust stop', () => {
    // A sender in Plan reads only; Default edits, so it is not admitted.
    const plan = levelOfMode(CLAUDE, 'plan')!;
    expect(clampModeToCeiling(CLAUDE, 'bypassPermissions', plan)).toBe('plan');
    // OpenCode declares nothing that only reads: its strictest mode stands.
    expect(clampModeToCeiling(OPENCODE, 'bypassPermissions', plan)).toBe('default');
  });

  it('holds across runtimes by declared level, not by id', () => {
    // Claude's Accept edits reaches only the workspace's files with a check;
    // Codex's Accept edits writes the workspace without asking, so it is above.
    expect(clampModeToCeiling(CODEX, 'acceptEdits', acceptEdits)).toBe('default');
    expect(clampModeToCeiling(CODEX, 'bypassPermissions', full)).toBe('bypassPermissions');
  });
});

describe('the level helpers', () => {
  it('resolves the runtime-default ceiling to the runtime’s own default level', () => {
    expect(resolveCeilingLevel(CODEX, 'runtime-default')).toEqual({ asks: 'never', reach: 'read' });
    expect(resolveCeilingLevel({ values: [] }, 'runtime-default')).toEqual(READ_ONLY_LEVEL);
  });

  it('picks the stricter of two levels, reach first when neither bounds the other', () => {
    const full = levelOfMode(CLAUDE, 'bypassPermissions')!;
    const def = levelOfMode(CLAUDE, 'default')!;
    expect(stricterLevel(full, def)).toEqual(def);
    expect(stricterLevel(def, full)).toEqual(def);
    const codexWrite = levelOfMode(CODEX, 'acceptEdits')!; // never asks, workspace
    expect(stricterLevel(codexWrite, def)).toEqual(def);
  });

  it('combines two levels neither of which bounds the other', () => {
    // "Asks less but reaches less" against "asks more but reaches further":
    // neither bounds the other, so the stricter asks more AND reaches less.
    const asksLessReachesLess = { asks: 'when-risky', reach: 'edit' } as const;
    const asksMoreReachesFurther = { asks: 'always', reach: 'workspace' } as const;
    expect(stricterLevel(asksLessReachesLess, asksMoreReachesFurther)).toEqual({
      asks: 'always',
      reach: 'edit',
    });
    expect(stricterLevel(asksMoreReachesFurther, asksLessReachesLess)).toEqual({
      asks: 'always',
      reach: 'edit',
    });
  });

  it('reads a level that only reads as no looser than any, so Codex’s default holds Claude to Plan', () => {
    // `isNoLooserThan` judges a read-only level on reach alone (it never asks
    // because it has nothing to ask about), so this pair is ordered.
    const codexDefault = levelOfMode(CODEX, 'default')!;
    const claudeDefault = levelOfMode(CLAUDE, 'default')!;
    expect(stricterLevel(codexDefault, claudeDefault)).toEqual(codexDefault);
    expect(clampModeToCeiling(CLAUDE, 'bypassPermissions', codexDefault)).toBe('plan');
  });

  it('resolves a list ceiling to the strictest of its bounds', () => {
    const full = levelOfMode(CLAUDE, 'bypassPermissions')!;
    expect(resolveCeilingLevel(CLAUDE, [full, 'runtime-default'])).toEqual(
      levelOfMode(CLAUDE, 'default')
    );
    expect(clampModeToCeiling(CLAUDE, 'bypassPermissions', [full, 'runtime-default'])).toBe(
      'default'
    );
  });

  it('marks Auto, the one mode its declaration understates', () => {
    expect(levelOfMode(CLAUDE, 'auto')).toMatchObject({ auto: true });
    expect(levelOfMode(CLAUDE, 'acceptEdits')).not.toHaveProperty('auto');
  });
});
