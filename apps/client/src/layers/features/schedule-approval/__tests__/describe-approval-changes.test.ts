import { describe, it, expect } from 'vitest';
import { describeApprovalChanges } from '../lib/describe-approval-changes';

describe('describeApprovalChanges (DOR-2323)', () => {
  it('names the old and the new model and runtime in plain words', () => {
    // Purpose: the card's "what changed" is the reason a person can decide.
    expect(
      describeApprovalChanges([
        { field: 'runtime', from: null, to: 'codex', via: 'schedule' },
        { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'schedule' },
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
        { field: 'maxRuntime', from: null, to: 7_200_000, via: 'schedule' },
        { field: 'sticky', from: false, to: true, via: 'schedule' },
        { field: 'effort', from: 'low', to: null, via: 'schedule' },
      ])
    ).toEqual([
      { label: 'Time limit', from: 'the default', to: '2h', unbroken: true },
      { label: 'Remembers earlier runs', from: 'no', to: 'yes', unbroken: true },
      { label: 'Effort', from: 'low', to: 'the agent’s own', unbroken: true },
    ]);
  });

  it('says the instructions changed without quoting them', () => {
    // Purpose: the full prompt is one click away on the card; a diff here is noise.
    expect(
      describeApprovalChanges([{ field: 'prompt', from: null, to: null, via: 'schedule' }])
    ).toEqual([{ label: 'Instructions', from: null, to: 'changed (see below)', unbroken: false }]);
  });

  it('keeps timing readable', () => {
    expect(
      describeApprovalChanges([
        { field: 'cron', from: '0 3 * * *', to: '* * * * *', via: 'schedule' },
        { field: 'timezone', from: 'UTC', to: 'Asia/Tokyo', via: 'schedule' },
        { field: 'name', from: 'sweep', to: 'purge', via: 'schedule' },
      ])
    ).toEqual([
      // In words, like the card's own cadence line, not as a raw expression.
      { label: 'Schedule', from: 'At 03:00 AM', to: 'Every minute', unbroken: false },
      { label: 'Timezone', from: 'UTC', to: 'Asia/Tokyo', unbroken: true },
      { label: 'Name', from: 'sweep', to: 'purge', unbroken: true },
    ]);
  });

  it('names a change to the agent the schedule follows as the agent’s (DOR-2337)', () => {
    // Purpose: the schedule's own model is unset; what moved is its agent's,
    // changed outside DorkOS, and the card must not pass it off as the schedule's.
    expect(
      describeApprovalChanges([
        { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
        { field: 'effort', from: null, to: 'max', via: 'agent' },
      ])
    ).toEqual([
      { label: 'Agent’s model', from: 'claude-sonnet-4', to: 'claude-opus-4', unbroken: true },
      // Unset on the agent is the runtime's default, not "the agent's own".
      { label: 'Agent’s effort', from: 'the default', to: 'max', unbroken: true },
    ]);
  });
});
