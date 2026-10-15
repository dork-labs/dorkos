import { describe, expect, it, vi } from 'vitest';
import { endSessionsWhere, stopCreditsSessions, sweepEvictedSessions } from '../end-sessions.js';

describe('Claude session ending owner admission', () => {
  it('refuses a structural owner before any port getter or selection callback', async () => {
    const reads = vi.fn();
    const belongs = vi.fn(() => true);
    const foreign = new Proxy({}, { get: reads });
    await expect(endSessionsWhere(foreign, belongs)).rejects.toThrow();
    await expect(stopCreditsSessions(foreign)).rejects.toThrow();
    expect(() => sweepEvictedSessions(foreign)).toThrow();
    expect(reads).not.toHaveBeenCalled();
    expect(belongs).not.toHaveBeenCalled();
  });
});
