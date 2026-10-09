import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import {
  ownDirectory,
  assertDirectory,
  type OwnedDirectory,
} from '../../profiles/owned-directory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { BrowserContext, ChromiumBrowser, BrowserType } from 'playwright-core';
import { parseRuntimeDescriptor, type BrowserRuntimeDescriptor } from '../../runtime-descriptor.js';
import { verifiedLibrary } from '../public-library.js';
import { NativeIdentitySchema, type NativeIdentity } from './native-observation.js';
import { createSupervisorNativeCohort } from './supervisor-native-cohort.js';

type SDK = BrowserType<ChromiumBrowser>;
type Plan = {
  check(): void;
  native: BrowserRuntimeDescriptor;
  candidate: string;
  sdk: SDK;
  identity: NativeIdentity;
};
const plans = new WeakMap<object, Plan>();
const retained = new Set<object>();
const complete = NativeIdentitySchema.shape.metadata.unwrap().required();
const readOriginalIdentity = async () => {
  const original = navigator as Navigator & {
    userAgentData?: {
      toJSON(): Record<string, unknown>;
      getHighEntropyValues(values: string[]): Promise<Record<string, unknown>>;
    };
  };
  const data = original.userAgentData;
  return {
    userAgent: original.userAgent,
    appVersion: original.appVersion,
    platform: original.platform,
    secureContext: self.isSecureContext,
    metadata: data
      ? {
          ...data.toJSON(),
          ...(await data.getHighEntropyValues([
            'architecture',
            'bitness',
            'fullVersionList',
            'model',
            'platformVersion',
            'uaFullVersion',
            'wow64',
            'formFactors',
          ])),
        }
      : null,
  };
};

/** A read-only descriptor projection conveys no launch authority. */
export function nativeRuntimeForSupervisorIdentity(plan: object): BrowserRuntimeDescriptor {
  const original = plans.get(plan);
  if (!original) throw new Error('SUPERVISOR_NATIVE_PLAN_REFUSED');
  original.check();
  return structuredClone(original.native);
}

/** One genuine observed/closed baseline, bound to exact SDK, executable and identity policy.
 * Reserve before any callback. JSON/copy/reuse and a different SDK never authorize launch.
 */
export function consumeSupervisorNativeIdentity(
  plan: object,
  candidate: BrowserRuntimeDescriptor,
  sdk: SDK
) {
  const original = plans.get(plan);
  if (!original || original.sdk !== sdk) throw new Error('SUPERVISOR_NATIVE_PLAN_REFUSED');
  plans.delete(plan); // Reserve before descriptor parsing can invoke original/caller getters.
  if (original.candidate !== JSON.stringify(parseRuntimeDescriptor(candidate)))
    throw new Error('SUPERVISOR_NATIVE_PLAN_REFUSED');
  original.check();
  const identity = structuredClone(original.identity);
  const metadata = complete.parse(identity.metadata);
  const userAgent = identity.userAgent.replace(/\bHeadlessChrome\//, 'Chrome/');
  const { uaFullVersion, ...rest } = metadata;
  return Object.freeze({
    // Private observation projection only; it cannot recreate the consumed launch lease.
    nativeIdentity: structuredClone(identity),
    userAgent,
    payload: Object.freeze({
      userAgent,
      platform: identity.platform,
      userAgentMetadata: Object.freeze({ ...rest, fullVersion: uaFullVersion }),
    }),
  });
}

/** Supervisor-private native producer. Its own original HTTP loopback document, empty profile
 * and verified native SDK produce metadata; callers supply no URL, UA, metadata or SDK factory.
 * This is launch preparation, not context-matrix qualification or public mode availability.
 */
export function createSupervisorNativeIdentity(
  options: Readonly<{
    nativeRuntime: BrowserRuntimeDescriptor;
    candidateRuntime: BrowserRuntimeDescriptor;
    artifact: Readonly<{ path: string; sha256: string }>;
    /** Original supervisor cancellation fence only; true establishes no identity facts. */
    isAdmissionCurrent?: () => boolean;
  }>
) {
  const admit = options.isAdmissionCurrent?.bind(options);
  const native = parseRuntimeDescriptor(options.nativeRuntime);
  const candidate = parseRuntimeDescriptor(options.candidateRuntime);
  if (
    native.identity.mode !== 'native' ||
    candidate.identity.mode !== 'chrome-compatible' ||
    native.identity.policyRevision !== candidate.identity.policyRevision ||
    JSON.stringify(native.library) !== JSON.stringify(candidate.library) ||
    JSON.stringify(native.executable) !== JSON.stringify(candidate.executable) ||
    native.executable.platform !== 'darwin' ||
    native.executable.arch !== 'arm64' ||
    native.executable.version !== '153.0.8010.12'
  )
    throw new Error('SUPERVISOR_NATIVE_BINDING_REFUSED');
  const binding = JSON.stringify({ native, candidate });
  const artifact = Object.freeze({ ...options.artifact });
  const closedAdmission = new Error('SUPERVISOR_NATIVE_ADMISSION_CLOSED');
  const work = new Set<Promise<unknown>>();
  const sockets = new Map<Socket, { closed: Promise<void>; destroy(): void }>();
  let first: Readonly<{ value: unknown }> | undefined;
  let stopped = false,
    entered = false,
    ready = false,
    issued = false;
  let opening: Promise<object> | undefined, closing: Promise<void> | undefined;
  let rawProfile: string | undefined, profile: string | undefined;
  let directory: OwnedDirectory | undefined;
  let context: BrowserContext | undefined, sdk: SDK | undefined;
  let launchOriginal: SDK['launchPersistentContext'] | undefined;
  let contextCloseOriginal: (() => Promise<void>) | undefined;
  let nativeEntered = false,
    nativeCaptured: Promise<void> | undefined;
  let profileClosed = false,
    removed = false;
  let sdkClose: Promise<void> | undefined, removal: Promise<void> | undefined;
  let server: Server | undefined, listening: Promise<void> | undefined;
  let receiverClose: Promise<void> | undefined;
  let receiverStopping = false;
  let identity: NativeIdentity | undefined;
  const note = (value: unknown) => {
    if (value !== closedAdmission) first ??= { value };
  };
  const checkFailure = () => {
    if (first || stopped) throw first ? first.value : closedAdmission;
  };
  const guard = () => {
    if (admit && admit() !== true) throw closedAdmission;
    checkFailure();
    if (
      JSON.stringify({
        native: parseRuntimeDescriptor(options.nativeRuntime),
        candidate: parseRuntimeDescriptor(options.candidateRuntime),
      }) !== binding
    )
      throw new Error('SUPERVISOR_NATIVE_BINDING_CHANGED');
    checkFailure();
  };
  const track = <T>(producer: () => Promise<T> | T, returned?: (value: T) => void): Promise<T> => {
    const original = Promise.resolve().then(producer);
    work.add(original);
    void original.then(
      (value) => {
        try {
          returned?.(value);
        } catch (value) {
          note(value);
        }
        work.delete(original);
      },
      (value) => {
        note(value);
        work.delete(original);
      }
    );
    return original;
  };
  const cohort = createSupervisorNativeCohort(artifact, (_label, producer) => track(producer));
  const remove = () => {
    if (!directory || !profile || (nativeEntered && !profileClosed)) return undefined;
    return (removal ??= track(
      () => {
        assertDirectory(directory!);
        return rm(directory!.path, { recursive: true, force: false });
      },
      () => {
        removed = true;
      }
    ));
  };
  const closeSDK = () => {
    if (!context) return undefined;
    return (sdkClose ??= track(async () => {
      let primary: Readonly<{ value: unknown }> | undefined;
      const retain = (value: unknown) => {
        primary ??= { value };
        note(value);
      };
      try {
        await nativeCaptured;
        await cohort.beforeOriginalClose();
      } catch (value) {
        retain(value);
      }
      try {
        if (!contextCloseOriginal) throw new Error('SUPERVISOR_NATIVE_CLOSE_UNCAPTURED');
        await contextCloseOriginal();
      } catch (value) {
        retain(value);
      }
      try {
        await cohort.afterOriginalClose();
      } catch (value) {
        retain(value);
      }
      if (primary) throw primary.value;
      profileClosed = true;
      await remove();
    }));
  };
  const closeReceiver = () => {
    if (!server) return undefined;
    return (receiverClose ??= track(async () => {
      receiverStopping = true;
      // Original listen return must join even when close entered before callback return.
      await Promise.allSettled(listening ? [listening] : []);
      const outcomes: Promise<unknown>[] = [];
      for (const original of sockets.values()) {
        try {
          original.destroy();
        } catch (value) {
          note(value);
        }
        outcomes.push(original.closed);
      }
      const originalServer = server!;
      outcomes.push(
        new Promise<void>((resolve, reject) => {
          try {
            if (!originalServer.listening) {
              resolve();
              return;
            }
            originalServer.close((error) => (error === undefined ? resolve() : reject(error)));
          } catch (value) {
            reject(value);
          }
        })
      );
      const results = await Promise.allSettled(outcomes);
      for (const result of results) if (result.status === 'rejected') note(result.reason);
      if (first) throw first.value;
    }));
  };
  const close = (): Promise<void> => {
    stopped = true;
    ready = false;
    return (closing ??= Promise.resolve().then(async () => {
      for (;;) {
        void closeSDK()?.catch(note);
        void remove()?.catch(note);
        void closeReceiver()?.catch(note);
        const pending = [...work];
        if (!pending.length) break;
        await Promise.allSettled(pending);
      }
      if (first) throw first.value;
      if ((profile && !removed) || (nativeEntered && !profileClosed))
        throw new Error('SUPERVISOR_NATIVE_RETURN_UNVERIFIED');
      retained.delete(owner);
    }));
  };
  const owner = Object.freeze({
    prepare(): Promise<object> {
      if (entered || stopped) return Promise.reject(closedAdmission);
      entered = true;
      opening = track(async () => {
        try {
          guard();
          sdk = await track(() => {
            guard();
            return verifiedLibrary(native);
          });
          guard();
          const launchMethod = sdk.launchPersistentContext;
          if (typeof launchMethod !== 'function')
            throw new Error('SUPERVISOR_NATIVE_SDK_UNAVAILABLE');
          launchOriginal = launchMethod.bind(sdk);
          guard();
          rawProfile = await track(
            () => {
              guard();
              return mkdtemp(join(tmpdir(), 'supervisor-native-identity-'));
            },
            (value) => {
              rawProfile = value;
              const raw = lstatSync(value);
              if (!raw.isDirectory() || raw.isSymbolicLink())
                throw new Error('SUPERVISOR_NATIVE_PROFILE_UNOWNED');
              const acquired = ownDirectory(realpathSync(value));
              if (acquired.dev !== raw.dev || acquired.ino !== raw.ino)
                throw new Error('SUPERVISOR_NATIVE_PROFILE_CHANGED');
              directory = acquired;
              profile = acquired.path;
            }
          );
          guard();
          profile = await track(
            () => {
              guard();
              return realpath(rawProfile!);
            },
            (value) => {
              if (!directory || value !== directory.path)
                throw new Error('SUPERVISOR_NATIVE_PROFILE_CHANGED');
              assertDirectory(directory);
              profile = value;
            }
          );
          guard();
          const token = randomBytes(24).toString('base64url');
          let observedUA: string | undefined,
            requests = 0;
          server = createServer((request, response) => {
            try {
              guard();
              if (
                !originalURL ||
                request.method !== 'GET' ||
                request.url !== '/' + token ||
                request.socket.remoteAddress !== '127.0.0.1' ||
                ++requests !== 1 ||
                typeof request.headers['user-agent'] !== 'string'
              )
                throw new Error('SUPERVISOR_NATIVE_RECEIVER_REFUSED');
              observedUA = request.headers['user-agent'];
              response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': String(
                  Buffer.byteLength(
                    '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body>'
                  )
                ),
                Connection: 'close',
              });
              response.end(
                '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body>'
              );
            } catch (value) {
              note(value);
              try {
                response.destroy();
              } catch (value) {
                note(value);
              }
            }
          });
          // Original Node admission caps simultaneous accepted sockets before connection events.
          server.maxConnections = 16;
          server.on('connection', (socket) => {
            let returned!: () => void;
            const closed = new Promise<void>((resolve) => {
              returned = resolve;
            });
            const destroy = socket.destroy.bind(socket);
            sockets.set(socket, {
              closed,
              destroy: () => {
                destroy();
              },
            });
            socket.once('close', () => {
              returned();
            });
            void closed.then(() => {
              sockets.delete(socket);
            });
            socket.on('error', note);
            if (stopped || receiverStopping) destroy();
          });
          server.on('error', note);
          listening = track(
            () =>
              new Promise<void>((resolve, reject) => {
                try {
                  guard();
                  server!.once('error', reject);
                  server!.listen(0, '127.0.0.1', resolve);
                } catch (value) {
                  reject(value);
                }
              })
          );
          await listening;
          guard();
          const address = server.address();
          if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
            throw new Error('SUPERVISOR_NATIVE_RECEIVER_UNAVAILABLE');
          const originalURL = 'http://127.0.0.1:' + address.port + '/' + token;
          await cohort.beforeLaunch();
          guard();
          const originalLaunch = track(
            () => {
              guard();
              if (!directory) throw new Error('SUPERVISOR_NATIVE_PROFILE_UNOWNED');
              assertDirectory(directory);
              nativeEntered = true;
              return launchOriginal!(profile!, {
                executablePath: native.executable.path,
                headless: true,
                chromiumSandbox: true,
                timeout: 10000,
                args: ['--disable-background-networking', '--disable-extensions'],
                env: { PATH: '/usr/bin:/bin', HOME: profile!, LANG: 'C', LC_ALL: 'C' },
              });
            },
            (value) => {
              context = value;
              const closeMethod = value.close;
              if (typeof closeMethod !== 'function')
                throw new Error('SUPERVISOR_NATIVE_CLOSE_UNCAPTURED');
              contextCloseOriginal = closeMethod.bind(value);
            }
          );
          nativeCaptured = track(async () => {
            let primary: Readonly<{ value: unknown }> | undefined;
            try {
              await originalLaunch;
            } catch (value) {
              primary = { value };
            }
            try {
              if (nativeEntered) await cohort.afterLaunch();
            } catch (value) {
              primary ??= { value };
            }
            if (primary) throw primary.value;
          });
          const originalContext = await originalLaunch;
          await nativeCaptured;
          guard();
          const readBrowser = originalContext.browser.bind(originalContext),
            readPages = originalContext.pages.bind(originalContext);
          const originalBrowser = readBrowser();
          if (!originalBrowser) throw new Error('SUPERVISOR_NATIVE_ENGINE_CHANGED');
          const readVersion = originalBrowser.version.bind(originalBrowser);
          const originalPages = readPages();
          if (readVersion() !== native.executable.version || originalPages.length !== 1)
            throw new Error('SUPERVISOR_NATIVE_ENGINE_CHANGED');
          const page = originalPages[0]!,
            goto = page.goto.bind(page),
            evaluate = page.evaluate.bind(page),
            readContext = page.context.bind(page),
            readURL = page.url.bind(page);
          guard();
          await track(() => {
            guard();
            return goto(originalURL!, { timeout: 10000, waitUntil: 'load' });
          });
          guard();
          if (readContext() !== originalContext || readURL() !== originalURL || requests !== 1)
            throw new Error('SUPERVISOR_NATIVE_PAGE_CHANGED');
          const observed = NativeIdentitySchema.parse(
            await track(() => {
              guard();
              return evaluate(readOriginalIdentity);
            })
          );
          guard();
          const metadata = complete.parse(observed.metadata);
          if (
            !observed.secureContext ||
            observed.userAgent !== observedUA ||
            observed.userAgent.match(/\b(?:HeadlessChrome|Chrome)\//g)?.length !== 1 ||
            !/\bHeadlessChrome\/153\.(?:0\.0\.0|0\.8010\.12)\b/.test(observed.userAgent) ||
            !observed.appVersion.includes('HeadlessChrome/') ||
            metadata.uaFullVersion !== native.executable.version ||
            !metadata.brands.length ||
            !metadata.fullVersionList.length ||
            !metadata.formFactors.length
          )
            throw new Error('SUPERVISOR_NATIVE_METADATA_UNAVAILABLE');
          identity = structuredClone({ ...observed, metadata });
          await closeSDK();
          await closeReceiver();
          guard();
          if (!profileClosed || !removed || !cohort.observedBirths().length)
            throw new Error('SUPERVISOR_NATIVE_RETURN_UNVERIFIED');
          ready = true;
          if (issued) throw new Error('SUPERVISOR_NATIVE_PLAN_REUSED');
          issued = true;
          const plan = Object.freeze({});
          plans.set(plan, {
            native,
            candidate: JSON.stringify(candidate),
            sdk: sdk!,
            identity,
            check: () => {
              guard();
              if (!ready) throw closedAdmission;
            },
          });
          return plan;
        } catch (value) {
          note(value);
          throw value;
        }
      });
      return opening;
    },
    knownNativeOriginals: () => cohort.observedBirths(),
    close,
  });
  retained.add(owner);
  return owner;
}
