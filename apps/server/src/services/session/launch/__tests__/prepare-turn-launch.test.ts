import { describe, expect, it } from 'vitest';
import { SessionBirthWriteError } from '../../../core/runtime-seam/session-birth-write.js';
import { runPrepareLaunch } from '../prepare-turn-launch.js';

describe('launch-time room preparation', () => {
  it('rejects launch when the required first write is refused', async () => {
    const refusal = new SessionBirthWriteError('write');
    await expect(
      runPrepareLaunch(async () => {
        throw refusal;
      }, 'room-session')
    ).rejects.toBe(refusal);
  });

  it('keeps the accepted context when optional preparation fails', async () => {
    await expect(
      runPrepareLaunch(async () => {
        throw new Error('Context unavailable');
      }, 'room-session')
    ).resolves.toEqual({});
  });
});
