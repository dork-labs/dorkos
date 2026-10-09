import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { createPrebuiltTransition } from './prebuilt-transition.mjs';
import { createPrefixTransition } from './prefix-transition.mjs';

// Root must build and pin this exact local native artifact before importing.
const requireNative = createRequire(import.meta.url),
  nativeModules = new Map();
const getNative = (path, identity) => {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    !path.endsWith('/atomic-child.node') ||
    !identity ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) ||
    !/^[a-f0-9]{40}$/.test(identity.cdHash) ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1
  )
    throw new Error('ORIGINAL_INSTALLED_NATIVE_PATH_REQUIRED');
  const key = JSON.stringify(identity),
    existing = nativeModules.get(path);
  if (existing) {
    if (existing.key !== key) throw new Error('ORIGINAL_INSTALLED_NATIVE_RESTART_REQUIRED');
    return existing.native;
  }
  const native = requireNative(path);
  nativeModules.set(path, { key, native });
  return native;
};
const states = new WeakMap(),
  returns = new WeakMap(),
  serials = new WeakMap();
const MAX_BYTES = 128 * 1024;
const refuse = (code) => new Error(code);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const recorded = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) throw refuse('NATIVE_JOURNAL_CAPACITY');
  return bytes;
};

function own(
  command,
  binding,
  assets,
  current,
  consumer,
  expectedCDHash,
  runningCustodian = false,
  prefixScope,
  sameProcessVM = false,
  prebuilt = false,
  nativeAddon
) {
  if (typeof current !== 'function') throw refuse('NATIVE_CURRENT_READER_REQUIRED');
  const original = runningCustodian ? nativeAddon.createCustodian() : nativeAddon.create(); // Exposed through the JS owner before fallible startup.
  let first,
    revoked = false,
    forced = false,
    ending = false,
    inputBusy = false;
  let parentEndedBeforeWait = false,
    capturedBirth,
    returned,
    finalNative,
    nativeClosed = false;
  const prefix = prefixScope
    ? prebuilt
      ? createPrebuiltTransition(prefixScope)
      : createPrefixTransition(prefixScope)
    : null;
  let consume = consumer,
    resolveConsumer;
  const consumerReady = new Promise((resolve) => {
    resolveConsumer = resolve;
  });
  if (consume) resolveConsumer();
  const pending = new Set();
  let startup, pumping, killing, writing;
  let stderr = Buffer.alloc(0),
    stderrBytes = 0;
  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  };
  const originalCall = (name, ...args) => {
    // Reserve promise identity synchronously; addon reserves before entering C.
    const promise = original[name](...args);
    return track(promise);
  };
  const note = (value) => {
    first ??= { value };
  };
  const revoke = () => {
    revoked = true;
    resolveConsumer();
  };
  const guard = () => {
    if (first) throw first.value;
    if (revoked) throw refuse('NATIVE_SCOPE_REVOKED');
    const allowed = current(); // A real false/undefined throw remains exact.
    if (first) throw first.value;
    if (revoked || allowed !== true) throw refuse('NATIVE_SCOPE_REVOKED');
  };
  const terminate = () => {
    forced = true;
    revoke();
    killing ??= (async () => {
      // Startup is retained independently. A suspended child may appear after
      // this stop request, so wait for the original admission leg to settle.
      if (startup) await Promise.allSettled([startup]);
      if (runningCustodian && !sameProcessVM) {
        // Separate helper is the sole QEMU parent; its exact EOF retains that
        // waiter. This protected topology must not inherit VM-process killing.
        await end();
        return;
      }
      if (sameProcessVM) {
        // This original process IS the VM. Enter EOF independently of a held
        // original write/end callback, then bound only the escalation delay.
        // A signal return never replaces actual wait/fullpipes/native close.
        const eof = end();
        eof.catch(note);
        await pause(250);
        if (nativeClosed) {
          await Promise.allSettled([eof]);
          return;
        }
        const live = original.observe();
        if (live.pid && !live.reaped) {
          try {
            await originalCall('signal', 9);
          } catch (value) {
            if (!(value?.errno === 10 && original.observe().reaped)) {
              note(value);
            }
          }
        }
        await Promise.allSettled([eof]);
        return;
      }
      const row = original.observe();
      if (!row.pid || row.reaped) return;
      try {
        await originalCall('signal', 9);
      } catch (value) {
        // Same native mutex may have already reaped; no original signal entered.
        if (!(value?.errno === 10 && original.observe().reaped)) {
          note(value);
          throw value;
        }
      }
    })();
    killing.catch(note);
    return killing;
  };
  const readPipe = async (channel) => {
    for (;;) {
      const bytes = await originalCall('read', channel, 65536);
      if (bytes === null) {
        await pause(1);
        continue;
      }
      if (bytes.length === 0) {
        if (channel === 1 && prefix && !revoked) prefix.finish();
        return;
      }
      if (channel === 2) {
        stderrBytes += bytes.length;
        stderr = Buffer.concat([stderr, bytes]).subarray(-32768);
      } else if (!revoked) {
        try {
          guard();
          // One actual consumer is captured and awaited before another read.
          const job = Promise.resolve().then(async () => {
            guard();
            const copy = Uint8Array.from(bytes);
            const value = prefix
              ? await prefix.deliver(
                  copy,
                  async (ack) => {
                    // Genuine INIT partial-write callback must settle before another
                    // original bank admission. No synthetic backpressure promise.
                    if (writing) await Promise.allSettled([writing]);
                    guard();
                    await write(ack);
                    guard();
                  },
                  consume
                )
              : await consume(copy);
            guard();
            return value;
          });
          await track(job);
        } catch (value) {
          note(value);
          void terminate();
          // Refuse new delivery, but keep draining this same original pipe to
          // actual EOF. A refused callback never stands in for pipe closure.
        }
      }
    }
  };
  const pump = () => {
    if (pumping) return pumping;
    const row = original.observe();
    if (!row.pid) return (pumping = Promise.resolve());
    const stdout = readPipe(1),
      errors = readPipe(2);
    const wait = (async () => {
      while ((await originalCall('wait')) === 0) await pause(1);
      // Closing writer only after actual VM-process wait is not a shutdown ACK.
      await end();
    })();
    for (const job of [stdout, errors, wait])
      job.catch((value) => {
        note(value);
        void terminate();
      });
    pumping = Promise.allSettled([stdout, errors, wait]);
    return pumping;
  };
  const acquire = async () => {
    guard();
    await originalCall('cwd', command.cwd);
    guard();
    const manager = Object.freeze(await originalCall('identity'));
    guard();
    if (manager.pid !== 0 || manager.managerPid !== process.pid)
      throw refuse('NATIVE_MANAGER_IDENTITY');
    for (const asset of assets) {
      guard();
      await originalCall('verifyFile', asset.path, asset.sha256);
      guard();
    }
    const reservation = Object.freeze({ schema: 1, kind: 'native-reservation', binding, manager });
    await originalCall('journal', command.home, 'reservation.json', recorded(reservation));
    guard();
    await originalCall(
      'spawn',
      command.executable,
      [command.executable, ...command.argv],
      command.env
    );
    guard();
    const birth = Object.freeze(await originalCall('identity'));
    guard();
    if (
      birth.pid <= 0 ||
      birth.parentPid !== manager.managerPid ||
      birth.managerPid !== manager.managerPid ||
      birth.managerSeconds !== manager.managerSeconds ||
      birth.managerMicroseconds !== manager.managerMicroseconds ||
      birth.bootSeconds !== manager.bootSeconds ||
      birth.bootMicroseconds !== manager.bootMicroseconds ||
      birth.executable !== command.executable
    )
      throw refuse('NATIVE_CHILD_IDENTITY');
    capturedBirth = birth;
    if (expectedCDHash !== undefined) {
      guard();
      await originalCall('verifyCode', expectedCDHash);
      guard();
    }
    await originalCall(
      'journal',
      command.home,
      'birth.json',
      recorded({ schema: 1, kind: 'native-birth', binding, birth })
    );
    guard();
    // Original file checks and exact suspended identity are fresh at resume.
    for (const asset of assets) {
      guard();
      await originalCall('verifyFile', asset.path, asset.sha256);
      guard();
    }
    if (!same(birth, await originalCall('identity'))) throw refuse('NATIVE_BIRTH_CHANGED');
    guard();
    await consumerReady;
    guard();
    if (expectedCDHash !== undefined) {
      await originalCall('verifyCode', expectedCDHash);
      guard();
      if (!same(birth, await originalCall('identity'))) throw refuse('NATIVE_BIRTH_CHANGED');
      guard();
    }
    if (!runningCustodian) await originalCall('resume');
    guard();
    pump();
  };
  const write = (bytes) => {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > MAX_BYTES ||
      inputBusy ||
      ending ||
      revoked
    )
      return Promise.reject(refuse('NATIVE_FIFO_WRITE_REFUSED'));
    inputBusy = true;
    let copy;
    try {
      guard();
      copy = Buffer.from(bytes);
    } catch (value) {
      inputBusy = false;
      note(value);
      void terminate();
      return Promise.reject(value);
    }
    const job = (async () => {
      await startup;
      let offset = 0;
      while (offset < copy.length) {
        guard();
        const part = copy.subarray(offset, Math.min(copy.length, offset + 65536));
        const accepted = await originalCall('write', part);
        if (accepted === -1) {
          await pause(1);
          continue;
        }
        if (!Number.isSafeInteger(accepted) || accepted <= 0 || accepted > part.length)
          throw refuse('NATIVE_PARTIAL_WRITE_UNCERTAIN');
        offset += accepted;
        guard();
      }
    })();
    job.then(
      () => {
        inputBusy = false;
      },
      (value) => {
        inputBusy = false;
        note(value);
        void terminate();
      }
    );
    writing = job;
    return track(job);
  };
  let ended;
  const end = () => {
    if (ended) return ended;
    ending = true;
    ended = (async () => {
      await Promise.allSettled([startup]);
      if (writing) await Promise.allSettled([writing]);
      if (nativeClosed) return;
      if (original.observe().pid) {
        parentEndedBeforeWait ||= !original.observe().reaped;
        await originalCall('end');
      }
    })();
    ended.catch((value) => {
      note(value);
      void terminate();
    });
    return track(ended);
  };
  let completion;
  const complete = () =>
    (completion ??= (async () => {
      await Promise.allSettled([startup]);
      await pump();
      if (killing) await Promise.allSettled([killing]);
      while (pending.size) await Promise.allSettled([...pending]);
      const row = original.observe();
      finalNative = Object.freeze(row);
      let closed = false;
      try {
        original.close();
        closed = true;
        nativeClosed = true;
      } catch (value) {
        note(value);
        finalNative = Object.freeze(original.observe());
      } // Exact native pointer remains strongly retained.
      if (
        row.pid &&
        row.reaped &&
        row.stdoutEOF &&
        row.stderrEOF &&
        row.stdinClosed &&
        !row.closeUncertain &&
        row.jobs === 0 &&
        finalNative &&
        capturedBirth
      ) {
        // Only this original native verified-close return mints the local token.
        if (closed) {
          returned = Object.freeze(Object.create(null));
          returns.set(returned, owner);
        }
      }
      return Object.freeze({
        closure: returned ?? null,
        native: finalNative,
        firstFailure: first ? first.value : null,
        hasFailure: !!first,
        stderr: Buffer.from(stderr),
        stderrBytes,
        profile: 'reserved',
      });
    })());
  const owner = Object.freeze({
    ready: () => startup,
    join: async () => (await complete()).closure,
    completion: complete,
    acceptsOriginalReturn: (value) => !!value && returns.get(value) === owner,
    permitsGracefulProfileCheck(value) {
      if (runningCustodian) return false; // Helper return alone never grants QEMU/profile handback.
      if (
        returns.get(value) !== owner ||
        first ||
        forced ||
        parentEndedBeforeWait ||
        finalNative?.status !== 0 ||
        finalNative?.firstErrno !== 0
      )
        return false;
      guard();
      return !first && !forced && !revoked;
    },
    terminateOriginal: terminate,
    managerLost: terminate,
    attachConsumer(callback) {
      if (typeof callback !== 'function' || consume || revoked)
        throw refuse('NATIVE_CONSUMER_REFUSED');
      try {
        guard();
        consume = callback;
        guard();
        resolveConsumer();
      } catch (value) {
        note(value);
        void terminate();
        throw value;
      }
    },
    write,
    end,
    snapshot: () =>
      Object.freeze({
        revoked,
        forced,
        pending: pending.size,
        native: finalNative ?? original.observe(),
        born: !!capturedBirth,
        profile: 'reserved',
      }),
  });
  startup = Promise.resolve().then(acquire);
  startup.catch((value) => {
    note(value);
    revoke();
    void terminate();
  });
  const closed = (async () => {
    await complete();
    if (!returned) throw first ? first.value : refuse('NATIVE_SERIAL_CLOSURE_UNCERTAIN');
  })();
  closed.catch(() => {});
  states.set(owner, {
    serial: Object.freeze({ attachConsumer: owner.attachConsumer, write, end, revoke, closed }),
    issued: false,
    producerClean: () =>
      !!expectedCDHash &&
      (!runningCustodian || sameProcessVM) &&
      !first &&
      !forced &&
      !parentEndedBeforeWait &&
      finalNative?.status === 0,
  });
  return owner;
}

export function captureRetainedOriginalSerial(owner) {
  const state = states.get(owner);
  if (!state || state.issued || owner.snapshot().revoked)
    throw refuse('ORIGINAL_NATIVE_SERIAL_REQUIRED');
  state.issued = true;
  const token = Object.freeze(Object.create(null));
  serials.set(token, state.serial);
  return token;
}
export function inspectRetainedOriginalSerial(token) {
  const serial = serials.get(token);
  if (!serial) throw refuse('ORIGINAL_NATIVE_SERIAL_REQUIRED');
  return serial;
}

/** Original same-instance normal developer producer closure, never profile health. */
export function assertOriginalNormalSerialClosure(serial, owner, closure) {
  const state = states.get(owner);
  if (!state || serials.get(serial) !== state.serial || returns.get(closure) !== owner)
    throw refuse('ORIGINAL_NORMAL_PRODUCER_CLOSURE_REQUIRED');
  const row = owner.snapshot();
  if (
    !state.producerClean() ||
    row.forced ||
    !row.native.reaped ||
    row.native.status !== 0 ||
    row.native.firstErrno ||
    row.native.closeUncertain ||
    !row.native.stdinClosed ||
    !row.native.stdoutEOF ||
    !row.native.stderrEOF ||
    row.native.jobs
  )
    throw refuse('ORIGINAL_NORMAL_PRODUCER_CLOSURE_REQUIRED');
}

/** Customer runtime constructor: actual prebuilt opaque release/profile selection only. */
export async function launchOwnedPrebuiltQEMU(token, current) {
  const { inspectOriginalPrebuiltLaunch } = await import('./prebuilt-launch.mjs');
  const selected = await inspectOriginalPrebuiltLaunch(token);
  const combinedCurrent = () => current() === true && selected.current() === true;
  const owner = own(
    selected.command,
    selected.binding,
    selected.assets,
    combinedCurrent,
    undefined,
    selected.cdHash,
    true,
    selected.scope,
    true,
    true,
    getNative(selected.nativePath, selected.nativeIdentity)
  );
  let starting;
  return Object.freeze({
    owner,
    scope: selected.scope,
    start: () =>
      (starting ??= (async () => {
        await owner.ready();
        for (const frame of selected.startup) await owner.write(frame);
      })()),
  });
}
