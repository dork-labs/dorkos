import { describe, it, expect } from 'vitest';
import {
  formatConnectionName,
  tasksOutcome,
  relayOutcome,
  meshOutcome,
  activityOutcome,
} from '../lib/subsystem-copy';

describe('formatConnectionName', () => {
  it('title-cases a single word', () => {
    expect(formatConnectionName('telegram')).toBe('Telegram');
  });

  it('title-cases a kebab-case type', () => {
    expect(formatConnectionName('claude-code')).toBe('Claude Code');
  });
});

describe('tasksOutcome', () => {
  it('says nothing is scheduled at zero', () => {
    expect(tasksOutcome(0)).toBe('Nothing scheduled yet');
  });

  it('counts a single schedule', () => {
    expect(tasksOutcome(1)).toBe('1 scheduled');
  });

  it('counts many schedules', () => {
    expect(tasksOutcome(4)).toBe('4 scheduled');
  });
});

describe('relayOutcome', () => {
  it('says nothing is connected at zero', () => {
    expect(relayOutcome([])).toBe('No connections yet');
  });

  it('names a single connected connection', () => {
    expect(relayOutcome(['telegram'])).toBe('Connected to Telegram');
  });

  it('names several connected connections', () => {
    expect(relayOutcome(['telegram', 'slack'])).toBe('Connected to Telegram, Slack');
  });
});

describe('meshOutcome', () => {
  it('is singular for one agent', () => {
    expect(meshOutcome(1)).toBe('1 agent ready');
  });

  it('is plural for many agents', () => {
    expect(meshOutcome(3)).toBe('3 agents ready');
  });

  it('is plural for zero agents', () => {
    expect(meshOutcome(0)).toBe('0 agents ready');
  });
});

describe('activityOutcome', () => {
  it('is quiet at zero', () => {
    expect(activityOutcome(0)).toBe('Quiet this week');
  });

  it('is singular for one run', () => {
    expect(activityOutcome(1)).toBe('1 run this week');
  });

  it('is plural for many runs', () => {
    expect(activityOutcome(12)).toBe('12 runs this week');
  });
});
