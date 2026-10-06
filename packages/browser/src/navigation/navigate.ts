import { parseBrowserCommand, type BrowserBinding } from '../contracts.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import type { Request } from 'playwright-core';
import { sameBinding } from '../input/binding.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { ownOperation } from '../lifecycle/ownership.js';
import { deadline } from '../lifecycle/deadline.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
import {
  claimNavigation,
  currentNavigation,
  finishNavigation,
  navigationResetObserved,
  navigationStateCurrent,
} from './cohort.js';
import { joinTabCaptureOriginals } from '../tabs/capture.js';
import { resetInput } from '../lifecycle/parent-actions.js';
import {
  consumeOwnedNavigationWork,
  ownedNavigationCurrent,
  authorizeOwnedNavigation,
  type OwnedNavigationWork,
} from './owned-work.js';

/** Constructor-private reusable Page transition; no public navigation or body-issued capability. */
export async function navigateOwned(
  config: EngineConfiguration,
  record: BrowserRecord,
  current: () => boolean,
  value: unknown,
  token: OwnedNavigationWork,
  signal?: AbortSignal
): Promise<Readonly<BrowserBinding>> {
  if (config.network.kind !== 'owned')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const end = performance.now() + 5000;
  const command = parseBrowserCommand(value);
  if (command.kind !== 'navigate') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
  const originalTab = record.tabs.get(command.binding.tabId);
  if (!originalTab) throw new BrowserLifecycleError('STALE_BINDING');
  // Host viewer loss has already stopped new captures. Retain the genuine raw
  // screenshot receiver through natural settlement before claiming its tab.
  try {
    await deadline(
      Promise.resolve().then(async () => {
        await originalTab.tail;
        await joinTabCaptureOriginals(originalTab);
      }),
      5000,
      'NAVIGATION_TIMEOUT'
    );
  } catch (reason) {
    record.lifetime.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
    throw reason;
  }
  if (record.tabs.get(command.binding.tabId) !== originalTab)
    throw new BrowserLifecycleError('STALE_BINDING');
  const owner = claimNavigation(record, command.binding, current);
  if (!owner) throw new BrowserLifecycleError('STALE_BINDING');
  if (!consumeOwnedNavigationWork(token, command, owner)) {
    finishNavigation(owner, false);
    throw new BrowserLifecycleError('POLICY_REFUSED');
  }
  const slot = record.lifetime.inputs.get(owner.tab);
  const handle = slot?.handle;
  // The original main-frame callback commits this mutable state while goto is pending.
  const committed = (): boolean => owner.phase === 'committed';
  const guard = () => {
    // Original runtime/network/native custody reads can synchronously revoke host authority.
    const originals = {
      context: record.context,
      proxy: record.proxy,
      directory: record.directory,
      dataRoot: record.dataRoot,
      journal: record.journal,
      supervisor: record.supervisor,
      networkPeer: record.networkPeer,
      networkCustody: record.networkCustody,
      root: record.root,
    };
    const custody = currentAuthorityCustody(record, current);
    const canonical = currentNavigation(owner);
    const authorized = ownedNavigationCurrent(token, owner);
    if (
      !custody ||
      !canonical ||
      !authorized ||
      signal?.aborted ||
      !navigationStateCurrent(owner) ||
      record.context !== originals.context ||
      record.proxy !== originals.proxy ||
      record.directory !== originals.directory ||
      record.dataRoot !== originals.dataRoot ||
      record.journal !== originals.journal ||
      record.supervisor !== originals.supervisor ||
      record.networkPeer !== originals.networkPeer ||
      record.networkCustody !== originals.networkCustody ||
      record.root !== originals.root ||
      record.lifetime.inputs.get(owner.tab) !== slot ||
      !handle ||
      slot?.handle !== handle ||
      record.lifetime.gate.stopped ||
      record.status !== 'running' ||
      owner.tab.stopped ||
      record.tabs.get(owner.before.tabId) !== owner.tab ||
      owner.tab.page !== owner.page
    )
      throw new BrowserLifecycleError('STALE_BINDING');
  };
  const abort = new AbortController();
  const abortOriginal = abort.abort;
  const cancel = () => Reflect.apply(abortOriginal, abort, []);
  const onAbort = () => {
    try {
      cancel();
    } catch {
      owner.cleanupUncertain = true;
      record.lifetime.uncertain = true;
    }
    record.lifetime.requestRetirement('engineFault');
  };
  let removeAbort: (() => void) | undefined;
  try {
    if (signal) {
      const add = signal.addEventListener,
        remove = signal.removeEventListener;
      removeAbort = () => Reflect.apply(remove, signal, ['abort', onAbort]);
      Reflect.apply(add, signal, ['abort', onAbort, { once: true }]);
    }
  } catch (error) {
    owner.cleanupUncertain = true;
    record.lifetime.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
    finishNavigation(owner, false);
    throw error;
  }
  const releaseAbort = () => {
    try {
      removeAbort?.();
    } catch {
      owner.cleanupUncertain = true;
      record.lifetime.uncertain = true;
      record.lifetime.requestRetirement('engineFault');
    }
  };
  let settled = false;
  let failedWait = false;
  const original = ownOperation(record, async () => {
    if (command.kind !== 'navigate' || !sameBinding(command.binding, owner.before))
      throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    const target = new URL(command.url);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
    owner.target = target.href;
    guard();
    if (
      (await authorizeOwnedNavigation(token, owner, owner.binding, command.url, abort.signal)) !==
      'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    const reset = await resetInput(record, owner.before, owner);
    guard();
    if (reset.status !== 'ready' || !navigationResetObserved(owner, reset.binding))
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    const authorize = config.policy.authorizeAction;
    guard();
    if (
      (await Reflect.apply(authorize, config.policy, [owner.binding, abort.signal])) !== 'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    if (
      (await authorizeOwnedNavigation(token, owner, owner.binding, command.url, abort.signal)) !==
      'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    const on = owner.page.on,
      off = owner.page.off,
      goto = owner.page.goto;
    guard();
    let request: Request | undefined;
    // The SDK routes only the initial redirect URL. These genuine request observations
    // correlate the bounded flow; per-destination contact is independently broker-owned.
    let rootRequest: Request | undefined;
    let redirects = 0;

    const observe = (candidate: Request) => {
      try {
        if (!candidate.isNavigationRequest() || candidate.frame() !== owner.page.mainFrame())
          return;
        guard();
        const previous = candidate.redirectedFrom();
        const url = new URL(candidate.url());
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          !currentNavigation(owner) ||
          owner.phase !== 'entered'
        )
          throw new Error('NAVIGATION_COMPETING_REQUEST');
        if (!request) {
          if (previous !== null || url.href !== owner.target)
            throw new Error('NAVIGATION_ROOT_REQUEST_REFUSED');
          rootRequest = candidate;
        } else {
          if (candidate === request || previous !== request || !rootRequest || ++redirects > 16)
            throw new Error('NAVIGATION_REDIRECT_CHAIN_REFUSED');
        }
        request = candidate;
        owner.target = url.href;
      } catch {
        record.lifetime.requestRetirement('engineFault');
      }
    };
    let registered = false;
    let primary: unknown;
    let hasPrimary = false;
    let result: Readonly<BrowserBinding> | undefined;
    try {
      registered = true;
      Reflect.apply(on, owner.page, ['request', observe]);
      guard();
      owner.phase = 'entered';
      const response = (await Reflect.apply(goto, owner.page, [
        owner.target,
        { timeout: 5000, waitUntil: 'domcontentloaded' },
      ])) as Awaited<ReturnType<typeof goto>>;
      guard();
      if (
        !response ||
        response.request() !== request ||
        response.url() !== owner.target ||
        !(committed() && owner.adopted && currentNavigation(owner)) ||
        owner.page.url() !== owner.target
      )
        throw new BrowserLifecycleError('STALE_BINDING');
      guard();
      result = Object.freeze({ ...owner.tab.binding });
    } catch (error) {
      hasPrimary = true;
      primary = error;
    }
    if (registered) {
      try {
        Reflect.apply(off, owner.page, ['request', observe]);
      } catch (error) {
        owner.cleanupUncertain = true;
        record.lifetime.uncertain = true;
        record.lifetime.requestRetirement('engineFault');
        if (!hasPrimary) {
          hasPrimary = true;
          primary = error;
        }
      }
    }
    if (hasPrimary) throw primary;
    guard();
    if (
      (await authorizeOwnedNavigation(
        token,
        owner,
        owner.tab.binding,
        command.url,
        abort.signal
      )) !== 'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    if (
      (await Reflect.apply(authorize, config.policy, [owner.tab.binding, abort.signal])) !==
      'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    if (
      !result ||
      !(committed() && owner.adopted && currentNavigation(owner)) ||
      !sameBinding(owner.tab.binding, result)
    )
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    return result;
  });
  void original.then(
    () => {
      releaseAbort();
      settled = true;
      if (failedWait) finishNavigation(owner, false);
    },
    () => {
      releaseAbort();
      settled = true;
      record.lifetime.requestRetirement('engineFault');
      if (failedWait) finishNavigation(owner, false);
    }
  );
  try {
    const result = await deadline(
      original,
      Math.max(0, end - performance.now()),
      'NAVIGATION_TIMEOUT'
    );
    cancel();
    guard();
    if (
      !(committed() && owner.adopted && currentNavigation(owner)) ||
      !sameBinding(owner.tab.binding, result)
    )
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    finishNavigation(owner, true);
    return result;
  } catch (error) {
    failedWait = true;
    if (!settled) record.lifetime.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
    try {
      cancel();
    } catch {
      owner.cleanupUncertain = true;
      record.lifetime.uncertain = true;
    }
    if (settled) finishNavigation(owner, false);
    throw error;
  }
}
