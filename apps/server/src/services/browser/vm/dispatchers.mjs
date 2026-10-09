import { createOriginalVMUpload, createOriginalVMDownload } from './transfer-owners.mjs';
import {
  parseBrowserUpload,
  parseBrowserDownload,
  parseBrowserBinding,
} from '@dorkos/browser/server-owner';
import { parseBrowserCommand, parseBrowserResult, advanceCounter } from '@dorkos/browser';
import {
  createOwnedCaptureIssuer,
  consumeOwnedCaptureWork,
  authorizeOwnedCaptureWork,
  ownedCaptureWorkCurrent,
  settleOwnedCaptureWork,
  createOwnedNavigationIssuer,
  consumeOwnedNavigationWork,
  authorizeOwnedNavigation,
  ownedNavigationCurrent,
  createOwnedInputIssuer,
  consumeOwnedInputWork,
  authorizeOwnedInputWork,
  ownedInputWorkCurrent,
  settleOwnedInputWork,
  hasOwnedUploadCompletion,
  beginOwnedUpload,
  completeOwnedUpload,
} from '@dorkos/browser/server-owner';
import { verifyOriginalVMNavigationPublication } from './navigation-publication.mjs';
import { isOriginalManagedVMStaleCommand } from '../runtime/managed-vm-acquisition.mjs';
const { AbortController } = globalThis;
const refused = (code) => new Error(code);
const keyCode = (key) =>
  ({ Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft' })[key] ?? key;
/** Actual original server dispatchers use the existing private work issuers.
 * Public engine calls cannot supply a Work or a replacement VM transport. */
export function installOriginalVMDispatchers(records, birthOwner, policy) {
  const captureOwner = birthOwner.capture,
    navigationOwner = birthOwner.navigation,
    inputOwner = birthOwner.input;
  const registerCapture = captureOwner.registerDispatcher.bind(captureOwner),
    registerNavigation = navigationOwner.registerDispatcher.bind(navigationOwner),
    registerInput = inputOwner.registerDispatcher.bind(inputOwner);
  const authorizeAction = policy.authorizeAction.bind(policy);
  const policyAllowed = async (binding, signal) => {
    if (signal.aborted || (await authorizeAction(binding, signal)) !== 'allowed' || signal.aborted)
      throw refused('VM_ENGINE_POLICY_REFUSED');
  };
  const captureIssuer = createOwnedCaptureIssuer(),
    navigationIssuer = createOwnedNavigationIssuer(),
    inputIssuer = createOwnedInputIssuer();
  const get = (binding) => records.get(binding.browserId, binding.browserGeneration);
  const capture = Object.freeze({
    async capture(value, authorization) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'capture') throw refused('VM_CAPTURE_COMMAND');
      const record = get(command.binding),
        tab = record.exactTab(command.binding),
        work = Object.freeze({}),
        token = captureIssuer.issue(value, authorization),
        abort = new AbortController();
      try {
        if (!consumeOwnedCaptureWork(token, command, work)) throw refused('VM_CAPTURE_AUTHORITY');
        return await record.dispatch(async () => {
          if (
            !ownedCaptureWorkCurrent(token, work) ||
            (await authorizeOwnedCaptureWork(token, work, command.binding, abort.signal)) !==
              'allowed'
          )
            throw refused('VM_CAPTURE_AUTHORITY');
          await policyAllowed(command.binding, abort.signal);
          record.exactTab(command.binding);
          if (!ownedCaptureWorkCurrent(token, work)) throw refused('VM_CAPTURE_AUTHORITY');
          const pointerBefore = tab.pointer;
          const raster = await record.originalSession().capture(command.binding.tabId);
          await policyAllowed(command.binding, abort.signal);
          record.exactTab(command.binding);
          if (
            !ownedCaptureWorkCurrent(token, work) ||
            (await authorizeOwnedCaptureWork(token, work, command.binding, abort.signal)) !==
              'allowed'
          )
            throw refused('VM_CAPTURE_AUTHORITY');
          if (record.exactTab(command.binding) !== tab || !ownedCaptureWorkCurrent(token, work))
            throw refused('VM_CAPTURE_AUTHORITY');
          return record.publishFrame(command.binding, raster, pointerBefore);
        });
      } finally {
        abort.abort();
        settleOwnedCaptureWork(token, work);
        captureIssuer.invalidate(token);
      }
    },
  });
  const navigation = Object.freeze({
    async navigate(value, authorization, signal) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'navigate') throw refused('VM_NAVIGATION_COMMAND');
      const record = get(command.binding),
        tab = record.exactTab(command.binding),
        work = Object.freeze({}),
        token = navigationIssuer.issue(value, authorization),
        abort = new AbortController();
      const cancel = () => abort.abort();
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) abort.abort();
        if (!consumeOwnedNavigationWork(token, command, work))
          throw refused('VM_NAVIGATION_AUTHORITY');
        return await record.dispatch(async () => {
          if (
            (await authorizeOwnedNavigation(
              token,
              work,
              command.binding,
              command.url,
              abort.signal
            )) !== 'allowed'
          )
            throw refused('VM_NAVIGATION_AUTHORITY');
          if (record.exactTab(command.binding) !== tab || !ownedNavigationCurrent(token, work))
            throw refused('VM_NAVIGATION_AUTHORITY');
          // Invalidate the old visual/control occurrence before entering navigation.
          tab.diagnostics.clear();
          tab.pointer = null;
          tab.binding = Object.freeze({
            ...tab.binding,
            navigationGeneration: advanceCounter(tab.binding.navigationGeneration),
            epoch: advanceCounter(tab.binding.epoch),
          });
          const binding = tab.binding;
          await policyAllowed(binding, abort.signal);
          record.exactTab(binding);
          if (!ownedNavigationCurrent(token, work)) throw refused('VM_NAVIGATION_AUTHORITY');
          const original = record.originalSession();
          try {
            await original.navigate(binding.tabId, command.url);
          } catch (value) {
            if (!isOriginalManagedVMStaleCommand(original, value))
              void record.retire('engineFault');
            throw value;
          }
          const completedBinding = await verifyOriginalVMNavigationPublication(
            record,
            tab,
            tab.binding,
            token,
            work,
            command.url,
            abort.signal,
            policyAllowed
          );
          // Guest3 completion joins the exact original load/same-document milestone.
          // It conveys no paint or viewer acknowledgement.
          return completedBinding;
        });
      } finally {
        abort.abort();
        signal?.removeEventListener('abort', cancel);
        navigationIssuer.invalidate(token);
      }
    },
  });
  const input = Object.freeze({
    async input(value, authorization, signal) {
      const command = parseBrowserCommand(value);
      if (command.kind !== 'input') throw refused('VM_INPUT_COMMAND');
      const steps = command.steps.flatMap((step) =>
        step.kind === 'click'
          ? [
              { kind: 'mouseMove', x: step.x, y: step.y },
              { kind: 'mouseDown', button: step.button },
              { kind: 'mouseUp', button: step.button },
            ]
          : [step]
      );
      if (steps.length > 16) throw refused('VM_INPUT_UNSUPPORTED');
      const record = get(command.binding),
        tab = record.exactTab(command.binding),
        work = Object.freeze({}),
        token = inputIssuer.issue(value, authorization),
        abort = new AbortController();
      const cancel = () => abort.abort();
      try {
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) abort.abort();
        if (!consumeOwnedInputWork(token, command, work)) throw refused('VM_INPUT_AUTHORITY');
        return await record.dispatch(async () => {
          let uploadBegun = false;
          try {
            for (const step of steps) {
              if (
                (await authorizeOwnedInputWork(
                  token,
                  work,
                  command.binding,
                  step,
                  abort.signal
                )) !== 'allowed' ||
                !ownedInputWorkCurrent(token, work) ||
                record.exactTab(command.binding) !== tab
              )
                throw refused('VM_INPUT_AUTHORITY');
              await policyAllowed(command.binding, abort.signal);
              record.exactTab(command.binding);
              if (!ownedInputWorkCurrent(token, work)) throw refused('VM_INPUT_AUTHORITY');
              const session = record.originalSession();
              if (!uploadBegun && hasOwnedUploadCompletion(token, work)) {
                await beginOwnedUpload(token, work, abort.signal);
                uploadBegun = true;
                record.exactTab(command.binding);
                if (abort.signal.aborted || !ownedInputWorkCurrent(token, work))
                  throw refused('VM_INPUT_AUTHORITY');
                await policyAllowed(command.binding, abort.signal);
                record.exactTab(command.binding);
                if (!ownedInputWorkCurrent(token, work)) throw refused('VM_INPUT_AUTHORITY');
              }
              tab.inputEntered = true;
              if (step.kind === 'mouseMove') {
                const revision = advanceCounter(tab.pointerRevision ?? 0);
                tab.pointerRevision = revision;
                tab.pointer = null;
                await session.pointer(command.binding.tabId, 'mouseMoved', step.x, step.y, 'none');
                record.exactTab(command.binding);
                if (!ownedInputWorkCurrent(token, work)) throw refused('VM_INPUT_AUTHORITY');
                tab.pointer = Object.freeze({ x: step.x, y: step.y, revision });
              } else if (
                step.kind === 'mouseDown' ||
                step.kind === 'mouseUp' ||
                step.kind === 'wheel'
              ) {
                const pointer = tab.pointer;
                if (!pointer) throw refused('VM_POINTER_ANCHOR_REQUIRED');
                if (step.kind === 'wheel')
                  await session.wheel(
                    command.binding.tabId,
                    pointer.x,
                    pointer.y,
                    step.deltaX,
                    step.deltaY
                  );
                else {
                  if (step.kind === 'mouseDown') {
                    tab.buttons.add(step.button);
                    tab.buttonAnchors.set(step.button, pointer);
                  }
                  await session.pointer(
                    command.binding.tabId,
                    step.kind === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
                    pointer.x,
                    pointer.y,
                    step.button
                  );
                  if (step.kind === 'mouseUp') {
                    tab.buttons.delete(step.button);
                    tab.buttonAnchors.delete(step.button);
                  }
                }
              } else if (step.kind === 'keyDown' || step.kind === 'keyUp') {
                if (step.kind === 'keyDown') tab.keys.add(step.key);
                await session.key(
                  command.binding.tabId,
                  step.kind === 'keyDown' ? 'keyDown' : 'keyUp',
                  step.key === 'Space' ? ' ' : step.key,
                  keyCode(step.key)
                );
                if (step.kind === 'keyUp') tab.keys.delete(step.key);
              } else if (step.kind === 'composition') {
                tab.composing = true;
                await session.composition(
                  command.binding.tabId,
                  step.text,
                  step.selectionStart,
                  step.selectionEnd
                );
              } else if (step.kind === 'compositionCommit') {
                await session.compositionCommit(command.binding.tabId, step.text);
                tab.composing = false;
              } else if (step.kind === 'text') await session.text(command.binding.tabId, step.text);
              else throw refused('VM_INPUT_UNSUPPORTED');
              record.exactTab(command.binding);
              if (abort.signal.aborted || !ownedInputWorkCurrent(token, work))
                throw refused('VM_INPUT_AUTHORITY');
            }
            if (uploadBegun) {
              await completeOwnedUpload(token, work, command.binding, abort.signal);
              record.exactTab(command.binding);
              if (abort.signal.aborted || !ownedInputWorkCurrent(token, work))
                throw refused('VM_INPUT_AUTHORITY');
              await policyAllowed(command.binding, abort.signal);
              record.exactTab(command.binding);
              if (!ownedInputWorkCurrent(token, work)) throw refused('VM_INPUT_AUTHORITY');
            }
            return parseBrowserResult({
              kind: 'action',
              requestId: command.requestId,
              binding: command.binding,
              outcome: 'completed',
            });
          } catch (value) {
            // Preserve the caller's original refusal while independently joining all
            // charged original key/button releases before this queue slot settles.
            if (tab.keys.size || tab.buttons.size || tab.composing)
              try {
                await record.neutralizeInput(tab);
              } catch {
                void record.retire('engineFault');
              }
            throw value;
          }
        });
      } finally {
        abort.abort();
        signal?.removeEventListener('abort', cancel);
        settleOwnedInputWork(token, work);
        inputIssuer.invalidate(token);
      }
    },
  });
  function transferDispatcher(download) {
    return Object.freeze({
      [download ? 'download' : 'upload']: async (value, authority, original, signal) => {
        const request = (download ? parseBrowserDownload : parseBrowserUpload)(value),
          record = get(request.binding),
          tab = record.exactTab(request.binding),
          leaseBinding = parseBrowserBinding(original.binding);
        const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
        if (
          !same(leaseBinding, request.binding) ||
          (!download && original.artifactId !== request.artifactId)
        )
          throw refused('VM_TRANSFER_BINDING');
        const current = authority.isCurrent.bind(authority),
          authorize = authority.authorize.bind(authority);
        const admitted = () => {
          try {
            return current() && record.exactTab(request.binding) === tab && current();
          } catch {
            return false;
          }
        };
        let owner, first, result, closing;
        const close = () =>
          (closing ??= Promise.resolve().then(() =>
            owner ? owner.close() : download ? undefined : original.close()
          ));
        const cancel = () => {
          void close().catch(() => {});
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (signal?.aborted || !admitted()) throw refused('VM_TRANSFER_AUTHORITY');
          owner = (download ? createOriginalVMDownload : createOriginalVMUpload)(
            record,
            original,
            admitted
          );
          result = await input.input(
            {
              kind: 'input',
              requestId: request.requestId,
              binding: request.binding,
              steps: [
                { kind: 'click', x: request.activation.x, y: request.activation.y, button: 'left' },
              ],
            },
            Object.freeze({
              isCurrent: admitted,
              authorize,
              beginUpload: owner.begin.bind(owner),
              completeUpload: owner.complete.bind(owner),
            }),
            signal
          );
          if (!admitted() || signal?.aborted) throw refused('VM_TRANSFER_AUTHORITY');
        } catch (value) {
          first = { value };
        }
        try {
          await close();
        } catch (value) {
          first ??= { value };
        } finally {
          signal?.removeEventListener('abort', cancel);
        }
        if (first) throw first.value;
        return download ? Object.freeze({ input: result, artifact: owner.artifact() }) : result;
      },
    });
  }
  if (birthOwner.upload) {
    const owner = birthOwner.upload,
      register = owner.registerDispatcher.bind(owner);
    register(transferDispatcher(false));
  }
  if (birthOwner.download) {
    const owner = birthOwner.download,
      register = owner.registerDispatcher.bind(owner);
    register(transferDispatcher(true));
  }
  // Capture original registration receivers/functions once, before any birth.
  registerCapture(capture);
  registerNavigation(navigation);
  registerInput(input);
  return Object.freeze({ capture, navigation, input });
}
