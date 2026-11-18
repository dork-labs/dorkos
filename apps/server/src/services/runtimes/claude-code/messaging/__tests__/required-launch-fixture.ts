/** Genuine ordinary authority for direct SDK-sender fixtures, never a fake null reader. */
import { createTestDb } from '@dorkos/test-utils/db';
import { onTestFinished } from 'vitest';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import type { RequiredLaunchOwner } from '../launch/required-launch.js';

/** Each direct launch fixture owns isolated storage, as an app composition root does. */
export function isolatedRequiredLaunchOwner(): RequiredLaunchOwner {
  let owner: RuntimeRegistry | undefined;
  return () => {
    // The file's options helpers share one namespace for the complete test,
    // including retries/multiple launches. Pure tests create no database.
    if (!owner) {
      const db = createTestDb();
      const current = new RuntimeRegistry();
      current.setDb(db);
      onTestFinished(() => {
        db.$client.close();
        if (owner === current) owner = undefined;
      });
      owner = current;
    }
    return owner.requiredLaunches();
  };
}
