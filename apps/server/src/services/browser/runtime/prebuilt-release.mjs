import process from 'node:process';
import { URL } from 'node:url';
import { originalInstalledVMDirectory } from './installed-location.mjs';
import { join } from 'node:path';
const releases = new WeakMap(),
  bad = (code) => new Error(code);
export async function inspectOriginalPrebuiltRelease(token) {
  const row = releases.get(token);
  if (!row) throw bad('ORIGINAL_PREBUILT_RELEASE_REQUIRED');
  await row.guard();
  const blank = row.assets.find((asset) => asset.path === join(row.directory, 'blank-profile.raw'));
  return Object.freeze({
    blankProfile: Object.freeze({ path: blank.path, sha256: blank.sha256, bytes: blank.bytes }),
    guard: row.guard,
    assets: Object.freeze(
      row.assets.map((asset) =>
        Object.freeze({ path: asset.path, sha256: asset.sha256, bytes: asset.bytes })
      )
    ),
    directory: row.directory,
    productionAdmitted: false,
  });
}
export async function inspectOriginalBuiltPrebuiltRelease(token) {
  const row = releases.get(token);
  if (!row || !row.built || !row.code) throw bad('ORIGINAL_BUILT_RELEASE_REQUIRED');
  await row.guard();
  await row.codeGuard();
  await row.guard();
  return Object.freeze({
    directory: row.directory,
    executable: row.code.path,
    cdHash: row.code.cdHash,
    guard: async () => {
      await row.guard();
      await row.codeGuard();
      await row.guard();
    },
    assets: Object.freeze(
      [...row.assets, row.code].map((a) =>
        Object.freeze({ path: a.path, sha256: a.sha256, bytes: a.bytes })
      )
    ),
    nativeIdentity: row.nativeIdentity,
    productionAdmitted: false,
  });
}
async function openInstalled(arguments_, privateStage) {
  const descriptors = Object.getOwnPropertyDescriptors(arguments_ ?? {}),
    keys = privateStage ? ['dataHome', 'current', 'authorization'] : ['dataHome', 'current'];
  if (
    Object.keys(descriptors).sort().join(',') !== keys.sort().join(',') ||
    Object.values(descriptors).some((d) => !('value' in d))
  )
    throw bad('INSTALLED_CLOSED_ARGUMENTS');
  const { dataHome, current, authorization } = arguments_;
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    typeof current !== 'function' ||
    current() !== true ||
    (privateStage && authorization !== 'I_AUTHORIZE_PRIVATE_INSTALLED_RELEASE')
  )
    throw bad('INSTALLED_RUNTIME_STAGE');
  // This fixed module is trusted release CODE, packaged alongside DorkOS. It
  // supplies an independent expected publisher anchor, never a candidate's
  // self-asserted TeamIdentifier, a caller object or a mutable receipt.
  const { installedPublisherAnchor: anchor } = await import('./installed-publisher-anchor.mjs');
  if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  if (
    !anchor ||
    anchor.stage !== (privateStage ? 'PRIVATE_INSTALLED_RELEASE' : 'PUBLISHER_INSTALLED_RELEASE') ||
    !Object.isFrozen(anchor) ||
    !anchor.catalogue ||
    !Object.isFrozen(anchor.catalogue) ||
    !/^([a-f0-9]{40})$/.test(anchor.catalogue.cdHash) ||
    !/^[a-f0-9]{64}$/.test(anchor.catalogue.sha256) ||
    !Number.isSafeInteger(anchor.catalogue.bytes) ||
    anchor.catalogue.bytes < 1 ||
    anchor.catalogue.bytes > 1048576 ||
    (!privateStage && !/^[A-Z0-9]{10}$/.test(anchor.teamId))
  )
    throw bad('INSTALLED_PUBLISHER_ANCHOR_REQUIRED');
  const { fileURLToPath } = await import('node:url');
  const directory = privateStage
    ? fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')
    : originalInstalledVMDirectory();
  const {
    captureInstalledAsset,
    guardInstalledAsset,
    originalVerificationHome,
    verifyInstalledSignature,
  } = await import('./installed-verification.mjs');
  const { extractCompiledCatalogue } = await import('./compiled-catalogue.mjs');
  const { readOriginal } = await import('./build-io.mjs');
  const diagnostics = await originalVerificationHome(dataHome, current),
    path = join(directory, 'managed-browser-catalogue.dylib');
  await verifyInstalledSignature({
    path,
    identifier: anchor.catalogue.identifier,
    cdHash: anchor.catalogue.cdHash,
    teamId: anchor.teamId,
    privateStage,
    directory: diagnostics,
    name: 'catalogue',
    current,
  });
  const heldCatalogue = await captureInstalledAsset(path, anchor.catalogue, current);
  const bytes = await readOriginal(path, 1048576);
  await guardInstalledAsset(heldCatalogue, current);
  const catalogue = extractCompiledCatalogue(bytes);
  if (catalogue.stage !== anchor.stage) throw bad('INSTALLED_CATALOGUE_STAGE');
  const assets = [];
  for (const role of catalogue.assets) {
    if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
    assets.push(await captureInstalledAsset(join(directory, role.name), role, current));
  }
  for (const [kind, name] of [
    ['qemu', 'qemu-system-aarch64'],
    ['addon', 'atomic-child.node'],
  ]) {
    const selected = catalogue.code[kind];
    await verifyInstalledSignature({
      path: join(directory, name),
      identifier: selected.identifier,
      cdHash: selected.cdHash,
      teamId: anchor.teamId,
      privateStage,
      hypervisor: kind === 'qemu',
      directory: diagnostics,
      name: kind,
      current,
    });
  }
  const guard = async () => {
    if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
    await guardInstalledAsset(heldCatalogue, current);
    for (const a of assets) await guardInstalledAsset(a, current);
    if (current() !== true) throw bad('INSTALLED_RELEASE_RETIRED');
  };
  await guard();
  const codeAsset = assets.find((a) => a.path === join(directory, 'qemu-system-aarch64')),
    code = Object.freeze({ ...codeAsset, cdHash: catalogue.code.qemu.cdHash });
  const addonAsset = assets.find((a) => a.path === join(directory, 'atomic-child.node'));
  if (!addonAsset) throw bad('INSTALLED_NATIVE_ASSET_REQUIRED');
  const nativeIdentity = Object.freeze({
    sha256: addonAsset.sha256,
    bytes: addonAsset.bytes,
    cdHash: catalogue.code.addon.cdHash,
  });
  const token = Object.freeze(Object.create(null));
  releases.set(token, {
    nativeIdentity,
    directory,
    assets: Object.freeze(
      assets.filter(
        (a) =>
          !['qemu-system-aarch64', 'atomic-child.node'].some((n) => a.path === join(directory, n))
      )
    ),
    guard,
    built: true,
    code,
    codeGuard: guard,
    installed: true,
    catalogue,
    diagnostics,
    current,
  });
  return token;
}
/** App restart creates NEW local capabilities after fresh original publisher,
 * catalogue, asset and native-code verification. No prior token is restored. */
export function openOriginalInstalledPrebuiltRelease(arguments_) {
  return openInstalled(arguments_, false);
}
/** Explicitly separate actual ad-hoc developer packaging controls only. */
export function openOriginalPrivateInstalledPrebuiltRelease(arguments_) {
  return openInstalled(arguments_, true);
}

/** Lifetime fence only; original async installed/native checks remain mandatory. */
export function originalPrebuiltReleaseLifetimeCurrent(token) {
  const row = releases.get(token);
  if (!row || !row.built || typeof row.current !== 'function') return false;
  try {
    return row.current() === true;
  } catch {
    return false;
  }
}
