import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  inspectOriginalBuiltPrebuiltRelease,
  originalPrebuiltReleaseLifetimeCurrent,
} from './prebuilt-release.mjs';
const subjects = new WeakMap();
/** Original installed/native build capability is required; this identifies the
 * verified bank and policy revision, never an accepted production-mode grant. */
export async function issueOriginalVMRuntimeSubject(release, policyRevision) {
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 0)
    throw new Error('VM_RUNTIME_POLICY_REVISION');
  const selected = await inspectOriginalBuiltPrebuiltRelease(release);
  await selected.guard();
  const assets = selected.assets
    .map((row) => Object.freeze({ role: basename(row.path), sha256: row.sha256, bytes: row.bytes }))
    .sort((a, b) => a.role.localeCompare(b.role));
  if (new Set(assets.map((row) => row.role)).size !== assets.length)
    throw new Error('VM_RUNTIME_ASSET_ROLES');
  if (
    !selected.nativeIdentity ||
    !/^[a-f0-9]{64}$/.test(selected.nativeIdentity.sha256) ||
    !/^[a-f0-9]{40}$/.test(selected.nativeIdentity.cdHash)
  )
    throw new Error('VM_RUNTIME_NATIVE_BANK_REQUIRED');
  const descriptor = Object.freeze({
    nativeIdentity: selected.nativeIdentity,
    backend: 'qemu-hvf',
    hostPlatform: 'darwin-arm64',
    guestPlatform: 'linux-arm64',
    codeCDHash: selected.cdHash,
    assets: Object.freeze(assets),
  });
  const runtimeIdentity = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  if (!originalPrebuiltReleaseLifetimeCurrent(release))
    throw new Error('VM_RUNTIME_RELEASE_RETIRED');
  const token = Object.freeze(Object.create(null));
  subjects.set(token, {
    release,
    descriptor,
    binding: Object.freeze({ runtimeIdentity, policyRevision }),
  });
  return token;
}
export function inspectOriginalVMRuntimeSubject(token, release) {
  const row = subjects.get(token);
  if (!row || row.release !== release || !originalPrebuiltReleaseLifetimeCurrent(release))
    throw new Error('VM_ORIGINAL_RUNTIME_SUBJECT_REQUIRED');
  return Object.freeze({
    binding: row.binding,
    descriptor: row.descriptor,
    current: () => originalPrebuiltReleaseLifetimeCurrent(release),
  });
}
