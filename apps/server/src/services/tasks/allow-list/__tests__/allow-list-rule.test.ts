/**
 * DOR-4315, Security's ruling (adding is widening): when an agent may change
 * its own task's allow list with no card. Made-up paths.
 */
import { describe, expect, it } from 'vitest';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import {
  decideAllowList,
  addingEntriesAsksAPerson,
  narrowingOf,
  runsAnyCommandUnasked,
} from '../allow-list-rule.js';

const CHECK = 'Bash(/usr/bin/shasum -a 256 -c /home/sample/reviews/sample-backfill.sha256)';
const RUN = 'Bash(/home/sample/agents/media/bin/derive-sample --backfill)';
const VERIFY = 'Bash(/home/sample/agents/media/bin/derive-sample --check)';

const FULL: TurnPermissionLevel = { asks: 'never', reach: 'everything' };
const EDITS: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };
const OWN = { ownChatOwnTask: true, marked: false, scheduledRun: false };

/** A decision with sensible defaults: a Full agent's first list on its own new one-shot task. */
function decide(overrides: Partial<Parameters<typeof decideAllowList>[0]> = {}) {
  return decideAllowList({
    body: { allowList: [CHECK, RUN, VERIFY] },
    before: [],
    createsOneShot: true,
    listEverSet: false,
    mode: 'dontAsk',
    ceiling: FULL,
    runtime: undefined,
    adder: OWN,
    ...overrides,
  });
}

describe('decideAllowList', () => {
  it('has nothing to decide when the call names no list', () => {
    expect(decide({ body: { name: 'x' } })).toEqual({ kind: 'none' });
  });

  it('lets a Full agent set its new one-shot task’s exact list of three', () => {
    expect(decide()).toEqual({
      kind: 'ok',
      before: [],
      after: [CHECK, RUN, VERIFY],
      added: [CHECK, RUN, VERIFY],
      removed: [],
    });
  });

  // Every shape refusal, the first list included.
  it.each([
    'Bash',
    'Bash(*)',
    'Bash(/home/sample/agents/media/bin/:*)',
    'Bash(/home/sample/agents/media/bin/derive-sample *)',
    'Bash(/home/sample/agents/media/bin/other-script --backfill)'.replace('other', 'other*'),
    'Bash(derive-sample --backfill)',
    'Bash(/bin/date; /bin/true)',
    'Bash(/home/sample/../evil)',
    'Bash(/bin/bash /home/sample/agents/media/bin/derive-sample)',
    'Read(/home/sample/notes.md)',
  ])('refuses a first list holding %s, naming it', (bad) => {
    const verdict = decide({ body: { allowList: [CHECK, bad] } });
    expect(verdict).toMatchObject({ kind: 'refused', code: 'allow_list_not_exact' });
    expect(verdict.kind === 'refused' && verdict.message).toContain(bad);
  });

  it('refuses a list on a task that would not run at Don’t ask', () => {
    expect(decide({ mode: 'bypassPermissions' })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_needs_dont_ask',
    });
  });

  it('refuses new entries when the agent’s own level asks before commands', () => {
    expect(decide({ ceiling: EDITS })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_above_level',
    });
  });

  it('refuses a list for a runtime that can’t carry one', () => {
    expect(decide({ runtime: 'codex' })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_runtime',
    });
  });

  it('asks a person for a list on a task that is not a new one-shot', () => {
    expect(decide({ createsOneShot: false })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_ask_person',
    });
  });

  it('asks a person for any addition after the first list', () => {
    expect(
      decide({ before: [RUN], listEverSet: true, body: { allowList: [RUN, VERIFY] } })
    ).toMatchObject({ kind: 'refused', code: 'allow_list_ask_person' });
  });

  it('asks a person for an edited argument: it is a new entry', () => {
    const edited = 'Bash(/home/sample/agents/media/bin/derive-sample --backfill --all)';
    expect(
      decide({ before: [RUN], listEverSet: true, body: { allowList: [edited] } })
    ).toMatchObject({ kind: 'refused', code: 'allow_list_ask_person' });
  });

  it('asks a person for a list set again after it was cleared', () => {
    expect(decide({ before: [], listEverSet: true, body: { allowList: [RUN] } })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_ask_person',
    });
  });

  it.each([
    ['a turn that read injected text', { marked: true }],
    ['the narrowed run itself', { scheduledRun: true }],
    ['another chat or agent', { ownChatOwnTask: false }],
  ])('asks a person when even a first list comes from %s', (_label, adder) => {
    expect(decide({ adder: { ...OWN, ...adder } })).toMatchObject({
      kind: 'refused',
      code: 'allow_list_ask_person',
    });
  });

  // Removing only narrows: free whatever the level, the mode or the caller.
  it.each([
    { ceiling: EDITS },
    { mode: 'bypassPermissions' },
    { adder: { ownChatOwnTask: false, marked: true, scheduledRun: true } },
    { runtime: 'codex' },
    { createsOneShot: false },
  ])('lets an agent remove entries (%o)', (overrides) => {
    expect(
      decide({
        before: [CHECK, RUN],
        listEverSet: true,
        body: { allowList: [RUN] },
        ...overrides,
      })
    ).toMatchObject({ kind: 'ok', added: [], removed: [CHECK], after: [RUN] });
  });

  it('lets an agent drop a rule a person approved, whatever its shape', () => {
    expect(
      decide({ before: ['Read(notes/**)', RUN], listEverSet: true, body: { allowList: [RUN] } })
    ).toMatchObject({ kind: 'ok', removed: ['Read(notes/**)'], after: [RUN] });
  });

  it('clears a whole list with an empty one', () => {
    expect(
      decide({ before: [CHECK, RUN, VERIFY], listEverSet: true, body: { allowList: [] } })
    ).toMatchObject({ kind: 'ok', after: [], removed: [CHECK, RUN, VERIFY] });
  });
});

describe('runsAnyCommandUnasked', () => {
  it('is true only for a level that never asks and reaches everything', () => {
    expect(runsAnyCommandUnasked(FULL)).toBe(true);
  });

  // Each half on its own: one that never asks but reaches less, and one that
  // reaches everything but asks.
  it.each([
    { asks: 'never', reach: 'workspace' },
    { asks: 'never', reach: 'edit' },
    { asks: 'when-risky', reach: 'everything' },
    { asks: 'always', reach: 'everything' },
  ] as TurnPermissionLevel[])('is false for %o', (level) => {
    expect(runsAnyCommandUnasked(level)).toBe(false);
  });

  it('refuses a first list for a ceiling that never asks but does not reach everything', () => {
    expect(
      decide({ ceiling: { asks: 'never', reach: 'workspace' } as TurnPermissionLevel })
    ).toMatchObject({ kind: 'refused', code: 'allow_list_above_level' });
  });
});

describe('narrowingOf', () => {
  it('keeps the stored order', () => {
    expect(narrowingOf([VERIFY, RUN], [RUN, CHECK, VERIFY])).toEqual([RUN, VERIFY]);
  });

  it('is null for anything that adds, or is not a list', () => {
    expect(narrowingOf([RUN, CHECK], [RUN])).toBeNull();
    expect(narrowingOf('Bash(/bin/date)', [RUN])).toBeNull();
  });
});

describe('addingEntriesAsksAPerson', () => {
  it('never asks for removing alone', () => {
    expect(
      addingEntriesAsksAPerson({
        added: [],
        createsOneShot: false,
        listEverSet: true,
        adder: { ownChatOwnTask: false, marked: true, scheduledRun: true },
      })
    ).toBe(false);
  });

  it('lets the task’s own agent set a new one-shot task’s first list', () => {
    expect(
      addingEntriesAsksAPerson({
        added: [RUN],
        createsOneShot: true,
        listEverSet: false,
        adder: OWN,
      })
    ).toBe(false);
  });

  describe('a move off Bypass (PR 2)', () => {
    const move = (adder: typeof OWN, added: string[] = [RUN]) =>
      addingEntriesAsksAPerson({
        added,
        createsOneShot: false,
        listEverSet: true,
        narrowsFromBypass: true,
        adder,
      });

    it('is the own agent’s call from its own unmarked chat, a list it had before included', () => {
      expect(move(OWN)).toBe(false);
    });

    it.each([
      ['a marked turn', { ...OWN, marked: true }],
      ['a scheduled run', { ...OWN, scheduledRun: true }],
      ['another chat or agent', { ...OWN, ownChatOwnTask: false }],
    ])('asks a person from %s', (_name, adder) => {
      expect(move(adder)).toBe(true);
    });

    it('asks a person from a marked turn even when it adds nothing new', () => {
      expect(move({ ...OWN, marked: true }, [])).toBe(true);
    });
  });
});

describe('decideAllowList off Bypass (PR 2)', () => {
  it('judges every entry, even one already on the list, and never as a narrowing', () => {
    const verdict = decide({
      body: { allowList: [RUN] },
      before: [RUN, VERIFY],
      createsOneShot: false,
      listEverSet: true,
      narrowsFromBypass: true,
    });
    expect(verdict).toMatchObject({ kind: 'ok', after: [RUN], removed: [VERIFY] });
    const bad = decide({
      body: { allowList: ['Bash(/usr/bin/python3 /home/sample/publish --dry-run)'] },
      createsOneShot: false,
      narrowsFromBypass: true,
    });
    expect(bad).toMatchObject({ kind: 'refused', code: 'allow_list_not_exact' });
  });
});
