import { describe, it, expect } from 'vitest';
import { describeApprovalChanges } from '../lib/describe-approval-changes';

describe('describeApprovalChanges (DOR-2323)', () => {
  it('names the old and the new model and runtime in plain words', () => {
    // Purpose: the card's "what changed" is the reason a person can decide.
    expect(
      describeApprovalChanges([
        { field: 'runtime', from: null, to: 'codex' },
        { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4' },
      ])
    ).toEqual([
      { label: 'Runtime', from: 'the agent’s own', to: 'codex', unbroken: true },
      // A model name is one word; the card never breaks it at a hyphen.
      { label: 'Model', from: 'claude-sonnet-4', to: 'claude-opus-4', unbroken: true },
    ]);
  });

  it('writes limits and switches the way a person would say them', () => {
    expect(
      describeApprovalChanges([
        { field: 'maxRuntime', from: null, to: 7_200_000 },
        { field: 'sticky', from: false, to: true },
        { field: 'effort', from: 'low', to: null },
      ])
    ).toEqual([
      { label: 'Time limit', from: 'the default', to: '2h', unbroken: true },
      { label: 'Remembers earlier runs', from: 'no', to: 'yes', unbroken: true },
      { label: 'Effort', from: 'low', to: 'the agent’s own', unbroken: true },
    ]);
  });

  it('names an account change, and an account left to the agent (DOR-2384)', () => {
    expect(
      describeApprovalChanges([
        { field: 'account', from: null, to: 'work' },
        { field: 'account', from: 'work', to: null },
      ])
    ).toEqual([
      { label: 'Account', from: 'the agent’s own', to: 'work', unbroken: true },
      { label: 'Account', from: 'work', to: 'the agent’s own', unbroken: true },
    ]);
  });

  it('says the instructions changed without quoting them', () => {
    // Purpose: the full prompt is one click away on the card; a diff here is noise.
    expect(describeApprovalChanges([{ field: 'prompt', from: null, to: null }])).toEqual([
      { label: 'Instructions', from: null, to: 'changed (see below)', unbroken: false },
    ]);
  });

  it('keeps timing readable', () => {
    expect(
      describeApprovalChanges([
        { field: 'cron', from: '0 3 * * *', to: '* * * * *' },
        { field: 'timezone', from: 'UTC', to: 'Asia/Tokyo' },
        { field: 'name', from: 'sweep', to: 'purge' },
      ])
    ).toEqual([
      // In words, like the card's own cadence line, not as a raw expression.
      { label: 'Schedule', from: 'At 03:00 AM', to: 'Every minute', unbroken: false },
      { label: 'Timezone', from: 'UTC', to: 'Asia/Tokyo', unbroken: true },
      { label: 'Name', from: 'sweep', to: 'purge', unbroken: true },
    ]);
  });
});
