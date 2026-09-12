import { describe, it, expect } from 'vitest';
import { isAmbientTask } from '../ambient-tasks';

describe('isAmbientTask', () => {
  it('treats an unmarked task as ordinary work', () => {
    // Every runtime but claude-code leaves the mark off, so absence is the
    // common case and it must never read as "hide this".
    expect(isAmbientTask({ status: 'running' })).toBe(false);
    expect(isAmbientTask({ ambient: false, status: 'running' })).toBe(false);
  });

  it('hides a marked task that is running or finished quietly', () => {
    expect(isAmbientTask({ ambient: true, status: 'running' })).toBe(true);
    expect(isAmbientTask({ ambient: true, status: 'complete' })).toBe(true);
    expect(isAmbientTask({ ambient: true, status: 'stopped' })).toBe(true);
    // DorkOS lost sight of it — an ending, not a failure (DOR-1108), so it
    // stays hidden like the other endings.
    expect(isAmbientTask({ ambient: true, status: 'untracked' })).toBe(true);
  });

  it('shows a marked task that failed', () => {
    // The whole reason hiding is safe: quiet about work nobody asked for is
    // calm, quiet about something that broke is a lie.
    expect(isAmbientTask({ ambient: true, status: 'error' })).toBe(false);
  });
});
