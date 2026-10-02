import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

/** Fixed errors omit profile contents and process command lines. */
export class ReservationError extends Error {
  constructor(code) {
    super(`Browser profile reservation: ${code}`);
    this.name = 'ReservationError';
    this.code = code;
  }
}

/** PID reuse must not make a dead holder look alive or authorize killing a new process. */
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return inspectIdentity(pid);
  } catch {
    return null;
  }
}

function inspectIdentity(pid) {
  const details = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
    encoding: 'utf8',
    timeout: 1000,
  }).trim();
  const match = /^(.*?)\s+(\S+)$/.exec(details);
  if (!match) throw new ReservationError('PROCESS_IDENTITY_UNAVAILABLE');
  if (match[2].startsWith('Z')) return null;
  return { pid, birth: match[1] };
}

/** Definitive absence is safe; unavailable identity for an existing PID refuses lifecycle completion. */
export function strictProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new ReservationError('PROCESS_IDENTITY_UNAVAILABLE');
  try {
    return inspectIdentity(pid);
  } catch {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return null;
    }
    throw new ReservationError('PROCESS_IDENTITY_UNAVAILABLE');
  }
}

function privateDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new ReservationError('UNSAFE_DIRECTORY');
}

/** Canonicalize injected parents (macOS /var is an alias); refuse a symlink root. */
export function prepareProfileRoot(profilesDir) {
  if (typeof profilesDir !== 'string' || !isAbsolute(profilesDir))
    throw new ReservationError('INVALID_ROOT');
  const requested = resolve(profilesDir);
  privateDirectory(requested);
  const root = realpathSync(requested);
  privateDirectory(join(root, '.reservations'));
  return root;
}

/** Chromium owns this symlink, so never unlink it to force a profile open. */
export function chromiumHolder(profileDir) {
  const lock = join(profileDir, 'SingletonLock');
  let target;
  try {
    target = readlinkSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ReservationError('UNKNOWN_BROWSER_HOLDER');
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname()) throw new ReservationError('UNKNOWN_BROWSER_HOLDER');
  return strictProcessIdentity(Number(match[2]));
}

function readOwner(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error();
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.birth !== 'string' ||
      !owner.birth ||
      !/^[a-f0-9-]{36}$/.test(owner.nonce)
    )
      throw new Error();
    if (owner.phase !== undefined && !['reserved', 'launching', 'running'].includes(owner.phase))
      throw new Error();
    if (owner.browser !== undefined && !validIdentity(owner.browser)) throw new Error();
    if (owner.phase === 'running' && !owner.browser) throw new Error();
    if (owner.phase && owner.phase !== 'running' && owner.browser) throw new Error();
    return owner;
  } catch {
    throw new ReservationError('UNKNOWN_OWNER');
  }
}

function validIdentity(identity) {
  return (
    identity &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.birth === 'string' &&
    identity.birth.length > 0
  );
}

function alive(owner) {
  return strictProcessIdentity(owner.pid)?.birth === owner.birth;
}

function browserStopped(owner) {
  // Legacy stale owners and interrupted launches have no proof that a browser was never spawned.
  if (!owner.phase || owner.phase === 'launching')
    throw new ReservationError('BROWSER_IDENTITY_UNAVAILABLE');
  if (owner.browser && alive(owner.browser)) throw new ReservationError('BROWSER_STILL_RUNNING');
}

/**
 * Reserve before creating or changing profile data. A short recovery guard serializes
 * stale deletion. If that guard crashes, manual repair is required: fail closed rather
 * than recursively stealing a possibly live recovery operation.
 */
export function reserveProfile(profilesDir, profileId) {
  if (typeof profileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profileId))
    throw new ReservationError('INVALID_PROFILE');
  const root = prepareProfileRoot(profilesDir);
  const profileDir = join(root, profileId);
  try {
    const stat = lstatSync(profileDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new ReservationError('UNSAFE_DIRECTORY');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const file = join(root, '.reservations', `${profileId}.json`);
  const guard = join(root, '.reservations', `${profileId}.recovery`);
  const owner = { ...processIdentity(process.pid), nonce: randomUUID(), phase: 'reserved' };
  if (!owner.birth) throw new ReservationError('PROCESS_IDENTITY_UNAVAILABLE');
  // Every acquisition checks this guard, including acquisition after a stale unlink.
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new ReservationError('RECOVERY_BUSY');
    throw error;
  }
  try {
    if (chromiumHolder(profileDir)) throw new ReservationError('BROWSER_STILL_RUNNING');
    let existing = false;
    try {
      lstatSync(file);
      existing = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      const prior = readOwner(file);
      if (alive(prior)) throw new ReservationError('PROFILE_IN_USE');
      browserStopped(prior);
      rmSync(file);
    }
    const descriptor = openSync(file, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(owner));
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(guard, { recursive: true });
  }
  let released = false;
  function ownedRecord() {
    if (released) throw new ReservationError('OWNERSHIP_CHANGED');
    const current = readOwner(file);
    if (current.nonce !== owner.nonce) throw new ReservationError('OWNERSHIP_CHANGED');
    return current;
  }
  function replaceOwner(next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      Object.assign(owner, next);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    profileId,
    profileDir,
    owner,
    createDirectory() {
      privateDirectory(profileDir);
    },
    beginLaunch() {
      const current = ownedRecord();
      if (current.phase !== 'reserved') throw new ReservationError('INVALID_LAUNCH_PHASE');
      replaceOwner({ ...current, phase: 'launching' });
    },
    recordBrowser(identity) {
      const current = ownedRecord();
      if (current.phase !== 'launching') throw new ReservationError('INVALID_LAUNCH_PHASE');
      if (!validIdentity(identity) || !alive(identity))
        throw new ReservationError('BROWSER_IDENTITY_UNAVAILABLE');
      replaceOwner({
        ...current,
        phase: 'running',
        browser: { pid: identity.pid, birth: identity.birth },
      });
    },
    release() {
      if (released) return;
      const current = ownedRecord();
      if (chromiumHolder(profileDir)) throw new ReservationError('BROWSER_STILL_RUNNING');
      browserStopped(current);
      rmSync(file);
      released = true;
    },
  };
}
