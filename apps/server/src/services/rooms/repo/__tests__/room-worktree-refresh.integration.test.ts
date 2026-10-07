/** Original three integration subjects now run original registered native Room producers in owned children. */
import { registerOriginalNativeLaunchCase } from './room-original-native-case.js';

registerOriginalNativeLaunchCase(
  'refresh-story',
  'refreshes a clean copy, holds one with work in progress, and names who moved main'
);
registerOriginalNativeLaunchCase(
  'retired-id-busy',
  'leaves the copy alone while a turn runs on a RETIRED id of the same binding'
);
registerOriginalNativeLaunchCase(
  'refresh-baselines',
  'forgets the diff baselines of the files a refresh moved, and only those'
);
