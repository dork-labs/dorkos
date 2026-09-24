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
      { label: 'Runtime', from: 'the agent’s own', to: 'codex' },
      { label: 'Model', from: 'claude-sonnet-4', to: 'claude-opus-4' },
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
      { label: 'Time limit', from: 'the default', to: '2h' },
      { label: 'Remembers earlier runs', from: 'no', to: 'yes' },
      { label: 'Effort', from: 'low', to: 'the agent’s own' },
    ]);
  });

  it('says the instructions changed without quoting them', () => {
    // Purpose: the full prompt is one click away on the card; a diff here is noise.
    expect(
      describeApprovalChanges([{ field: 'prompt', from: 'Sweep.', to: 'Delete everything.' }])
    ).toEqual([{ label: 'Instructions', from: null, to: 'changed (see below)' }]);
  });

  it('keeps timing readable', () => {
    expect(
      describeApprovalChanges([
        { field: 'cron', from: '0 3 * * *', to: '* * * * *' },
        { field: 'timezone', from: 'UTC', to: 'Asia/Tokyo' },
        { field: 'name', from: 'sweep', to: 'purge' },
      ])
    ).toEqual([
      { label: 'Schedule', from: '0 3 * * *', to: '* * * * *' },
      { label: 'Timezone', from: 'UTC', to: 'Asia/Tokyo' },
      { label: 'Name', from: 'sweep', to: 'purge' },
    ]);
  });
});
