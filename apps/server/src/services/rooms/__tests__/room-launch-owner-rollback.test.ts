import { it } from 'vitest';
import { runOriginalLaunchOwnerRollbackComponent } from '../repo/__tests__/room-original-launch-owner-rollback-component.js';

it(
  'ordinary failed launch takes back only its own freshly minted row',
  runOriginalLaunchOwnerRollbackComponent
);
