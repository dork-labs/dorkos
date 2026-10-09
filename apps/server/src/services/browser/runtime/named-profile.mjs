import { Buffer } from 'node:buffer';
import process from 'node:process';
import { open, realpath, lstat, mkdir, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { inspectOriginalPrebuiltRelease } from './prebuilt-release.mjs';
const stores = new WeakMap(),
  profiles = new WeakMap(),
  uncertainAcquisitions = new Set();
const fail = (code) => new Error(code);
const MIN = 64n * 1024n * 1024n,
  MAX = 16n * 1024n * 1024n * 1024n;
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC;
const shape = (st) =>
  Object.freeze({
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    mode: st.mode,
    nlink: st.nlink,
    size: st.size,
  });
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'].every((k) => a[k] === b[k]);
// Creating descendants changes directory nlink/size without changing authority.
const sameDirectory = (a, b) => ['dev', 'ino', 'uid', 'mode'].every((k) => a[k] === b[k]);
const privateDir = (st) =>
  st.isDirectory() && st.uid === BigInt(process.geteuid()) && (st.mode & 0o777n) === 0o700n;
const privateFile = (st) =>
  st.isFile() &&
  st.uid === BigInt(process.geteuid()) &&
  (st.mode & 0o777n) === 0o600n &&
  st.nlink === 1n &&
  st.size >= MIN &&
  st.size <= MAX;
const canonical = (value) =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  value.length > 1 &&
  Buffer.byteLength(value) <= 768 &&
  posix.normalize(value) === value &&
  !value.endsWith('/') &&
  !/[\0\r\n,]/.test(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
const ownFields = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail('PROFILE_CLOSED_ARGUMENTS');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).sort().join(',') !== keys.slice().sort().join(',') ||
    Object.values(descriptors).some((d) => !('value' in d))
  )
    throw fail('PROFILE_CLOSED_ARGUMENTS');
  return Object.fromEntries(keys.map((k) => [k, descriptors[k].value]));
};
async function closeAll(handles, first, recordUncertain) {
  for (const handle of handles) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (value) {
      first ??= { value };
      if (recordUncertain) recordUncertain({ handle, value });
    }
  }
  return first;
}
async function exactDirectory(
  path,
  recordUncertain = (record) => uncertainAcquisitions.add(record)
) {
  if (!canonical(path)) throw fail('PROFILE_CANONICAL_DIRECTORY');
  const held = [];
  let first;
  try {
    // Every component is acquired nofollow before any private descendant entry.
    // These held/path comparisons are cooperative namespace guards, not ABA proof.
    let name = '';
    for (const part of path.split('/').slice(1)) {
      name += '/' + part;
      const handle = await open(name, flags | constants.O_DIRECTORY);
      held.push(handle);
      const st = await handle.stat({ bigint: true });
      if (!st.isDirectory()) throw fail('PROFILE_DIRECTORY_TYPE');
      if (!sameDirectory(shape(st), shape(await lstat(name, { bigint: true }))))
        throw fail('PROFILE_DIRECTORY_CHANGED');
    }
    const handle = held.at(-1),
      st = await handle.stat({ bigint: true });
    if (!privateDir(st)) throw fail('PROFILE_PRIVATE_DIRECTORY');
    held.pop();
    first = await closeAll(held.splice(0), first, recordUncertain);
    if (first) {
      await closeAll([handle], first, recordUncertain);
      throw first.value;
    }
    return { handle, path, identity: shape(st) };
  } catch (value) {
    first ??= { value };
    first = await closeAll(held, first, recordUncertain);
    throw first.value;
  }
}
async function checkDirectory(directory) {
  const st = await directory.handle.stat({ bigint: true });
  if (
    !privateDir(st) ||
    !sameDirectory(shape(st), directory.identity) ||
    !sameDirectory(shape(await lstat(directory.path, { bigint: true })), directory.identity)
  )
    throw fail('PROFILE_DIRECTORY_CHANGED');
}
/** Internal runtime seam: only resolve DorkOS's original data home here. It
 * returns filesystem custody, never launch/profile/closure authority. */
export async function openOriginalManagedProfileStore(dataHome) {
  if (!canonical(dataHome) || (await realpath(dataHome)) !== dataHome)
    throw fail('PROFILE_DATA_HOME');
  const original = await exactDirectory(dataHome),
    token = Object.freeze(Object.create(null));
  stores.set(token, {
    original,
    retired: false,
    retirement: null,
    pending: new Set(),
    children: new Set(),
    uncertain: new Set(),
    firstCleanup: null,
  });
  return token;
}
export async function retireOriginalManagedProfileStore(token) {
  const state = stores.get(token);
  if (!state) throw fail('ORIGINAL_PROFILE_STORE_REQUIRED');
  if (state.retirement) return state.retirement;
  state.retired = true;
  state.retirement = (async () => {
    await Promise.allSettled([...state.pending]);
    const rows = await Promise.allSettled(
      [...state.children].map((token) => retireOriginalNamedProfile(token))
    );
    let first = state.firstCleanup;
    for (const row of rows) if (row.status === 'rejected') first ??= { value: row.reason };
    first = await closeAll([state.original.handle], first);
    if (first) throw first.value;
  })();
  state.retirement.catch(() => {});
  return state.retirement;
}
async function childDirectory(parent, name, guard, recordUncertain) {
  guard();
  await checkDirectory(parent);
  guard();
  const path = parent.path + '/' + name;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (value) {
    if (value?.code !== 'EEXIST') throw value;
  }
  guard();
  const directory = await exactDirectory(path, recordUncertain);
  try {
    guard();
    await checkDirectory(parent);
    guard();
    return directory;
  } catch (value) {
    await closeAll([directory.handle], { value }, recordUncertain);
    throw value;
  }
}
async function currentProfile(state) {
  if (state.retired) throw fail('PROFILE_RETIRED');
  state.guard();
  await checkDirectory(state.directory);
  if (state.retired) throw fail('PROFILE_RETIRED');
  state.guard();
  const actual = await state.handle.stat({ bigint: true });
  if (state.retired) throw fail('PROFILE_RETIRED');
  state.guard();
  if (
    !privateFile(actual) ||
    !same(shape(actual), state.identity) ||
    !same(shape(await lstat(state.path, { bigint: true })), state.identity)
  )
    throw fail('ORIGINAL_PROFILE_CHANGED');
  if (state.retired) throw fail('PROFILE_RETIRED');
  state.guard();
  return actual;
}
async function copyBlank(original, profilePath, directory, guard, recordUncertain) {
  const temp = directory.path + '/.profile-new-' + randomBytes(16).toString('hex');
  let source,
    target,
    first,
    tempUnlinkEntered = false,
    originalIdentity;
  try {
    guard();
    source = await open(original.path, flags);
    guard();
    const st = await source.stat({ bigint: true });
    originalIdentity = shape(st);
    if (
      !st.isFile() ||
      st.uid !== BigInt(process.geteuid()) ||
      st.nlink !== 1n ||
      st.size !== BigInt(original.bytes) ||
      st.size < MIN ||
      st.size > MAX
    )
      throw fail('RELEASE_BLANK_PROFILE_IDENTITY');
    guard();
    target = await open(
      temp,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_CLOEXEC,
      0o600
    );
    guard();
    const hash = createHash('sha256'),
      bank = Buffer.alloc(65536);
    let position = 0;
    while (BigInt(position) < st.size) {
      guard();
      const row = await source.read(
        bank,
        0,
        Math.min(bank.length, Number(st.size - BigInt(position))),
        position
      );
      guard();
      if (!Number.isSafeInteger(row.bytesRead) || row.bytesRead <= 0)
        throw fail('RELEASE_BLANK_PROFILE_TRUNCATED');
      hash.update(bank.subarray(0, row.bytesRead));
      let offset = 0;
      while (offset < row.bytesRead) {
        guard();
        const written = await target.write(bank, offset, row.bytesRead - offset, position + offset);
        guard();
        if (
          !Number.isSafeInteger(written.bytesWritten) ||
          written.bytesWritten <= 0 ||
          written.bytesWritten > row.bytesRead - offset
        )
          throw fail('PROFILE_PARTIAL_WRITE');
        offset += written.bytesWritten;
      }
      position += row.bytesRead;
    }
    if (hash.digest('hex') !== original.sha256) throw fail('RELEASE_BLANK_PROFILE_HASH');
    if (
      !same(shape(await source.stat({ bigint: true })), originalIdentity) ||
      !same(shape(await lstat(original.path, { bigint: true })), originalIdentity)
    )
      throw fail('RELEASE_BLANK_PROFILE_CHANGED');
    guard();
    await target.sync();
    guard();
    await checkDirectory(directory);
    guard();
    // link is atomic no-overwrite. An incomplete temporary file is never named
    // profile.raw; the published FD remains the same original inode.
    await link(temp, profilePath);
    guard();
    tempUnlinkEntered = true;
    await unlink(temp);
    guard();
    await directory.handle.sync();
    guard();
    const observed = await target.stat({ bigint: true });
    if (!privateFile(observed)) throw fail('PROFILE_PUBLISHED_IDENTITY');
  } catch (value) {
    first = { value };
  } finally {
    first = await closeAll([source], first, recordUncertain);
    if (first) {
      first = await closeAll([target], first, recordUncertain);
      target = null;
    }
    // Retiring after publication must not leave a second hard link that makes
    // an otherwise complete generation permanently refuse on next admission.
    // An entered unlink is never retried after an ambiguous failure.
    if (!tempUnlinkEntered) {
      try {
        await unlink(temp);
      } catch (value) {
        if (value?.code !== 'ENOENT') {
          first ??= { value };
          recordUncertain({ path: temp, value });
        }
      }
    }
  }
  if (first) throw first.value;
  return target;
}
/** Existing generation or exclusive original creation; no generic pathname,
 * caller argv, borrowed FD, or JSON authority is accepted. */
export async function issueOriginalNamedProfile(arguments_) {
  const { store, release, profileId, generation, current } = ownFields(arguments_, [
    'store',
    'release',
    'profileId',
    'generation',
    'current',
  ]);
  const root = stores.get(store);
  if (!root || root.retired || !id(profileId) || !id(generation) || typeof current !== 'function')
    throw fail('ORIGINAL_PROFILE_ISSUER_ARGUMENTS');
  let selected;
  const recordUncertain = (record) => {
    root.uncertain.add(record);
    root.firstCleanup ??= { value: record.value };
  };
  const guard = () => {
    if (root.firstCleanup) throw root.firstCleanup.value;
    if (root.retired) throw fail('PROFILE_STORE_RETIRED');
    if (current() !== true) throw fail('PROFILE_CURRENT_REFUSED');
    if (root.retired) throw fail('PROFILE_STORE_RETIRED');
  };
  const job = Promise.resolve().then(async () => {
    const directories = [];
    let handle,
      first,
      transferred = false;
    try {
      guard();
      selected = await inspectOriginalPrebuiltRelease(release);
      guard();
      await selected.guard();
      guard();
      await checkDirectory(root.original);
      guard();
      let parent = root.original;
      for (const name of ['managed-browser', 'profiles', profileId, generation]) {
        const next = await childDirectory(parent, name, guard, recordUncertain);
        directories.push(next);
        parent = next;
      }
      const path = parent.path + '/profile.raw';
      try {
        guard();
        handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CLOEXEC);
        guard();
      } catch (value) {
        if (value?.code !== 'ENOENT') throw value;
        handle = await copyBlank(selected.blankProfile, path, parent, guard, recordUncertain);
      }
      guard();
      const st = await handle.stat({ bigint: true });
      if (
        !privateFile(st) ||
        st.size !== BigInt(selected.blankProfile.bytes) ||
        st.dev !== parent.identity.dev
      )
        throw fail('PROFILE_PRIVATE_ORIGINAL');
      const state = {
        handle,
        directory: parent,
        path,
        dataHome: root.original.path,
        profileId,
        generation,
        identity: shape(st),
        guard,
        issued: false,
        retired: false,
        retirement: null,
        pending: new Set(),
        children: new Set(),
        parents: directories.slice(0, -1),
      };
      await currentProfile(state);
      guard();
      await selected.guard();
      guard();
      const token = Object.freeze(Object.create(null));
      state.store = root;
      state.token = token;
      profiles.set(token, state);
      root.children.add(token);
      transferred = true;
      return token;
    } catch (value) {
      first = { value };
    } finally {
      if (!transferred)
        first = await closeAll(
          [handle, ...directories.map((d) => d.handle).reverse()],
          first,
          recordUncertain
        );
    }
    if (first) throw first.value;
  });
  root.pending.add(job);
  job.then(
    () => root.pending.delete(job),
    () => root.pending.delete(job)
  );
  return job;
}
async function ownedProfileOperation(state, operation) {
  if (state.retired) throw fail('PROFILE_RETIRED');
  const job = Promise.resolve().then(operation);
  state.pending.add(job);
  job.then(
    () => state.pending.delete(job),
    () => state.pending.delete(job)
  );
  return job;
}
/** Consumed only by the fixed prebuilt launch issuer. Observation fields are
 * not authority if serialized; no descriptor is exposed. */
export async function inspectOriginalNamedProfile(token) {
  const state = profiles.get(token);
  if (!state || state.issued || state.retired) throw fail('ORIGINAL_NAMED_PROFILE_REQUIRED');
  state.issued = true;
  return ownedProfileOperation(state, async () => {
    await currentProfile(state);
    if (state.retired) throw fail('PROFILE_RETIRED');
    return Object.freeze({
      dataHome: state.dataHome,
      profileId: state.profileId,
      generation: state.generation,
      profilePath: state.path,
      dev: String(state.identity.dev),
      ino: String(state.identity.ino),
      bytes: String(state.identity.size),
      guard: () => ownedProfileOperation(state, () => currentProfile(state)),
    });
  });
}
export async function retireOriginalNamedProfile(token) {
  const state = profiles.get(token);
  if (!state) throw fail('ORIGINAL_NAMED_PROFILE_REQUIRED');
  if (state.retirement) return state.retirement;
  state.retired = true;
  state.retirement = (async () => {
    await Promise.allSettled([...state.pending]);
    const first = await closeAll(
      [state.handle, state.directory.handle, ...state.parents.map((p) => p.handle).reverse()],
      undefined,
      (record) => {
        state.store.uncertain.add(record);
        state.store.firstCleanup ??= { value: record.value };
      }
    );
    if (!first) state.store.children.delete(state.token);
    if (first) throw first.value;
  })();
  state.retirement.catch(() => {});
  return state.retirement;
}
