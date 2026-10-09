import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  DesktopQualificationGrantSchema,
  readOriginalDesktopDigest,
} from '@dorkos/shared/browser-desktop-qualification';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import {
  BrowserModeSubjectSchema,
  createPrivateBrowserQualification,
  type PrivateBrowserQualification,
} from './accepted-mode.js';

interface OriginalPort {
  on(event: string, listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
}
interface OriginalParentPort {
  postMessage(value: unknown): void;
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: OriginalPort[] }) => void
  ): unknown;
}
/** Actual UtilityProcess port only. An inherited flag/nonce/JSON scope cannot mint a capability. */
export function readOriginalDesktopQualification():
  (() => Promise<PrivateBrowserQualification | undefined>) | undefined {
  if (process.env.DORKOS_BROWSER_DESKTOP_QUALIFICATION_CHANNEL !== '1') return;
  const parent = (process as typeof process & { parentPort?: OriginalParentPort }).parentPort;
  if (!parent || typeof parent.on !== 'function')
    throw new Error('DESKTOP_QUALIFICATION_PARENT_REQUIRED');
  const on = parent.on.bind(parent),
    sendReady = parent.postMessage.bind(parent);
  const entry = process.argv[1];
  const home = resolveDorkHome();
  let stopped = false,
    first: { value: unknown } | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
    stopped = true;
  };
  const check = () => {
    if (first) throw first.value;
    if (stopped) throw new Error('DESKTOP_QUALIFICATION_PARENT_CLOSED');
  };
  let entered = false;
  let resolve!: (value: PrivateBrowserQualification) => void, reject!: (value: unknown) => void;
  const retained = new Promise<PrivateBrowserQualification>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void retained.catch(() => {});
  const deadline = setTimeout(() => {
    const value = new Error('DESKTOP_QUALIFICATION_CHANNEL_EXPIRED');
    fail(value);
    reject(value);
  }, 10000);
  on('message', (event) => {
    if (stopped || first) return;
    if (
      !event.data ||
      typeof event.data !== 'object' ||
      !('type' in event.data) ||
      event.data.type !== 'browser-desktop-qualification-channel'
    )
      return;
    if (entered) {
      fail(new Error('DESKTOP_QUALIFICATION_DUPLICATE'));
      return;
    }
    entered = true;
    clearTimeout(deadline);
    let closePort: (() => void) | undefined;
    const original = Promise.resolve().then(async () => {
      check();
      const message = event.data as { nonce?: unknown; grant?: unknown };
      if (
        typeof message.nonce !== 'string' ||
        !/^[a-f0-9]{48}$/u.test(message.nonce) ||
        event.ports.length !== 1
      )
        throw new Error('DESKTOP_QUALIFICATION_CHANNEL_REFUSED');
      const nonce = message.nonce;
      const port = event.ports[0]!;
      const listen = port.on.bind(port),
        start = port.start.bind(port),
        close = port.close.bind(port);
      closePort = close;
      listen('close', () => {
        stopped = true;
      });
      listen('message', (value) => {
        const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
        if (
          data &&
          typeof data === 'object' &&
          'type' in data &&
          data.type === 'browser-desktop-qualification-stop' &&
          'nonce' in data &&
          data.nonce === nonce
        ) {
          stopped = true;
          try {
            close();
          } catch (value) {
            fail(value);
          }
        } else fail(new Error('DESKTOP_QUALIFICATION_MESSAGE_REFUSED'));
      });
      start();
      const grant = DesktopQualificationGrantSchema.parse(message.grant);
      const subject = BrowserModeSubjectSchema.parse(grant.subject);
      check();
      if (
        (await realpath(home)) !== home ||
        grant.home !== home ||
        entry !==
          join(
            grant.appPath,
            'Contents/Resources/app.asar.unpacked/dist/server/server-entry.mjs'
          ) ||
        (await readOriginalDesktopDigest(entry, check)) !== grant.serverEntrySHA256
      )
        throw new Error('DESKTOP_QUALIFICATION_SCOPE_REFUSED');
      check();
      return createPrivateBrowserQualification({
        current: () => !stopped && !first,
        check: (actual) =>
          JSON.stringify(BrowserModeSubjectSchema.parse(actual)) === JSON.stringify(subject),
      });
    });
    void original.then(resolve, (value) => {
      fail(value);
      try {
        closePort?.();
      } catch (cleanup) {
        fail(cleanup);
      }
      reject(first ? first.value : value);
    });
  });
  try {
    sendReady({ type: 'browser-desktop-qualification-receiver-ready' });
  } catch (value) {
    clearTimeout(deadline);
    fail(value);
    reject(value);
  }
  return async () => {
    check();
    const qualification = await retained;
    check();
    return qualification;
  };
}
