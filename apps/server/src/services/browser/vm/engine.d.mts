import type {
  BrowserLifecycleEngine,
  PrivateBrowserBirthOwner,
} from '@dorkos/browser/server-owner';
import type { EnginePolicy } from '@dorkos/browser';
import type { BrowserRegistryStore } from '../registry/store.js';
export function constructOriginalManagedVMEngine(
  options: Readonly<{
    registry: BrowserRegistryStore;
    owner: string;
    dataHome: string;
    release: unknown;
    width: number;
    height: number;
    birthOwner: PrivateBrowserBirthOwner;
    policy: EnginePolicy;
    policyRevision: number;
  }>
): BrowserLifecycleEngine;
