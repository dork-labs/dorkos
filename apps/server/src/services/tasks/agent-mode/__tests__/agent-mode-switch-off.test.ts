/**
 * The pending-ruling switch turned off (DOR-3703, M-A): a mode-only change above
 * Don't ask on content a person approved parks for a person too.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-switch-off
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent-mode-actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-mode-actions.js')>()),
  MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS: false,
}));

import { grantedModeMayRun } from '../agent-mode-record.js';
import { grantOf } from './agent-mode-fixtures.js';

describe('MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS = false', () => {
  it('parks a looser mode even on content a person approved, but not one a card or Don’t ask covers', () => {
    expect(grantedModeMayRun(grantOf({}), true)).toBe(false);
    expect(grantedModeMayRun(grantOf({ via: 'card' }), true)).toBe(true);
    expect(grantedModeMayRun(grantOf({ aboveDontAsk: false }), true)).toBe(true);
  });
});
