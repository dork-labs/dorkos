import { describe, expect, it } from 'vitest';
import type { LoadGateWaitingJob } from '@dorkos/shared/load-gate-queue';
import {
  actionError,
  disabledReason,
  jobOwner,
  jobPhrase,
  standingLine,
  waitedLine,
} from '../lib/job-lines';

const NOW = Date.UTC(2026, 10, 19, 12);

function job(overrides: Partial<LoadGateWaitingJob> = {}): LoadGateWaitingJob {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    position: 1,
    ownedHere: true,
    label: 'pnpm',
    waitingSinceMs: NOW,
    urgent: false,
    front: false,
    letThrough: false,
    ...overrides,
  };
}

describe('job lines', () => {
  it('names the owner, or says another app queued it', () => {
    expect(jobOwner(job({ agentName: 'Scout' }))).toBe('Scout');
    expect(jobOwner(job())).toBe('Your agent');
    expect(jobOwner(job({ ownedHere: false }))).toBe('Another app on this computer');
    expect(jobPhrase(job({ ownedHere: false, label: 'tsc' }))).toBe('another app’s tsc');
  });

  it('counts the wait in whole minutes, hours and days', () => {
    expect(waitedLine(job(), NOW + 30_000)).toBe('Waiting');
    expect(waitedLine(job(), NOW + 5 * 60_000)).toBe('Waiting 5m');
    expect(waitedLine(job(), NOW + 2 * 3_600_000)).toBe('Waiting 2h');
    expect(waitedLine(job(), NOW - 60_000)).toBe('Waiting');
  });

  it('says where a moved job stands', () => {
    expect(standingLine(job())).toBeNull();
    expect(standingLine(job({ urgent: true }))).toBe('Urgent');
    expect(standingLine(job({ urgent: true, front: true }))).toBe('First in line');
    expect(standingLine(job({ front: true, letThrough: true }))).toBe('Starting');
  });

  it('holds back only what a job already has', () => {
    expect(disabledReason(job(), 'urgent')).toBeUndefined();
    expect(disabledReason(job({ urgent: true }), 'urgent')).toBe('Already urgent');
    expect(disabledReason(job({ urgent: true }), 'front')).toBeUndefined();
    expect(disabledReason(job({ front: true }), 'urgent')).toBe('Already first in line');
    expect(disabledReason(job({ letThrough: true }), 'let-through')).toBe('Starting now');
  });

  it('tells a job that left apart from any other failure', () => {
    expect(actionError({ status: 404 })).toBe('This job isn’t waiting anymore.');
    expect(actionError(new Error('x'))).toBe('Couldn’t change this job. Try again.');
  });
});
