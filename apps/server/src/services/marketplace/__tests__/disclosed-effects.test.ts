import { describe, it, expect } from 'vitest';
import {
  describeDisclosedEffects,
  disclosedEffectsOf,
  sameDisclosedEffects,
} from '../disclosed-effects.js';
import type { PermissionPreview } from '../types.js';

/** A preview that discloses nothing, which callers override one field of. */
function preview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    npmDependencies: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

describe('disclosedEffectsOf', () => {
  it('distinguishes "nothing was previewed" from "the package declares nothing"', () => {
    // An uninstall previews nothing at all; an install of an inert package
    // previews empty lists. Collapsing the two would let one hash as the other.
    expect(disclosedEffectsOf(undefined)).toBeNull();
    expect(disclosedEffectsOf(preview())).toEqual({ hooks: [], schedules: [] });
  });

  it('keeps the command verbatim and binds an absent matcher as absent', () => {
    const effects = disclosedEffectsOf(
      preview({ hooks: [{ event: 'Stop', command: '  rm  -rf ./tmp  ' }] })
    );
    expect(effects).toEqual({
      hooks: [{ event: 'Stop', matcher: null, command: '  rm  -rf ./tmp  ' }],
      schedules: [],
    });
  });

  it('keeps hooks in declaration order, because that is the order they run in', () => {
    const effects = disclosedEffectsOf(
      preview({
        hooks: [
          { event: 'PreToolUse', command: 'a' },
          { event: 'PreToolUse', command: 'b' },
        ],
      })
    );
    expect(effects?.hooks.map((hook) => hook.command)).toEqual(['a', 'b']);
  });

  it('carries every field of a scheduled job that decides what it does unattended', () => {
    const effects = disclosedEffectsOf(
      preview({
        schedules: [
          {
            name: 'nightly',
            cron: '0 3 * * *',
            permissionMode: 'acceptEdits',
            startsEnabled: true,
          },
        ],
      })
    );
    expect(effects?.schedules).toEqual([
      { name: 'nightly', cron: '0 3 * * *', permissionMode: 'acceptEdits', startsEnabled: true },
    ]);
  });

  it('sorts schedules, so readdir order over .dork/tasks cannot force a spurious re-ask', () => {
    // `readTaskSkills` walks the directory, and the filesystem does not promise a
    // stable order. A schedule fires on its own clock, so the order carries no
    // meaning — and a re-ask nobody caused is what teaches an operator to stop
    // reading the card.
    const one = {
      name: 'nightly',
      cron: '0 3 * * *',
      permissionMode: 'acceptEdits' as const,
      startsEnabled: true,
    };
    const two = {
      name: 'hourly',
      cron: '0 * * * *',
      permissionMode: 'acceptEdits' as const,
      startsEnabled: false,
    };
    expect(disclosedEffectsOf(preview({ schedules: [one, two] }))).toEqual(
      disclosedEffectsOf(preview({ schedules: [two, one] }))
    );
  });

  it('does not sort hooks, because hooks on one event run in declaration order', () => {
    const a = { event: 'PreToolUse', command: 'first' };
    const b = { event: 'PreToolUse', command: 'second' };
    expect(disclosedEffectsOf(preview({ hooks: [a, b] }))).not.toEqual(
      disclosedEffectsOf(preview({ hooks: [b, a] }))
    );
  });

  it('ignores the parts of the preview a fresh resolve may legitimately renumber', () => {
    const withFiles = disclosedEffectsOf(
      preview({
        fileChanges: [{ path: '/x/README.md', action: 'create' }],
        npmDependencies: [{ name: 'left-pad', range: '^1.3.0' }],
        conflicts: [{ level: 'warning', type: 'slot', description: 'clash' }],
        secrets: [{ key: 'API_KEY', required: true }],
      })
    );
    expect(withFiles).toEqual(disclosedEffectsOf(preview()));
  });
});

describe('sameDisclosedEffects', () => {
  it('agrees with the binding: "nothing previewed" is not "declares nothing"', () => {
    expect(sameDisclosedEffects(null, disclosedEffectsOf(preview()))).toBe(false);
    expect(sameDisclosedEffects(null, null)).toBe(true);
  });

  it('is true for two disclosures the approval hash cannot tell apart', () => {
    const a = disclosedEffectsOf(preview({ hooks: [{ event: 'Stop', command: 'x' }] }));
    const b = disclosedEffectsOf(
      preview({ hooks: [{ event: 'Stop', matcher: undefined, command: 'x' }] })
    );
    expect(sameDisclosedEffects(a, b)).toBe(true);
  });

  it('is false as soon as one command changes', () => {
    const a = disclosedEffectsOf(preview({ hooks: [{ event: 'Stop', command: 'x' }] }));
    const b = disclosedEffectsOf(preview({ hooks: [{ event: 'Stop', command: 'y' }] }));
    expect(sameDisclosedEffects(a, b)).toBe(false);
  });
});

describe('describeDisclosedEffects', () => {
  it('quotes and escapes a command, so one cannot forge the rest of the sentence', () => {
    const said = describeDisclosedEffects(
      disclosedEffectsOf(
        preview({ hooks: [{ event: 'Stop', command: 'echo "hi"\nand 2 scheduled jobs' }] })
      )
    );
    // The whole hostile string lands INSIDE one pair of quotes, newline flattened.
    expect(said).toContain('"echo \\"hi\\"\\nand 2 scheduled jobs"');
    expect(said).toContain('1 shell command');
    expect(said).toContain('no scheduled jobs');
  });

  it('names the permission modes a person would care about', () => {
    const said = describeDisclosedEffects(
      disclosedEffectsOf(
        preview({
          schedules: [
            { name: 'a', cron: null, permissionMode: 'acceptEdits', startsEnabled: true },
            { name: 'b', cron: '* * * * *', permissionMode: 'acceptEdits', startsEnabled: false },
          ],
        })
      )
    );
    expect(said).toContain('2 scheduled jobs (acceptEdits)');
  });

  it('stops listing commands after a few, rather than pasting a whole package in', () => {
    const said = describeDisclosedEffects(
      disclosedEffectsOf(
        preview({
          hooks: ['a', 'b', 'c', 'd', 'e'].map((command) => ({ event: 'Stop', command })),
        })
      )
    );
    expect(said).toContain('5 shell commands');
    expect(said).toContain('and 2 more');
    expect(said).not.toContain('"d"');
  });

  it('says so plainly when there was no preview at all', () => {
    expect(describeDisclosedEffects(null)).toBe('nothing that runs on its own');
  });
});
