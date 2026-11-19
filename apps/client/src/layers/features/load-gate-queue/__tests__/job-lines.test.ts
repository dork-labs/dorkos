import { describe, expect, it } from 'vitest';
import type { LoadGateWaitingJob } from '@dorkos/shared/load-gate-queue';
import {
  actionError,
  disabledReason,
  doneAnnouncement,
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

  it('says where a moved job stands, taking first in line from its place', () => {
    const second = { position: 2 };
    expect(standingLine(job())).toBeNull();
    expect(standingLine(job({ ...second, urgent: true }))).toBe('Urgent');
    expect(standingLine(job({ ...second, front: true }))).toBe('Moved to front');
    expect(standingLine(job({ front: true }))).toBe('First in line');
    expect(standingLine(job({ urgent: true }))).toBe('First in line');
    expect(standingLine(job({ front: true, letThrough: true }))).toBe('Starting');
  });

  it('holds back only what a job already has', () => {
    const second = { position: 2 };
    expect(disabledReason(job(second), 'urgent')).toBeUndefined();
    expect(disabledReason(job(second), 'front')).toBeUndefined();
    expect(disabledReason(job({ ...second, urgent: true }), 'urgent')).toBe('Already urgent');
    expect(disabledReason(job({ ...second, urgent: true }), 'front')).toBeUndefined();
    expect(disabledReason(job({ ...second, front: true }), 'urgent')).toBe(
      'Already ahead of urgent jobs'
    );
    // Moved to the front before, and a later move went ahead: it can be moved again.
    expect(disabledReason(job({ ...second, front: true }), 'front')).toBeUndefined();
    expect(disabledReason(job(), 'front')).toBe('Already first in line');
    expect(disabledReason(job(), 'urgent')).toBe('Already first in line');
    expect(disabledReason(job(), 'let-through')).toBeUndefined();
    expect(disabledReason(job({ letThrough: true }), 'let-through')).toBe('Starting now');
  });

  it('says first in line after a move only when the answer puts the job first', () => {
    const before = job({ position: 3, agentName: 'Scout' });
    expect(doneAnnouncement(before, 'front', job({ position: 1 }))).toBe(
      'Scout’s pnpm is first in line.'
    );
    expect(doneAnnouncement(before, 'front', job({ position: 2 }))).toBe(
      'Scout’s pnpm moved to the front.'
    );
    expect(doneAnnouncement(before, 'front', undefined)).toBe('Scout’s pnpm moved to the front.');
    expect(doneAnnouncement(before, 'urgent', job({ position: 1 }))).toBe(
      'Scout’s pnpm is urgent.'
    );
    expect(doneAnnouncement(before, 'let-through', undefined)).toBe('Scout’s pnpm starts now.');
  });

  it('tells a job that left apart from any other failure', () => {
    expect(actionError({ status: 404 })).toBe('This job isn’t waiting anymore.');
    expect(actionError(new Error('x'))).toBe('Couldn’t change this job. Try again.');
  });
});
