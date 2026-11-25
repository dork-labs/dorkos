import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { toast } from 'sonner';
import { reportPermissionFailure } from '../lib/report-failure';

afterEach(() => vi.clearAllMocks());

describe('reportPermissionFailure', () => {
  it('adds no red toast for a Wi-Fi refusal, which the app already says calmly (DOR-3037)', () => {
    const refusal = Object.assign(new Error('Raising permissions works only at this computer.'), {
      status: 403,
      code: 'not_from_wifi',
    });
    reportPermissionFailure(refusal);
    expect(toast.error).not.toHaveBeenCalled();
  });

  // DOR-4909: a cancelled "Confirm it’s you" is a choice, said calmly, never red.
  it('says calmly that nothing changed after a cancelled Confirm it’s you', () => {
    reportPermissionFailure(
      Object.assign(new Error('Not confirmed. Nothing changed.'), { code: 'step_up_required' })
    );
    expect(toast).toHaveBeenCalledExactlyOnceWith('Not confirmed. Nothing changed.');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says any other failure in the server’s words', () => {
    reportPermissionFailure(new Error('Only a person can change permissions.'));
    expect(toast.error).toHaveBeenCalledWith('Only a person can change permissions.');
  });
});
