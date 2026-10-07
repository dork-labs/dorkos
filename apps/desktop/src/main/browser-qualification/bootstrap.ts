import { app, MessageChannelMain, type UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import {
  DesktopQualificationReplySchema,
  readOriginalDesktopDigest,
  readOriginalDesktopFrame,
  writeOriginalDesktopFrame,
  type DesktopQualificationGrant,
} from '@dorkos/shared/browser-desktop-qualification';
import { resolveDataDirectory } from '../dork-home';

const prefix = 'DORKOS_PRIVATE_DESKTOP_QUALIFICATION ';
let original:
  Readonly<{ grant: DesktopQualificationGrant; nonce: string; current(): boolean }> | undefined;
let used = false;
/** Request-only flag; the genuine parent pipe must separately grant exact owned fixture scope. */
export async function prepareOriginalDesktopQualification(): Promise<void> {
  if (process.env.DORKOS_PRIVATE_DESKTOP_QUALIFICATION !== '1') return;
  if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('DESKTOP_QUALIFICATION_UNAVAILABLE');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('DESKTOP_QUALIFICATION_PARENT_CLOSED'));
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.stdin.once('error', stop);
  app.once('before-quit', stop);
  const expire = setTimeout(
    () => lifetime.abort(new Error('DESKTOP_QUALIFICATION_HANDSHAKE_EXPIRED')),
    10000
  );
  const current = () => lifetime.signal.throwIfAborted();
  try {
    const request = await readOriginalDesktopFrame(process.stdin, lifetime.signal);
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).join(',') !== 'type' ||
      !('type' in request) ||
      request.type !== 'browser-desktop-qualification-request'
    )
      throw new Error('DESKTOP_QUALIFICATION_REQUEST_REFUSED');
    const executable = await realpath(app.getPath('exe'));
    const appPath = await realpath(dirname(dirname(dirname(executable))));
    const home = await realpath(resolveDataDirectory());
    const homeStat = await lstat(home);
    current();
    if (
      !homeStat.isDirectory() ||
      homeStat.isSymbolicLink() ||
      homeStat.uid !== process.getuid?.() ||
      (homeStat.mode & 0o077) !== 0
    )
      throw new Error('DESKTOP_QUALIFICATION_HOME_REFUSED');
    const entry = join(process.resourcesPath, 'app.asar.unpacked', 'dist/server/server-entry.mjs');
    const desktopExecutableSHA256 = await readOriginalDesktopDigest(executable, current);
    const serverEntrySHA256 = await readOriginalDesktopDigest(entry, current);
    const nonce = randomBytes(24).toString('hex');
    // Publish the original receiving duty before the parent can reply reentrantly.
    const reply = readOriginalDesktopFrame(process.stdin, lifetime.signal);
    void reply.catch(() => {});
    let writeFailure: { value: unknown } | undefined;
    try {
      await writeOriginalDesktopFrame(
        process.stdout,
        {
          type: 'browser-desktop-qualification-hello',
          nonce,
          home,
          appPath,
          desktopExecutableSHA256,
          serverEntrySHA256,
        },
        prefix
      );
    } catch (value) {
      writeFailure = { value };
      lifetime.abort(value);
    }
    if (writeFailure) {
      await Promise.allSettled([reply]);
      throw writeFailure.value;
    }
    const accepted = DesktopQualificationReplySchema.parse(await reply);
    current();
    if (
      accepted.nonce !== nonce ||
      accepted.grant.home !== home ||
      accepted.grant.appPath !== appPath ||
      accepted.grant.desktopExecutableSHA256 !== desktopExecutableSHA256 ||
      accepted.grant.serverEntrySHA256 !== serverEntrySHA256
    )
      throw new Error('DESKTOP_QUALIFICATION_SCOPE_REFUSED');
    Object.freeze(accepted.grant.subject.runtimeClass.surface);
    Object.freeze(accepted.grant.subject.runtimeClass);
    const grant = Object.freeze({
      ...accepted.grant,
      subject: Object.freeze(accepted.grant.subject),
    });
    original = Object.freeze({ grant, nonce, current: () => !lifetime.signal.aborted });
  } finally {
    clearTimeout(expire);
  }
}
/** This only selects a receiver; it cannot grant qualification without the transferred original port. */
export function hasOriginalDesktopQualification(): boolean {
  return !!original && !used && original.current();
}

let stopOriginalPort: (() => void) | undefined;
let portFailure: { value: unknown } | undefined;
/** Join the original synchronous port close after the server's independent whole close. */
export async function closeOriginalDesktopQualification(): Promise<void> {
  stopOriginalPort?.();
  if (portFailure) throw portFailure.value;
}
/** The exact child must announce its already-registered private receiver before transfer. */
export function transferOriginalDesktopQualification(child: UtilityProcess): boolean {
  const owner = original;
  if (!owner) return false;
  if (used || !owner.current()) throw new Error('DESKTOP_QUALIFICATION_SCOPE_REFUSED');
  used = true;
  let stopped = false,
    entered = false;
  let closePort: (() => void) | undefined, sendStop: (() => void) | undefined;
  const fail = (value: unknown) => {
    portFailure ??= { value };
  };
  const stop = (notify = true) => {
    if (stopped) return;
    stopped = true;
    try {
      if (notify) sendStop?.();
    } catch (value) {
      fail(value);
    }
    try {
      closePort?.();
    } catch (value) {
      fail(value);
    }
  };
  stopOriginalPort = stop;
  child.once('exit', () => stop(false));
  process.stdin.once('end', () => stop());
  process.stdin.once('close', () => stop());
  process.stdin.once('error', () => stop());
  app.once('before-quit', () => stop());
  child.on('message', (value) => {
    try {
      if (stopped || !owner.current()) return;
      if (
        !value ||
        typeof value !== 'object' ||
        !('type' in value) ||
        value.type !== 'browser-desktop-qualification-receiver-ready'
      )
        return;
      if (entered || Object.keys(value).join(',') !== 'type')
        throw new Error('DESKTOP_QUALIFICATION_RECEIVER_REFUSED');
      entered = true;
      const channel = new MessageChannelMain();
      const parent = channel.port1;
      let disconnected = false;
      parent.once('close', () => {
        disconnected = true;
      });
      const close = parent.close.bind(parent),
        send = parent.postMessage.bind(parent);
      closePort = () => {
        if (!disconnected) close();
      };
      sendStop = () => {
        if (!disconnected) send({ type: 'browser-desktop-qualification-stop', nonce: owner.nonce });
      };
      try {
        parent.start();
        child.postMessage(
          { type: 'browser-desktop-qualification-channel', nonce: owner.nonce, grant: owner.grant },
          [channel.port2]
        );
      } catch (value) {
        fail(value);
        stop();
        try {
          channel.port2.close();
        } catch (cleanup) {
          fail(cleanup);
        }
        throw value;
      }
    } catch (value) {
      fail(value);
      stop();
      child.emit('error', new Error('DESKTOP_QUALIFICATION_TRANSFER_REFUSED'));
    }
  });
  return true;
}
