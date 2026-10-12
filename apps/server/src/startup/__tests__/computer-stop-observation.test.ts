import { expect, it, vi } from 'vitest';
import type { ComputerStatus } from '@dorkos/shared/computer-schemas';
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../lib/logger.js', () => ({ logger: { warn } }));
import { reportComputerStop } from '../computer-stop-observation.js';
it('reports uncertainty even when disabling hides the physical phase', () => {
  const status: ComputerStatus = {
    id: 'local',
    name: 'Agent computer',
    supported: true,
    phase: 'disabled',
    generation: 7,
    ready: false,
    error: { code: 'cleanup-uncertain' },
  };
  reportComputerStop(status, 'disable');
  expect(warn).toHaveBeenCalledWith('[Computer] physical stop unconfirmed', {
    reason: 'disable',
    phase: 'disabled',
    generation: 7,
    code: 'cleanup-uncertain',
  });
  warn.mockClear();
  reportComputerStop({ ...status, phase: 'stopped', error: undefined }, 'shutdown');
  expect(warn).not.toHaveBeenCalled();
});
