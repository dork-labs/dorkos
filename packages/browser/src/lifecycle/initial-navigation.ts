import { parseBrowserCommand, type BrowserBinding } from '../contracts.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord } from './records.js';
import type { Request } from 'playwright-core';
import { sameBinding } from '../input/binding.js';
import { BrowserLifecycleError } from './errors.js';
import { ownOperation } from './ownership.js';
import { deadline } from './deadline.js';
import { currentAuthorityCustody } from './live-custody.js';
import {
  claimInitialNavigation,
  currentInitialNavigation,
  finishInitialNavigation,
  initialNavigationCommitted,
} from './initial-navigation-state.js';

/** Private first-document navigation only; no public Page or reusable arbitrary navigation port. */
export async function navigateOwnedInitial(
  config: EngineConfiguration,
  record: BrowserRecord,
  current: () => boolean,
  value: unknown
): Promise<Readonly<BrowserBinding>> {
  if (config.network.kind !== 'owned')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const owner = claimInitialNavigation(record, current);
  if (!owner) throw new BrowserLifecycleError('STALE_BINDING');
  const slot = record.lifetime.inputs.get(owner.tab);
  const handle = slot?.handle;
  const guard = () => {
    if (
      !currentInitialNavigation(owner) ||
      record.lifetime.inputs.get(owner.tab) !== slot ||
      !handle ||
      slot?.handle !== handle ||
      typeof handle.hasNeverEnteredInput !== 'function' ||
      !handle.hasNeverEnteredInput() ||
      !currentAuthorityCustody(record, current)
    )
      throw new BrowserLifecycleError('STALE_BINDING');
  };
  const abort = new AbortController();
  const abortOriginal = abort.abort;
  const cancel = () => Reflect.apply(abortOriginal, abort, []);
  let settled = false;
  let failedWait = false;
  const original = ownOperation(record, async () => {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'navigate' || !sameBinding(command.binding, owner.binding))
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
    const readURL = owner.page.url;
    guard();
    if (Reflect.apply(readURL, owner.page, []) !== 'about:blank')
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    const authorize = config.policy.authorizeAction;
    guard();
    if (
      (await Reflect.apply(authorize, config.policy, [owner.binding, abort.signal])) !== 'allowed'
    )
      throw new BrowserLifecycleError('POLICY_REFUSED');
    guard();
    const on = owner.page.on,
      off = owner.page.off,
      goto = owner.page.goto;
    guard();
    let request: Request | undefined;
    const observe = (candidate: Request) => {
      try {
        if (!candidate.isNavigationRequest() || candidate.frame() !== owner.page.mainFrame())
          return;
        if (!currentInitialNavigation(owner) || request || candidate.url() !== owner.target)
          throw new Error('INITIAL_NAVIGATION_COMPETING_REQUEST');
        request = candidate;
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
        !initialNavigationCommitted(owner) ||
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
    if (!result || !initialNavigationCommitted(owner) || !sameBinding(owner.tab.binding, result))
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    return result;
  });
  void original.then(
    () => {
      settled = true;
      if (failedWait) finishInitialNavigation(owner, false);
    },
    () => {
      settled = true;
      record.lifetime.requestRetirement('engineFault');
      if (failedWait) finishInitialNavigation(owner, false);
    }
  );
  try {
    const result = await deadline(original, 5000, 'NAVIGATION_TIMEOUT');
    cancel();
    guard();
    if (!initialNavigationCommitted(owner) || !sameBinding(owner.tab.binding, result))
      throw new BrowserLifecycleError('STALE_BINDING');
    guard();
    finishInitialNavigation(owner, true);
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
    if (settled) finishInitialNavigation(owner, false);
    throw error;
  }
}
