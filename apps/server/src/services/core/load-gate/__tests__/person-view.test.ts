/**
 * The waiting line as the person sees it (DOR-4209): names only from this
 * server's memory, a program name and nothing more, and no wait below zero.
 */
import { describe, expect, it } from 'vitest';
import type { WaitingJob } from '../load-gate.js';
import { jobLabelForPerson, waitingLineForPerson } from '../person-view.js';

const NOW = Date.UTC(2026, 10, 19, 12);

function job(overrides: Partial<WaitingJob> = {}): WaitingJob {
  return {
    id: '0123456789abcdef',
    seq: 1,
    pid: 123,
    startedAt: 1,
    createdAt: NOW - 60_000,
    priority: 'normal',
    job: 'pnpm',
    ownedHere: true,
    ...overrides,
  };
}

describe('waitingLineForPerson', () => {
  it('numbers the line in the order given and carries each mark', () => {
    const line = waitingLineForPerson(
      [
        job({ id: 'aaaaaaaaaaaaaaaa', front: true, agentName: 'Scout', chatTitle: 'Fix login' }),
        job({ id: 'bbbbbbbbbbbbbbbb', priority: 'urgent', letThrough: true }),
      ],
      NOW
    );
    expect(line.jobs).toEqual([
      {
        id: 'aaaaaaaaaaaaaaaa',
        position: 1,
        ownedHere: true,
        agentName: 'Scout',
        chatTitle: 'Fix login',
        label: 'pnpm',
        waitingSinceMs: NOW - 60_000,
        urgent: false,
        front: true,
        letThrough: false,
      },
      {
        id: 'bbbbbbbbbbbbbbbb',
        position: 2,
        ownedHere: true,
        label: 'pnpm',
        waitingSinceMs: NOW - 60_000,
        urgent: true,
        front: false,
        letThrough: true,
      },
    ]);
  });

  it('names nobody for a job another app queued, whatever the entry carries', () => {
    const [view] = waitingLineForPerson(
      [job({ ownedHere: false, agentName: 'Scout', chatTitle: 'Fix login' })],
      NOW
    ).jobs;
    expect(view).not.toHaveProperty('agentName');
    expect(view).not.toHaveProperty('chatTitle');
    expect(view!.ownedHere).toBe(false);
  });

  it('drops control and format characters from names, and a name left empty', () => {
    const [view] = waitingLineForPerson(
      [job({ agentName: 'Sc\u0007out‮', chatTitle: '​\u0000' })],
      NOW
    ).jobs;
    expect(view!.agentName).toBe('Scout');
    expect(view).not.toHaveProperty('chatTitle');
  });

  it('never shows a wait that started in the future', () => {
    const [view] = waitingLineForPerson([job({ createdAt: NOW + 3_600_000 })], NOW).jobs;
    expect(view!.waitingSinceMs).toBe(NOW);
  });
});

describe('jobLabelForPerson', () => {
  it('keeps a program name as it is', () => {
    expect(jobLabelForPerson('tsc')).toBe('tsc');
  });

  it('cuts a long name to 40 characters and strips what cannot show', () => {
    expect(jobLabelForPerson('a'.repeat(64))).toBe('a'.repeat(40));
    expect(jobLabelForPerson('pn\u0000pm‏')).toBe('pnpm');
  });

  it('calls a label with nothing left a job', () => {
    expect(jobLabelForPerson('\u0000')).toBe('job');
  });
});
