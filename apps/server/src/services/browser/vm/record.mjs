import { inspectOriginalVMTransfer } from './transfer-owners.mjs';
import { createOriginalVMDiagnostics } from './diagnostics.mjs';
import { inspectOriginalVMRuntimeSubject } from '../runtime/runtime-subject.mjs';
import { randomBytes } from 'node:crypto';
import { parseBrowserCommand, parseBrowserResult, advanceCounter } from '@dorkos/browser';
import {
  inspectOriginalManagedVMSession,
  inspectOriginalManagedVMRaster,
} from '../runtime/managed-vm-acquisition.mjs';
const originalRecords = new WeakSet();
const refused = (code) => new Error(code);
const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
/** One original server constructor owns this map. No Playwright Page/context is
 * represented, and no Darwin generation-return token is cast or minted. */
export function createOriginalVMRecordOwner() {
  const records = new Map(),
    diagnostics = createOriginalVMDiagnostics();
  function issue(value) {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'open') throw refused('VM_RECORD_OPEN_REQUIRED');
    const browserId = randomBytes(16).toString('base64url'),
      browserGeneration = 0;
    let phase = 'opening',
      session,
      selectedSession,
      runtimeSubject,
      first,
      retiring,
      navigateInitial,
      resolveObservation;
    const jobs = new Set(),
      tabs = new Map(),
      transfers = new Set();
    let dispatchTail = Promise.resolve(),
      dispatchCount = 0;
    const observation = new Promise((resolve) => {
      resolveObservation = resolve;
    });
    const acquisition = Object.freeze(
      command.mode === 'persistent'
        ? { mode: 'persistent', profileId: command.profileId }
        : { mode: 'ephemeral' }
    );
    const ordinary = () =>
      records.get(browserId) === record && ['opening', 'running'].includes(phase);
    const guard = () => {
      if (first) throw first.value;
      if (!ordinary()) throw refused('VM_RECORD_RETIRED');
    };
    function own(enter) {
      let yes, no;
      const original = new Promise((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      jobs.add(original);
      // Reserve original membership before an external getter/callback can run.
      Promise.resolve()
        .then(() => {
          guard();
          return enter();
        })
        .then(yes, no);
      void original.then(
        () => jobs.delete(original),
        (value) => {
          jobs.delete(original);
          first ??= { value };
          void retire('engineFault');
        }
      );
      return original;
    }
    function dispatch(enter) {
      guard();
      if (dispatchCount >= 16) return Promise.reject(refused('VM_HOST_COMMAND_QUEUE_FULL'));
      dispatchCount++;
      // Exact whole-record queue: permission/currentness is refreshed inside the
      // queued original closure before any guest write, never inferred from wait.
      const original = dispatchTail.then(() => {
        guard();
        return enter();
      });
      jobs.add(original);
      dispatchTail = original.then(
        () => {},
        () => {}
      );
      const settled = () => {
        dispatchCount--;
        jobs.delete(original);
      };
      void original.then(settled, settled);
      return original;
    }
    function scheduleNeutralization(tab) {
      if (tab.safety) return tab.safety;
      // At most one reserved safety slot per already bounded tab. It shares the
      // actual command tail but cannot be displaced by the ordinary 16-slot bank.
      const original = dispatchTail.then(() => {
        guard();
        if (tab.keys.size || tab.buttons.size || tab.composing) return record.neutralizeInput(tab);
      });
      tab.safety = original;
      jobs.add(original);
      dispatchTail = original.then(
        () => {},
        () => {}
      );
      void original.then(
        () => {
          jobs.delete(original);
          if (tab.safety === original) tab.safety = undefined;
        },
        () => {
          jobs.delete(original);
          if (tab.safety === original) tab.safety = undefined;
          void retire('engineFault');
        }
      );
      return original;
    }
    function retire(cause) {
      if (retiring) return retiring;
      phase = 'retiring';
      for (const tab of tabs.values()) {
        tab.stopped = true;
        tab.pointer = null;
        tab.diagnostics.retire();
      }
      retiring = (async () => {
        // An entered acquisition is independently retained in jobs. Its eventual
        // genuine session must be stopped even when it arrives after this fence.
        let closed;
        const releases = [...transfers].map((owner) => Promise.resolve().then(() => owner.close()));
        if (session)
          releases.push(
            Promise.resolve()
              .then(() => session.close())
              .then((value) => {
                closed = value;
              })
          );
        for (const row of await Promise.allSettled(releases))
          if (row.status === 'rejected') first ??= { value: row.reason };
        while (jobs.size) await Promise.allSettled([...jobs]);
        if (session && !closed)
          try {
            closed = await session.close();
          } catch (value) {
            first ??= { value };
          }
        phase = 'terminal';
        // CPU/pipe closure is not clean writable-profile recovery. Until the
        // genuine filesystem/browser handback is qualified, registry quarantine
        // remains intact even after a successfully closed original process.
        const result = Object.freeze({
          firstCause: cause,
          owners: Object.freeze([]),
          cleanup: Object.freeze({
            state: 'unverified',
            coverage: 'unavailable',
            pending: false,
            uncertainty: Object.freeze(['observationUnavailable']),
          }),
          terminal: Object.freeze({ cleanup: 'unverified', reason: 'observationUnavailable' }),
          uncertainty: Object.freeze(['persistenceUnknown']),
          originalVMClosure: closed?.originalClosure ?? null,
        });
        resolveObservation(result);
        // Keep the immutable receiver/observation alive for the registry; only the
        // internal terminal map entry can be collected after genuine owned closure.
        if (
          jobs.size === 0 &&
          transfers.size === 0 &&
          (!session || selectedSession?.physicallyClosed())
        )
          records.delete(browserId);
        return result;
      })();
      void retiring.catch(() => {});
      return retiring;
    }
    const receiver = Object.freeze({
      browserId,
      browserGeneration,
      acquisition,
      observation,
      isOrdinary: ordinary,
      isAuthorityCurrent: () =>
        ordinary() && !!runtimeSubject?.current() && !!selectedSession?.runtimeCurrent(),
      observeOriginalDiagnostic(event) {
        guard();
        const tab = tabs.get(event.tabId);
        if (!tab || tab.stopped) throw refused('VM_DIAGNOSTIC_TAB_REQUIRED');
        tab.diagnostics.observe(event);
      },
      observeOriginalNavigation(event) {
        guard();
        const tab = tabs.get(event.tabId);
        if (!tab || tab.stopped) throw refused('VM_NAVIGATION_TAB_REQUIRED');
        tab.diagnostics.clear();
        tab.pointer = null;
        tab.binding = Object.freeze({
          ...tab.binding,
          navigationGeneration: advanceCounter(tab.binding.navigationGeneration),
          epoch: advanceCounter(tab.binding.epoch),
          inputGeneration: advanceCounter(tab.binding.inputGeneration),
        });
        // Observation cannot authorize a navigation. It only fences old effects.
        if (tab.keys.size || tab.buttons.size || tab.composing)
          void scheduleNeutralization(tab).catch(() => {});
      },
      verifiedBrowserAdminEndpoint: () => null,
      verifiedRuntimeBinding: () =>
        ordinary() && runtimeSubject?.current() && selectedSession?.runtimeCurrent()
          ? runtimeSubject.binding
          : null,
      navigateInitial(value) {
        if (!navigateInitial)
          return Promise.reject(refused('VM_ORIGINAL_NAVIGATION_DISPATCHER_REQUIRED'));
        guard();
        return navigateInitial(value);
      },
      disabled: () => retire('disabled'),
      authorityRevoked: () => retire('authorityRevoked'),
      persistenceFailure: () => retire('persistenceFailure'),
      generationReturned: async () => null,
      consumeGenerationReturn: () => false,
    });
    const record = Object.freeze({
      browserId,
      browserGeneration,
      command,
      receiver,
      guard,
      ordinary,
      own,
      dispatch,
      retire,
      attachOriginalRuntimeSubject(token, release) {
        guard();
        if (runtimeSubject) throw refused('VM_RUNTIME_SUBJECT_REPLACEMENT');
        runtimeSubject = inspectOriginalVMRuntimeSubject(token, release);
        guard();
      },
      installInitialNavigation(original) {
        if (navigateInitial || typeof original !== 'function')
          throw refused('VM_NAVIGATION_INSTALL_ONCE');
        guard();
        navigateInitial = original;
      },
      attachOriginalSession(original) {
        const selected = inspectOriginalManagedVMSession(original, receiver);
        if (session) throw refused('VM_SESSION_REPLACEMENT');
        session = original;
        selectedSession = selected;
        void original.retired.then(() => {
          if (session === original && ordinary()) void retire('engineFault');
        });
        if (selected.browserId !== browserId || selected.browserGeneration !== browserGeneration)
          throw refused('VM_SESSION_OCCURRENCE');
        if (!ordinary()) {
          const close = original.close();
          jobs.add(close);
          void close.then(
            () => jobs.delete(close),
            (value) => {
              first ??= { value };
              jobs.delete(close);
            }
          );
          throw refused('VM_RECORD_RETIRED');
        }
        selected.guard();
      },
      async publishTab() {
        guard();
        if (!session) throw refused('VM_ORIGINAL_SESSION_REQUIRED');
        if (tabs.size >= 64) throw refused('VM_TAB_BANK');
        const tabId = randomBytes(16).toString('base64url');
        const tab = {
          binding: Object.freeze({
            browserId,
            browserGeneration,
            tabId,
            navigationGeneration: 0,
            viewportVersion: 0,
            epoch: 0,
            inputGeneration: 0,
          }),
          captureSequence: 0,
          diagnostics: diagnostics.open(),
          pointer: null,
          keys: new Set(),
          buttons: new Set(),
          buttonAnchors: new Map(),
          composing: false,
          inputEntered: false,
          stopped: false,
          pending: false,
        };
        tabs.set(tabId, tab);
        await dispatch(() => session.createTab(tabId));
        guard();
        if (tabs.get(tabId) !== tab || tab.stopped) throw refused('VM_TAB_RETIRED');
        phase = 'running';
        return tab.binding;
      },
      exactTab(binding) {
        guard();
        const tab = tabs.get(binding.tabId);
        if (!tab || tab.stopped || !same(tab.binding, binding)) throw refused('VM_STALE_BINDING');
        return tab;
      },
      retainOriginalTransfer(owner) {
        guard();
        inspectOriginalVMTransfer(owner, record);
        if (transfers.size >= 2) throw refused('VM_TRANSFER_OWNER_BANK');
        transfers.add(owner);
        return () => {
          transfers.delete(owner);
        };
      },
      originalSession() {
        guard();
        if (!session) throw refused('VM_ORIGINAL_SESSION_REQUIRED');
        inspectOriginalManagedVMSession(session, receiver).guard();
        return session;
      },
      publishFrame(binding, raster, pointerBefore) {
        const tab = record.exactTab(binding);
        inspectOriginalManagedVMRaster(session, raster);
        if (
          raster.kind !== 'guest-observational-raster' ||
          raster.tabId !== binding.tabId ||
          !(raster.jpeg instanceof Uint8Array)
        )
          throw refused('VM_ORIGINAL_RASTER_REQUIRED');
        const captureSequence = advanceCounter(tab.captureSequence);
        const receipt = parseBrowserResult({
          kind: 'frame',
          binding,
          captureSequence,
          width: selectedSession.width,
          height: selectedSession.height,
          rasterWidth: selectedSession.width,
          rasterHeight: selectedSession.height,
          byteLength: raster.jpeg.length,
          format: 'jpeg',
          pointer: pointerBefore === tab.pointer ? tab.pointer : null,
        });
        record.exactTab(binding);
        tab.captureSequence = captureSequence;
        return Object.freeze({ receipt, bytes: Uint8Array.from(raster.jpeg) });
      },
      async neutralizeInput(tab) {
        guard();
        if (tabs.get(tab.binding.tabId) !== tab || tab.stopped) throw refused('VM_TAB_RETIRED');
        const original = record.originalSession();
        let failure;
        // Internal safety cleanup uses the retained original depressed-state ledger,
        // not a new caller gesture grant. Every entered release callback is joined.
        for (const key of [...tab.keys])
          try {
            await original.key(
              tab.binding.tabId,
              'keyUp',
              key === 'Space' ? ' ' : key,
              { Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft' }[
                key
              ] ?? key
            );
            tab.keys.delete(key);
          } catch (value) {
            failure ??= { value };
          }
        for (const button of [...tab.buttons])
          try {
            const point = tab.buttonAnchors.get(button);
            if (!point) throw refused('VM_HELD_BUTTON_ANCHOR_REQUIRED');
            await original.pointer(tab.binding.tabId, 'mouseReleased', point.x, point.y, button);
            tab.buttons.delete(button);
            tab.buttonAnchors.delete(button);
          } catch (value) {
            failure ??= { value };
          }
        for (const cancel of [
          () => original.cancelComposition(tab.binding.tabId),
          () => original.cancelDrag(tab.binding.tabId),
        ])
          try {
            await cancel();
          } catch (value) {
            failure ??= { value };
          }
        if (failure) {
          void retire('engineFault');
          throw failure.value;
        }
        tab.composing = false;
        guard();
        tab.diagnostics.clear();
        tab.pointer = null;
        tab.binding = Object.freeze({
          ...tab.binding,
          epoch: advanceCounter(tab.binding.epoch),
          inputGeneration: advanceCounter(tab.binding.inputGeneration),
        });
        return tab.binding;
      },
      resetInput(binding) {
        const tab = record.exactTab(binding);
        return dispatch(() => {
          if (record.exactTab(binding) !== tab) throw refused('VM_STALE_BINDING');
          return record.neutralizeInput(tab);
        });
      },
      diagnostics(binding) {
        return record.exactTab(binding).diagnostics.summary(binding);
      },
      listTabs() {
        guard();
        return Object.freeze(
          [...tabs.values()].filter((tab) => !tab.stopped).map((tab) => tab.binding)
        );
      },
    });
    records.set(browserId, record);
    originalRecords.add(record);
    return record;
  }
  return Object.freeze({
    issue,
    get(browserId, generation) {
      const record = records.get(browserId);
      if (!record || record.browserGeneration !== generation || !originalRecords.has(record))
        throw refused('VM_ORIGINAL_RECORD_REQUIRED');
      return record;
    },
  });
}
