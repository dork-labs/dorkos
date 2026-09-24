/**
 * What `dorkos update` and `dorkos marketplace held-back` print for what a new
 * version runs: every line, including the commands a skill's text runs.
 */
import { describe, expect, it } from 'vitest';
import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import { renderDisclosureLines } from '../lib/disclosure-render.js';

const NOTHING: DisclosedEffects = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

describe('renderDisclosureLines', () => {
  it("lists each command a skill's text runs, and which skill runs it (DOR-2327)", () => {
    // Purpose: an update that adds one re-asks; the person must be able to
    // read what they are being asked about.
    expect(
      renderDisclosureLines(
        {
          ...NOTHING,
          skillCommands: [
            { source: 'skills/ctx/SKILL.md', skill: 'ctx', form: 'inline', command: 'git status' },
          ],
        },
        'global'
      )
    ).toEqual(['    runs when the skill "ctx" is used:', '      git status']);
  });

  it('says a version that runs nothing runs nothing', () => {
    expect(renderDisclosureLines(NOTHING, 'global')).toEqual(['    runs nothing on its own']);
  });
});
