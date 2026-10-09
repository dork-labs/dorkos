import { registerOriginalNativeLaunchCase } from './room-original-native-case.js';

registerOriginalNativeLaunchCase(
  'launch',
  'places the original registered agent and launches one real projected turn against current main'
);
registerOriginalNativeLaunchCase(
  'refresh-story',
  'refreshes a clean copy, holds one with work in progress, and names who moved main'
);
registerOriginalNativeLaunchCase(
  'placed-tip-change',
  'a turn placed while main was at A and launched after main moved to B lands on B'
);
registerOriginalNativeLaunchCase(
  'placed-dirty-counts',
  're-measures the counts against the captured tip when the copy is held'
);
registerOriginalNativeLaunchCase(
  'refresh-baselines',
  'forgets the diff baselines of the files a refresh moved, and only those'
);
registerOriginalNativeLaunchCase(
  'retired-id-busy',
  'holds a real retired-id turn without touching its copy and refreshes after it drains'
);

registerOriginalNativeLaunchCase(
  'merge-capability',
  'merges through the original native Room principal and gated capability registry'
);

registerOriginalNativeLaunchCase(
  'runner-completion',
  'observes an actual original runner completion without issuing or retaining a native request'
);

registerOriginalNativeLaunchCase(
  'runner-observer-failure',
  'passive constructor completion observation cannot replace an original turn with undefined'
);

registerOriginalNativeLaunchCase(
  'merge-config-refusal',
  'sanitizes poisoned git configuration through the genuine native merge capability'
);
