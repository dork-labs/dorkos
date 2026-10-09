import { Buffer } from 'node:buffer';
import process from 'node:process';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspectOriginalBuiltPrebuiltRelease } from './prebuilt-release.mjs';
import { inspectOriginalNamedProfile } from './named-profile.mjs';
import { encodeSelection, deriveFixedSlot } from './selection.mjs';
import { encode, KIND } from './prebuilt-wire.mjs';
const launches = new WeakMap(),
  fail = (code) => new Error(code);
/** Internal customer launch issuer; no executable/argv/path or JSON descriptor input. */
export async function issueOriginalPrebuiltLaunch({ release, profile, current }) {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    typeof current !== 'function' ||
    current() !== true
  )
    throw fail('PREBUILT_RUNTIME_PLATFORM');
  const image = await inspectOriginalBuiltPrebuiltRelease(release);
  if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  const held = await inspectOriginalNamedProfile(profile);
  if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  await held.guard();
  await image.guard();
  if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  const guard = () => {
    if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  };
  guard();
  const runId = randomBytes(16).toString('hex'),
    nonce = randomBytes(24).toString('hex');
  const selection = Object.freeze({
    v: 2,
    runId,
    nonce,
    dataHome: held.dataHome,
    profileId: held.profileId,
    generation: held.generation,
    dev: held.dev,
    ino: held.ino,
    bytes: held.bytes,
  });
  const fixed = deriveFixedSlot(selection);
  if (fixed.profile !== held.profilePath) throw fail('PREBUILT_PROFILE_SLOT');
  const runs = join(held.dataHome, 'managed-browser/runs');
  guard();
  try {
    await mkdir(runs, { mode: 0o700 });
  } catch (value) {
    if (value?.code !== 'EEXIST') throw value;
  }
  guard();
  const st = await lstat(runs);
  guard();
  const canonical = await realpath(runs);
  guard();
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o777) !== 0o700 ||
    canonical !== runs
  )
    throw fail('PREBUILT_RUN_DIRECTORY');
  await held.guard();
  await image.guard();
  guard();
  await mkdir(fixed.journal, { mode: 0o700 });
  const nativeHome = join(fixed.journal, 'native-owner'),
    vmHome = join(fixed.journal, 'vm-owner');
  for (const directory of [nativeHome, vmHome]) {
    if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
    await mkdir(directory, { mode: 0o700 });
  }
  await held.guard();
  await image.guard();
  if (current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  const command = Object.freeze({
    executable: image.executable,
    argv: Object.freeze([]),
    cwd: vmHome,
    home: nativeHome,
    env: Object.freeze([`HOME=${vmHome}`, `TMPDIR=${vmHome}`, 'PATH=/usr/bin:/bin', 'LC_ALL=C']),
  });
  const binding = Object.freeze({
    stage: 'PRIVATE_PREBUILT_RUNTIME_PROTOTYPE',
    runId,
    nonce,
    profileId: held.profileId,
    generation: held.generation,
    productionAdmitted: false,
    profileDurabilityQualified: false,
    preExecutableEntryAttested: false,
  });
  const startup = Object.freeze([
    encode(true, KIND.INIT, 1, Buffer.from(runId + nonce)),
    encode(true, KIND.SELECT, 2, encodeSelection(selection)),
  ]);
  const token = Object.freeze(Object.create(null));
  launches.set(token, {
    used: false,
    release,
    profile,
    image,
    held,
    current,
    command,
    binding,
    scope: Object.freeze({ runId, nonce }),
    startup,
  });
  return token;
}
/** Same module-instance issuance consumed exactly once, after real FS guards. */
export async function inspectOriginalPrebuiltLaunch(token) {
  const row = launches.get(token);
  if (!row || row.used) throw fail('ORIGINAL_PREBUILT_LAUNCH_REQUIRED');
  row.used = true;
  await row.held.guard();
  await row.image.guard();
  if (row.current() !== true) throw fail('PREBUILT_RUNTIME_RETIRED');
  return Object.freeze({
    command: row.command,
    binding: row.binding,
    scope: row.scope,
    cdHash: row.image.cdHash,
    nativePath: join(row.image.directory, 'atomic-child.node'),
    nativeIdentity: row.image.nativeIdentity,
    current: row.current,
    assets: Object.freeze(row.image.assets.filter((a) => !a.path.endsWith('/blank-profile.raw'))),
    startup: Object.freeze(row.startup.map((b) => Uint8Array.from(b))),
  });
}
export function originalPrebuiltScope(token) {
  const row = launches.get(token);
  if (!row) throw fail('ORIGINAL_PREBUILT_LAUNCH_REQUIRED');
  return row.scope;
}
