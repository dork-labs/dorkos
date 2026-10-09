import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { TextDecoder } from 'node:util';
const originalSemanticRefusals = new WeakMap();
export function inspectOriginalManagedVMSemanticRefusal(session, value) {
  const row = originalSemanticRefusals.get(value);
  return row?.session === session ? row.reason : null;
}
import { createOriginalSemanticProtocol } from './semantic-protocol.mjs';
import { createOriginalTransferProtocol } from './transfer-protocol.mjs';
import { validateOriginalGuestDiagnostic } from '../vm/diagnostics.mjs';
import { randomBytes } from 'node:crypto';
import { FrameReceiver } from './guest/frame.mjs';
import {
  openOriginalManagedProfileStore,
  issueOriginalNamedProfile,
  retireOriginalNamedProfile,
  retireOriginalManagedProfileStore,
} from './named-profile.mjs';
import { inspectOriginalBuiltPrebuiltRelease } from './prebuilt-release.mjs';
import { issueOriginalPrebuiltLaunch } from './prebuilt-launch.mjs';
import { launchOwnedPrebuiltQEMU, captureRetainedOriginalSerial } from './native-fifo-owner.mjs';
import { createNativeMux } from './native-mux.mjs';
import { createProductionOwnedSerialProxyIntake } from './production-owned-serial-proxy.mjs';
const originalSessions = new WeakMap(),
  originalRasters = new WeakMap(),
  originalStaleCommands = new WeakMap(),
  originalCanceledTransfers = new WeakMap();
export function isOriginalManagedVMStaleCommand(session, value) {
  return !!value && originalStaleCommands.get(value) === session;
}
export function inspectOriginalManagedVMRaster(session, raster) {
  if (!raster || originalRasters.get(raster) !== session)
    throw new Error('VM_ORIGINAL_RASTER_REQUIRED');
  return raster;
}
export function inspectOriginalManagedVMSession(session, receiver) {
  const row = originalSessions.get(session);
  if (!row || row.receiver !== receiver) throw new Error('VM_ORIGINAL_SESSION_REQUIRED');
  return row;
}
const failCode = (code) => new Error(code);
const closed = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const tab = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(v);
/** Internal trusted VM lifecycle acquisition. Not a public configuration port,
 * BrowserLifecycleEngine, accepted-mode issuer, or durable profile return. */
export function acquireOriginalManagedVM({
  release,
  dataHome,
  profileId,
  generation,
  receiver,
  network,
  width,
  height,
}) {
  const ordinary = receiver.isOrdinary.bind(receiver),
    bind = network.bindBeforeLaunch.bind(network),
    activate = network.activateReady.bind(network);
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(receiver.browserId) ||
    !Number.isSafeInteger(receiver.browserGeneration) ||
    receiver.browserGeneration < 0 ||
    !Number.isInteger(width) ||
    width < 320 ||
    width > 1920 ||
    !Number.isInteger(height) ||
    height < 240 ||
    height > 1080
  )
    throw failCode('VM_ACQUISITION_SCOPE');
  const browserId = receiver.browserId,
    browserGeneration = receiver.browserGeneration;
  let first,
    stopped = false,
    closing,
    store,
    profile,
    peer,
    vm,
    mux,
    proxy,
    timer,
    readyValue,
    sequence = 0,
    pendingReply,
    cancelReply,
    shutdownEntered = false,
    completed,
    active = false,
    localOwnersClosed = false,
    cleanupFinished = false;
  let retiredYes;
  const retired = new Promise((resolve) => {
    retiredYes = resolve;
  });
  let readyYes, readyNo;
  const ready = new Promise((yes, no) => {
    readyYes = yes;
    readyNo = no;
  });
  void ready.catch(() => {});
  const admitted = new Set();
  const frames = new FrameReceiver();
  const guard = () => {
    if (first) throw first.value;
    if (
      stopped ||
      !ordinary() ||
      receiver.browserId !== browserId ||
      receiver.browserGeneration !== browserGeneration
    )
      throw failCode('VM_LIFETIME_RETIRED');
  };
  const fail = (value) => {
    first ??= { value };
    stopped = true;
    readyNo(first.value);
    for (const pending of [pendingReply, cancelReply])
      if (pending) {
        pending.transferChunk?.bytes.fill(0);
        semantics.clear(pending);
        clearTimeout(pending.deadline);
        pending.reject(first.value);
      }
    if (vm) void vm.owner.terminateOriginal().catch(() => {});
    globalThis.queueMicrotask(() => {
      void stop().catch(() => {});
    });
  };
  const own = (promise) => {
    admitted.add(promise);
    void promise.then(
      () => admitted.delete(promise),
      (value) => {
        admitted.delete(promise);
        if (
          !isOriginalManagedVMStaleCommand(session, value) &&
          originalCanceledTransfers.get(value) !== session &&
          !inspectOriginalManagedVMSemanticRefusal(session, value)
        ) {
          first ??= { value };
          fail(first.value);
        }
      }
    );
    return promise;
  };
  const transfers = createOriginalTransferProtocol({
    guard,
    request,
    cancelRequest(body) {
      if (
        !pendingReply ||
        pendingReply.action !== 'download-next' ||
        pendingReply.transfer !== body.transfer ||
        pendingReply.tabId !== body.tabId
      )
        return null;
      return enterRequest(body, undefined, undefined, true);
    },
    async joinRequests() {
      while (admitted.size) await Promise.allSettled([...admitted]);
    },
  });
  const semantics = createOriginalSemanticProtocol({
    guard,
    request,
    originalSession: () => session,
  });
  const consume = (row, bytes) => {
    if (row.channel === 'frame') {
      guard();
      const pending = pendingReply;
      if (!pending) throw failCode('VM_UNREQUESTED_FRAME');
      if (transfers.frame(pending, bytes) || semantics.frame(pending, bytes)) return;
      if (pending.action !== 'capture') throw failCode('VM_UNREQUESTED_FRAME');
      const raster = frames.push(bytes);
      if (raster) {
        if (pending.raster) throw failCode('VM_DUPLICATE_FRAME');
        pending.raster = raster;
      }
      return;
    }
    if (row.channel !== 'control' || bytes.length > 4096) throw failCode('VM_UNREQUESTED_CHANNEL');
    const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    if (
      closed(value, 'event,platform,product,qualification,userAgent') &&
      value.event === 'ready' &&
      !readyValue &&
      value.platform === 'linux-arm64' &&
      value.product === 'Chrome/153.0.8010.12' &&
      value.qualification === 'OPEN' &&
      typeof value.userAgent === 'string' &&
      value.userAgent.length < 1024 &&
      !value.userAgent.includes('HeadlessChrome')
    ) {
      guard();
      readyValue = Object.freeze({ ...value });
      readyYes(readyValue);
      return;
    }
    if (value.event === 'diagnostic-observed' || value.event === 'diagnostic-loss') {
      guard();
      validateOriginalGuestDiagnostic(value);
      if (typeof receiver.observeOriginalDiagnostic !== 'function')
        throw failCode('VM_ORIGINAL_DIAGNOSTIC_OBSERVER_REQUIRED');
      receiver.observeOriginalDiagnostic(Object.freeze({ ...value }));
      guard();
      return;
    }
    if (
      value.event === 'navigation-observed' &&
      closed(value, 'event,tabId,kind,frameId,loaderId,url') &&
      tab(value.tabId) &&
      ['document', 'same-document'].includes(value.kind) &&
      typeof value.frameId === 'string' &&
      value.frameId.length > 0 &&
      value.frameId.length <= 256 &&
      (value.kind === 'document'
        ? typeof value.loaderId === 'string' && value.loaderId.length <= 256
        : value.loaderId === null) &&
      (value.url === null || (typeof value.url === 'string' && value.url.length <= 2048))
    ) {
      guard();
      if (typeof receiver.observeOriginalNavigation !== 'function')
        throw failCode('VM_ORIGINAL_NAVIGATION_OBSERVER_REQUIRED');
      receiver.observeOriginalNavigation(Object.freeze({ ...value }));
      guard();
      return;
    }
    const replyTarget = value.request === cancelReply?.request ? cancelReply : pendingReply;
    const transferRefusal = transfers.refused(value, replyTarget, () => {
      const value = Object.freeze(new Error('VM_ORIGINAL_COMMAND_STALE'));
      originalStaleCommands.set(value, session);
      return value;
    });
    if (transferRefusal) {
      if (transferRefusal === 'pending') {
        if (replyTarget === cancelReply) cancelReply = undefined;
        else pendingReply = undefined;
      }
      return;
    }
    if (transfers.selected(value)) return;
    const pending = replyTarget;
    if (!pending || value.request !== pending.request)
      throw failCode('VM_ORIGINAL_REPLY_CORRELATION');
    if (
      semantics.refuse(pending, value, (reason) => {
        const cause = Object.freeze(new Error('VM_ORIGINAL_SEMANTIC_REFUSAL'));
        originalSemanticRefusals.set(cause, { session, reason });
        return cause;
      })
    ) {
      pendingReply = undefined;
      return;
    }
    const semanticReply = semantics.consume(pending, value);
    if (semanticReply.handled) {
      if (semanticReply.settled) {
        guard();
        pendingReply = undefined;
        pending.resolve(semanticReply.value);
      }
      return;
    }
    if (value.event === 'transfer-canceled') {
      if (
        !closed(value, 'event,request,tabId,transfer') ||
        pending.action !== 'download-next' ||
        !pending.cancelRequest ||
        value.transfer !== pending.transfer ||
        value.tabId !== pending.tabId
      )
        throw failCode('VM_TRANSFER_CANCEL_CORRELATION');
      guard();
      pending.transferChunk?.bytes.fill(0);
      const cause = Object.freeze(new Error('VM_ORIGINAL_TRANSFER_CANCELED'));
      originalCanceledTransfers.set(cause, session);
      pendingReply = undefined;
      pending.reject(cause);
      return;
    }
    if (
      value.event === 'command-refused' &&
      closed(value, 'event,request,tabId,reason') &&
      value.tabId === pending.tabId &&
      [
        'capture',
        'navigate',
        'pointer',
        'wheel',
        'key',
        'text',
        'composition',
        'compositionCommit',
        'cancelComposition',
        'cancelDrag',
      ].includes(pending.action) &&
      ['document-changed', 'navigation-superseded'].includes(value.reason)
    ) {
      guard();
      if (pending.action === 'capture') {
        if (pending.raster) frames.finish();
        else frames.discardUnstarted(pending.request, pending.tabId);
      }
      const refusal = Object.freeze(new Error('VM_ORIGINAL_COMMAND_STALE'));
      originalStaleCommands.set(refusal, session);
      pendingReply = undefined;
      pending.reject(refusal);
      return;
    }
    if (
      pending.action === 'shutdown' &&
      closed(value, 'event,request') &&
      value.event === 'shutdown-entered'
    ) {
      guard();
      proxy.expectOriginalShutdownEOF();
      shutdownEntered = true;
      active = false;
      pendingReply = undefined;
      pending.resolve();
      return;
    }
    const transferReply = transfers.reply(pending, value);
    if (transferReply.handled) {
      guard();
      if (pending === cancelReply) cancelReply = undefined;
      else pendingReply = undefined;
      pending.resolve(transferReply.value);
      return;
    }
    if (
      value.event !== 'completed' ||
      !closed(value, 'event,request,tabId') ||
      value.tabId !== pending.tabId
    )
      throw failCode('VM_ORIGINAL_REPLY_CORRELATION');
    guard();
    if (pending.action === 'capture' && !pending.raster)
      throw failCode('VM_CAPTURE_REPLY_BEFORE_FRAME');
    pendingReply = undefined;
    pending.resolve(pending.raster);
  };
  const opening = Promise.resolve().then(async () => {
    guard();
    await inspectOriginalBuiltPrebuiltRelease(release);
    guard();
    store = await openOriginalManagedProfileStore(dataHome);
    guard();
    profile = await issueOriginalNamedProfile({
      store,
      release,
      profileId,
      generation,
      current: () => !stopped && ordinary(),
    });
    guard();
    peer = await bind(receiver);
    guard();
    if (
      typeof peer.originalSerialProxyEndpoint !== 'function' ||
      !peer.isCustodyKnown() ||
      !closed(peer.credentials, 'password,username') ||
      peer.credentials.username !== 'dorkos' ||
      typeof peer.credentials.password !== 'string'
    )
      throw failCode('VM_ORIGINAL_BROKER_PEER_REQUIRED');
    const endpoint = peer.originalSerialProxyEndpoint();
    guard();
    const launch = await issueOriginalPrebuiltLaunch({
      release,
      profile,
      current: () => !stopped && ordinary(),
    });
    guard();
    vm = await launchOwnedPrebuiltQEMU(launch, () => !stopped && ordinary());
    guard();
    // All original receive owners are installed synchronously before INIT.
    const selected = Object.freeze({
      browserId,
      generation: browserGeneration,
      nonce: vm.scope.nonce,
    });
    mux = createNativeMux({
      serial: captureRetainedOriginalSerial(vm.owner),
      selected,
      consume,
      onFailure(value) {
        if (!(shutdownEntered && value?.message === 'NATIVE_MUX_ORIGINAL_EOF')) fail(value);
      },
    });
    proxy = createProductionOwnedSerialProxyIntake({
      serial: mux.proxySerial(),
      selected,
      endpoint,
    });
    void proxy.refused.then((box) => fail(box.value));
    timer = setTimeout(() => fail(failCode('VM_ACQUISITION_DEADLINE')), 180000);
    await vm.start();
    guard();
    await mux.send(
      'bootstrap',
      Buffer.from(
        JSON.stringify({
          stage: 'private-source-prototype',
          width,
          height,
          password: peer.credentials.password,
        })
      )
    );
    guard();
    await ready;
    guard();
    await activate(receiver, peer);
    guard();
    active = true;
    clearTimeout(timer);
    timer = undefined;
    return Object.freeze({ ...readyValue });
  });
  void opening.catch(fail);
  function request(body, frameBytes, onReserved) {
    return enterRequest(body, frameBytes, onReserved, false);
  }
  function enterRequest(body, frameBytes, onReserved, cancellation) {
    guard();
    if (
      !active ||
      (!cancellation && (pendingReply || admitted.size)) ||
      (cancellation &&
        (cancelReply ||
          body.action !== 'transfer-close' ||
          !pendingReply ||
          pendingReply.action !== 'download-next' ||
          body.transfer !== pendingReply.transfer ||
          body.tabId !== pendingReply.tabId))
    )
      throw failCode('VM_SINGLE_ORIGINAL_COMMAND_BANK');
    const request = sequence + 1;
    if (!Number.isSafeInteger(request)) throw failCode('VM_ORIGINAL_REQUEST_SEQUENCE');
    sequence = request;
    const wire =
      body.action === 'upload-chunk'
        ? transfers.encode(request, body, frameBytes)
        : Buffer.from(JSON.stringify({ request, ...body }));
    onReserved?.(request);
    let resolve, reject;
    const reply = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void reply.catch(() => {});
    const pending = {
      request,
      action: body.action,
      tabId: body.tabId,
      transfer: body.transfer,
      transferSequence: body.sequence,
      resolve,
      reject,
      deadline: undefined,
      settled: false,
      raster: undefined,
    };
    if (body.action === 'capture') frames.expect(request, body.tabId, body.receipt, width, height);
    pending.deadline = setTimeout(() => {
      if (!pending.settled) fail(failCode('VM_ORIGINAL_COMMAND_DEADLINE'));
    }, 15000);
    if (cancellation) {
      cancelReply = pending;
      pendingReply.cancelRequest = request;
    } else pendingReply = pending;
    const write = Promise.resolve().then(() => {
      guard();
      return mux.send(body.action === 'upload-chunk' ? 'frame' : 'control', wire);
    });
    // Refuse the reply immediately on a genuine write rejection; allSettled
    // still retains its original callback. Otherwise an absent reply could
    // strand local lifetime refusal before a mux failure callback can occur.
    void write.catch(fail);
    // A reply cannot substitute the original native write/callback settlement.
    const job = Promise.allSettled([write, reply]).then((rows) => {
      if (first) throw first.value;
      for (const row of rows) if (row.status === 'rejected') throw row.reason;
      guard();
      return rows[1].value;
    });
    const joined = () => {
      wire.fill(0);
      pending.settled = true;
      clearTimeout(pending.deadline);
    };
    void job.then(joined, joined);
    return own(job);
  }
  function stop(cause) {
    if (arguments.length) {
      first ??= { value: cause };
      fail(first.value);
    }
    if (closing) return closing;
    stopped = true;
    active = false;
    transfers.stop(first ? first.value : failCode('VM_STOPPED'));
    clearTimeout(timer);
    timer = undefined;
    readyNo(first ? first.value : failCode('VM_STOPPED'));
    for (const pending of [pendingReply, cancelReply])
      if (pending) {
        pending.transferChunk?.bytes.fill(0);
        semantics.clear(pending);
        clearTimeout(pending.deadline);
        pending.reject(first ? first.value : failCode('VM_STOPPED'));
      }
    closing = (async () => {
      // Stop any already acquired original now, independently of held startup.
      const alreadyClosed = () =>
        !!(completed?.closure && vm?.owner.acceptsOriginalReturn(completed.closure));
      const originalStop =
        vm && !alreadyClosed()
          ? Promise.resolve().then(() => vm.owner.terminateOriginal())
          : Promise.resolve();
      void originalStop.catch((value) => {
        first ??= { value };
      });
      await Promise.allSettled([originalStop, opening]);
      // Awaiting startup reveals every late acquired original before this census.
      const rows = await Promise.allSettled(
        [
          () => (vm && !alreadyClosed() ? vm.owner.terminateOriginal() : undefined),
          () => proxy?.close(),
          () => mux?.close(),
          () => peer?.close(),
          () =>
            vm
              ? vm.owner.completion().then((value) => {
                  completed ??= value;
                  const n = value.native;
                  if (value.hasFailure) throw value.firstFailure;
                  if (
                    !value.closure ||
                    !vm.owner.acceptsOriginalReturn(value.closure) ||
                    !n.reaped ||
                    n.firstErrno ||
                    n.closeUncertain ||
                    !n.stdinClosed ||
                    !n.stdoutEOF ||
                    !n.stderrEOF ||
                    n.jobs
                  )
                    throw failCode('VM_ORIGINAL_CLOSURE_UNVERIFIED');
                  return value;
                })
              : undefined,
        ].map((fn) => Promise.resolve().then(fn))
      );
      localOwnersClosed = rows.every((row) => row.status === 'fulfilled');
      for (const row of rows) if (row.status === 'rejected') first ??= { value: row.reason };
      while (admitted.size) await Promise.allSettled([...admitted]);
      for (const job of [
        () => (profile ? retireOriginalNamedProfile(profile) : undefined),
        () => (store ? retireOriginalManagedProfileStore(store) : undefined),
      ])
        try {
          await job();
        } catch (value) {
          localOwnersClosed = false;
          first ??= { value };
        }
      cleanupFinished = true;
      if (first) throw first.value;
      return Object.freeze({
        originalClosure: completed?.closure ?? null,
        profileDurabilityQualified: false,
        productionAdmitted: false,
      });
    })();
    void closing.then(
      (value) => retiredYes(Object.freeze({ value })),
      (failure) => retiredYes(Object.freeze({ failure }))
    );
    return closing;
  }
  const session = Object.freeze({
    opening,
    retired,
    semantic: semantics.request,
    uploadStage: transfers.uploadStage,
    uploadChunk: transfers.uploadChunk,
    uploadSeal: transfers.uploadSeal,
    uploadArm: transfers.uploadArm,
    uploadComplete: transfers.uploadComplete,
    downloadArm: transfers.downloadArm,
    transferSelection: transfers.selection,
    downloadNext: transfers.downloadNext,
    closeOriginalTransfer: transfers.closeOriginalTransfer,
    closeTransfer: transfers.closeTransfer,
    createTab(tabId) {
      if (!tab(tabId)) return Promise.reject(failCode('VM_TAB_ID'));
      return request({ action: 'create-tab', tabId });
    },
    closeTab(tabId) {
      if (!tab(tabId)) return Promise.reject(failCode('VM_TAB_ID'));
      return request({ action: 'close-tab', tabId });
    },
    navigate(tabId, url) {
      if (!tab(tabId) || typeof url !== 'string' || url.length > 2048)
        return Promise.reject(failCode('VM_NAVIGATION'));
      const u = new URL(url);
      if (
        url !== 'about:blank' &&
        (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      )
        return Promise.reject(failCode('VM_NAVIGATION'));
      return request({ action: 'navigate', tabId, url });
    },
    // Internal observational commands only. Canonical host dispatchers must
    // authorize their original binding/receipt before calling these methods.
    capture(tabId) {
      if (!tab(tabId)) return Promise.reject(failCode('VM_TAB_ID'));
      return request({ action: 'capture', tabId, receipt: randomBytes(24).toString('hex') }).then(
        (raster) => {
          guard();
          originalRasters.set(raster, session);
          return raster;
        }
      );
    },
    pointer(tabId, event, x, y, button) {
      if (
        !tab(tabId) ||
        !['mouseMoved', 'mousePressed', 'mouseReleased'].includes(event) ||
        !['none', 'left', 'right', 'middle'].includes(button) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      )
        return Promise.reject(failCode('VM_POINTER'));
      return request({ action: 'pointer', tabId, event, x, y, button });
    },
    wheel(tabId, x, y, deltaX, deltaY) {
      if (
        !tab(tabId) ||
        ![x, y, deltaX, deltaY].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height ||
        Math.abs(deltaX) > 16384 ||
        Math.abs(deltaY) > 16384
      )
        return Promise.reject(failCode('VM_WHEEL'));
      return request({ action: 'wheel', tabId, x, y, deltaX, deltaY });
    },
    key(tabId, event, key, code) {
      if (
        !tab(tabId) ||
        !['keyDown', 'keyUp'].includes(event) ||
        typeof key !== 'string' ||
        key.length > 32 ||
        typeof code !== 'string' ||
        !/^[A-Za-z0-9]{1,32}$/.test(code)
      )
        return Promise.reject(failCode('VM_KEY'));
      return request({ action: 'key', tabId, event, key, code });
    },
    text(tabId, text) {
      if (!tab(tabId) || typeof text !== 'string' || text.length > 2048 || text.includes('\0'))
        return Promise.reject(failCode('VM_TEXT'));
      return request({ action: 'text', tabId, text });
    },
    composition(tabId, text, selectionStart, selectionEnd) {
      if (
        !tab(tabId) ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) > 2048 ||
        !Number.isInteger(selectionStart) ||
        !Number.isInteger(selectionEnd) ||
        selectionStart < 0 ||
        selectionStart > selectionEnd ||
        selectionEnd > text.length
      )
        return Promise.reject(failCode('VM_COMPOSITION'));
      return request({ action: 'composition', tabId, text, selectionStart, selectionEnd });
    },
    compositionCommit(tabId, text) {
      if (!tab(tabId) || typeof text !== 'string' || Buffer.byteLength(text) > 2048)
        return Promise.reject(failCode('VM_COMPOSITION'));
      return request({ action: 'compositionCommit', tabId, text });
    },
    cancelComposition(tabId) {
      if (!tab(tabId)) return Promise.reject(failCode('VM_TAB_ID'));
      return request({ action: 'cancelComposition', tabId });
    },
    cancelDrag(tabId) {
      if (!tab(tabId)) return Promise.reject(failCode('VM_TAB_ID'));
      return request({ action: 'cancelDrag', tabId });
    },
    async normalShutdown() {
      await opening;
      guard();
      const deadline = setTimeout(() => fail(failCode('VM_NORMAL_SHUTDOWN_DEADLINE')), 15000);
      try {
        await request({ action: 'shutdown' });
        completed = await vm.owner.completion();
        if (completed.hasFailure) throw completed.firstFailure;
        guard();
        const n = completed.native;
        if (
          !completed.closure ||
          !vm.owner.acceptsOriginalReturn(completed.closure) ||
          n.status !== 0 ||
          !n.reaped ||
          n.firstErrno ||
          n.closeUncertain ||
          !n.stdinClosed ||
          !n.stdoutEOF ||
          !n.stderrEOF ||
          n.jobs
        )
          throw failCode('VM_ORIGINAL_NORMAL_CLOSURE');
        return Object.freeze({
          originalClosure: completed.closure,
          profileDurabilityQualified: false,
          productionAdmitted: false,
        });
      } catch (value) {
        fail(value);
        throw first.value;
      } finally {
        clearTimeout(deadline);
      }
    },
    managerLost(cause) {
      return stop(cause);
    },
    close() {
      return stop();
    },
    snapshot: () =>
      Object.freeze({
        stopped,
        pending: admitted.size,
        openingReady: active,
        guestReady: !!readyValue,
        profileDurabilityQualified: false,
        productionAdmitted: false,
      }),
  });
  originalSessions.set(
    session,
    Object.freeze({
      receiver,
      browserId,
      browserGeneration,
      width,
      height,
      guard,
      runtimeCurrent() {
        try {
          guard();
          if (!readyValue || !vm) return false;
          const row = vm.owner.snapshot(),
            n = row.native;
          return (
            row.born &&
            !row.revoked &&
            !row.forced &&
            !n.reaped &&
            !n.firstErrno &&
            !n.closeUncertain
          );
        } catch {
          return false;
        }
      },
      physicallyClosed() {
        const n = completed?.native;
        return !!(
          stopped &&
          cleanupFinished &&
          localOwnersClosed &&
          admitted.size === 0 &&
          completed?.closure &&
          vm?.owner.acceptsOriginalReturn(completed.closure) &&
          n?.reaped &&
          !n.firstErrno &&
          !n.closeUncertain &&
          n.stdinClosed &&
          n.stdoutEOF &&
          n.stderrEOF &&
          n.jobs === 0
        );
      },
    })
  );
  return session;
}
