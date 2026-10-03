import type { ExtensionRecord } from '@dorkos/extension-api';
import type { CoreExtensionInfo } from '../extension-enable-resolution.js';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { ExtensionCompiler } from '../extension-compiler.js';
import { ExtensionServerLifecycle } from '../extension-server-lifecycle.js';
import type { reload, requestRefresh, placeSnapshots, needsServer } from './scan.js';
import type { bindUnsourcedApprovals } from './approvals.js';
import type { readPublic } from './publication.js';
/** One private owner-created live state, never exposed by the public facade. */
export interface ManagerState {
  dorkHome: string;
  discovery: ExtensionDiscovery;
  compiler: ExtensionCompiler;
  serverLifecycle: ExtensionServerLifecycle;
  extensions: Map<string, ExtensionRecord>;
  currentCwd: string | null;
  coreExtensions: Map<string, CoreExtensionInfo>;
  changeListeners: Set<() => void>;
  shadowed: ExtensionRecord[];
  scans: Promise<void>;
  projectRoots: ((cwd: string | null) => Promise<readonly string[]>) | null;
  announceReloaded: ((ids: string[]) => void) | null;
  operations: ManagerOperations;
}
interface ManagerOperations {
  readPublic: (
    ...args: Parameters<typeof readPublic> extends [ManagerState, ...infer Rest] ? Rest : never
  ) => ReturnType<typeof readPublic>;
  bindUnsourcedApprovals: (
    ...args: Parameters<typeof bindUnsourcedApprovals> extends [ManagerState, ...infer Rest]
      ? Rest
      : never
  ) => ReturnType<typeof bindUnsourcedApprovals>;
  reload: (
    ...args: Parameters<typeof reload> extends [ManagerState, ...infer Rest] ? Rest : never
  ) => ReturnType<typeof reload>;
  requestRefresh: (
    ...args: Parameters<typeof requestRefresh> extends [ManagerState, ...infer Rest] ? Rest : never
  ) => ReturnType<typeof requestRefresh>;
  placeSnapshots: (
    ...args: Parameters<typeof placeSnapshots> extends [ManagerState, ...infer Rest] ? Rest : never
  ) => ReturnType<typeof placeSnapshots>;
  needsServer: (
    ...args: Parameters<typeof needsServer> extends [ManagerState, ...infer Rest] ? Rest : never
  ) => ReturnType<typeof needsServer>;
  enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  emitChanged: () => void;
}
/** Create the single manager-owned state shared by its private operations. */
export function createManagerState(input: {
  dorkHome: string;
  coreExtensions: CoreExtensionInfo[];
  options: { registerTimeoutMs?: number };
  operations: ManagerOperations;
}): ManagerState {
  const { dorkHome, coreExtensions, options, operations } = input;
  const compiler = new ExtensionCompiler(dorkHome);
  return {
    extensions: new Map(),
    currentCwd: null,
    changeListeners: new Set<() => void>(),
    shadowed: [],
    scans: Promise.resolve(),
    projectRoots: null,
    announceReloaded: null,
    dorkHome,
    coreExtensions: new Map(coreExtensions.map((info) => [info.id, info])),
    discovery: new ExtensionDiscovery(dorkHome),
    compiler,
    serverLifecycle: new ExtensionServerLifecycle(dorkHome, compiler, options.registerTimeoutMs),
    operations,
  };
}
