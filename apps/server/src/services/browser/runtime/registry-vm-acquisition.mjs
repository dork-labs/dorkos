import { randomBytes } from 'node:crypto';
import { BrowserRegistryStore } from '../registry/store.js';
import { acquireOriginalManagedVM } from './managed-vm-acquisition.mjs';
const refuse = (code) => new Error(code);
/** Server-private entry after genuine birthOwner.registerBirth(receiver).
 * No client-provided disk generation or arbitrary profile path is admitted. */
export function acquireOriginalRegistryManagedVM(options) {
  const fields = Object.getOwnPropertyDescriptors(options ?? {});
  if (
    Object.keys(fields).sort().join(',') !==
      'dataHome,height,network,owner,receiver,registry,release,width' ||
    Object.values(fields).some((d) => !('value' in d))
  )
    throw refuse('VM_REGISTRY_CLOSED_ARGUMENTS');
  const { registry, owner, receiver, release, dataHome, network, width, height } = options;
  if (
    !(registry instanceof BrowserRegistryStore) ||
    typeof owner !== 'string' ||
    !owner ||
    !receiver.isOrdinary()
  )
    throw refuse('VM_ORIGINAL_REGISTRY_REQUIRED');
  const ordinary = receiver.isOrdinary.bind(receiver),
    browserId = receiver.browserId,
    browserGeneration = receiver.browserGeneration;
  const acquisition = receiver.acquisition;
  if (!['persistent', 'ephemeral'].includes(acquisition?.mode))
    throw refuse('VM_OPENING_RESERVATION_REQUIRED');
  if (acquisition.mode === 'persistent' && typeof acquisition.profileId !== 'string')
    throw refuse('VM_PERSISTENT_RESERVATION_REQUIRED');
  // Original synchronous transaction is retained before the next occurrence guard.
  if (
    !ordinary() ||
    receiver.browserId !== browserId ||
    receiver.browserGeneration !== browserGeneration ||
    receiver.acquisition !== acquisition
  )
    throw refuse('VM_REGISTRY_OCCURRENCE_RETIRED');
  if (acquisition.mode === 'ephemeral') {
    const instance = registry.instance(owner, browserId, browserGeneration);
    if (
      instance.bootId !== registry.bootId ||
      instance.status !== 'opening' ||
      instance.mode !== 'ephemeral' ||
      instance.profileId !== null
    )
      throw refuse('VM_EPHEMERAL_OPENING_REQUIRED');
    if (
      !ordinary() ||
      receiver.browserId !== browserId ||
      receiver.browserGeneration !== browserGeneration ||
      receiver.acquisition !== acquisition
    )
      throw refuse('VM_REGISTRY_OCCURRENCE_RETIRED');
    // Fresh internal names never reuse cookies or a named persistent disk.
    // Failed/dirty artifacts remain private until actual exclusion permits GC.
    return acquireOriginalManagedVM({
      release,
      dataHome,
      network,
      receiver,
      width,
      height,
      profileId: randomBytes(16).toString('base64url'),
      generation: randomBytes(16).toString('base64url'),
    });
  }
  const disk = registry.reserveProfileDisk(owner, browserId, browserGeneration);
  if (
    !ordinary() ||
    receiver.browserId !== browserId ||
    receiver.browserGeneration !== browserGeneration ||
    receiver.acquisition !== acquisition
  )
    throw refuse('VM_REGISTRY_OCCURRENCE_RETIRED');
  if (
    !disk ||
    disk.profileId !== acquisition.profileId ||
    disk.backend !== 'qemu-hvf' ||
    disk.formatVersion !== 1 ||
    !/^[A-Za-z0-9_-]{22}$/.test(disk.generation)
  )
    throw refuse('VM_REGISTRY_DISK_SELECTION');
  return acquireOriginalManagedVM({
    release,
    dataHome,
    network,
    receiver,
    width,
    height,
    profileId: disk.profileId,
    generation: disk.generation,
  });
}
