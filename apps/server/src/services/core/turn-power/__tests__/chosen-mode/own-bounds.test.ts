import { describe, expect, it } from 'vitest';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { levelOfMode, type DeclaredModes } from '@dorkos/shared/permission-semantics';
import { chosenModeWithinOwnBounds, isFullLevel } from '../../full-autonomy.js';

const modes = {
  default: 'ask',
  values: [
    {
      id: 'ask',
      label: 'Ask',
      stop: 'ask',
      asks: 'always',
      reach: 'edit',
      promise: 'Ask before edits.',
    },
    {
      id: 'read',
      label: 'Read',
      stop: 'ask',
      asks: 'always',
      reach: 'read',
      promise: 'Read files only.',
    },
    {
      id: 'auto',
      label: 'Auto',
      stop: 'act',
      asks: 'when-risky',
      reach: 'edit',
      promise: 'Weigh risky actions.',
    },
    {
      id: 'limitless',
      label: 'Full',
      stop: 'autonomy',
      asks: 'never',
      reach: 'everything',
      promise: 'Act without asking.',
    },
  ],
} satisfies DeclaredModes;
const read = { asks: 'always', reach: 'read' } as const;
const ask = { asks: 'always', reach: 'edit' } as const;
const full = (mode: string | undefined) => isFullLevel(levelOfMode(modes, mode));

describe('active choice within own bounds', () => {
  it.each([undefined, '', 'undeclared'])('keeps unknown choice %s unchanged', (choice) => {
    expect(chosenModeWithinOwnBounds(modes, choice, read, ask)).toBe(choice);
  });

  it('keeps the selected Auto identity instead of substituting an execution fallback', () => {
    expect(chosenModeWithinOwnBounds(modes, 'auto')).toBe('auto');
    expect(chosenModeWithinOwnBounds(modes, 'auto', { ...read, outsider: true })).toBe('auto');
  });

  it.each([
    ['outsider', { ...read, outsider: true }],
    ['teammate', { ...read, teammate: [] }],
    ['stranger hold', 'runtime-default'],
    ['empty hold', []],
    ['absent hold', undefined],
  ] satisfies readonly (readonly [string, TurnPermissionCeiling | undefined])[])(
    'keeps Full under %s without a mode-id table',
    (_label, ceiling) => {
      const chosen = chosenModeWithinOwnBounds(modes, 'limitless', ceiling);
      expect(chosen).toBe('limitless');
      expect(full(chosen)).toBe(true);
    }
  );

  it.each([
    ['Read', read],
    ['Ask', ask],
  ] as const)('keeps a person %s bound', (_label, ceiling) => {
    const chosen = chosenModeWithinOwnBounds(modes, 'limitless', ceiling);
    expect(chosen).toBe(ceiling === read ? 'read' : 'ask');
    expect(full(chosen)).toBe(false);
  });

  it('applies both current and background own bounds without changing their inputs', () => {
    const marked = Object.freeze({ ...read, outsider: true } as const);
    const current = Object.freeze([marked, ask]);
    const background = Object.freeze([read]);
    expect(chosenModeWithinOwnBounds(modes, 'limitless', current, background)).toBe('read');
    expect(chosenModeWithinOwnBounds(modes, 'limitless', background, current)).toBe('read');
    expect(current).toEqual([marked, ask]);
    expect(background).toEqual([read]);
  });
});
