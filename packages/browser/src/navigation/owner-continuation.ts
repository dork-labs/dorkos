import { OriginalSameDocumentObserver } from './native-same-document.js';
import { registerOwnerSameDocument } from './owner-same-document.js';
import type { Request, Route } from 'playwright-core';
import type { BrowserBinding } from '../contracts.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { ownOperation } from '../lifecycle/ownership.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { deadline } from '../lifecycle/deadline.js';
import { initialNavigationPending } from '../lifecycle/initial-navigation-state.js';
import { resetInput } from '../lifecycle/parent-actions.js';
import { joinTabCaptureOriginals } from '../tabs/capture.js';
import { sameBinding } from '../input/binding.js';
import type { OwnedNavigationAuthorization } from './owned-work.js';
import {
  claimNavigation,
  currentNavigation,
  finishNavigation,
  navigationResetObserved,
  navigationStateCurrent,
  prepareOwnerNavigation,
  finishOwnerPreparation,
  navigationHasCohort,
  commitNavigation,
  adoptObservedOwnerNavigation,
} from './cohort.js';

/** Captured constructor-private human owner continuation. Completion joins confer no permission. */
export interface PrivateOwnerNavigationContinuation {
  acquire(binding: BrowserBinding): Promise<
    Readonly<{
      authorization: OwnedNavigationAuthorization;
      ready: Promise<void>;
      complete(binding: BrowserBinding): void;
      close(): Promise<void>;
    }>
  >;
  joinPublications(binding: BrowserBinding): Promise<void>;
  /** Completion custody only; the original includes native listener/reset cleanup. */
  observeTransition?(binding: BrowserBinding, original: Promise<Readonly<BrowserBinding>>): void;
}

/** Install on the actual original Page; fallback preserves the original egress route chain.
 * Redirect destinations remain independently protected by the original broker. SDK route
 * callbacks occur only for the first redirect URL; request observations correlate the flow.
 */
export async function installOwnerNavigation(
  config: EngineConfiguration,
  record: BrowserRecord,
  tab: TabRecord,
  current: () => boolean,
  continuation: PrivateOwnerNavigationContinuation
): Promise<void> {
  if (config.network.kind !== 'owned')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const page = tab.page,
    frame = page.mainFrame(),
    route = page.route;
  if (record.ownerNavigationObserver) throw new BrowserLifecycleError('STALE_BINDING');
  const withinDocument = new OriginalSameDocumentObserver(record, tab, current);
  record.ownerNavigationObserver = Object.freeze({
    close: withinDocument.close.bind(withinDocument),
  });
  await withinDocument.start();
  const acquire = continuation.acquire.bind(continuation),
    join = continuation.joinPublications.bind(continuation),
    observeTransition = continuation.observeTransition?.bind(continuation);
  const alive = () => {
    const custody = currentAuthorityCustody(record, current);
    return (
      custody &&
      record.status === 'running' &&
      !record.lifetime.gate.stopped &&
      !record.lifetime.uncertain &&
      !tab.stopped &&
      record.tabs.get(tab.binding.tabId) === tab &&
      tab.page === page &&
      page.mainFrame() === frame
    );
  };
  const handler = async (originalRoute: Route, originalRequest: Request) => {
    // Actual SDK originals only. Subresources and already owned explicit cohorts keep their chain.
    const fallback = originalRoute.fallback.bind(originalRoute),
      abort = originalRoute.abort.bind(originalRoute);
    if (originalRoute.request() !== originalRequest) {
      await abort('aborted');
      return;
    }
    if (!originalRequest.isNavigationRequest() || originalRequest.frame() !== frame) {
      await fallback();
      return;
    }
    if (navigationHasCohort(tab) || initialNavigationPending(record)) {
      await fallback();
      return;
    }
    // This helper is installed after the original acquisition; no opening-time authority is inferred.
    const binding = Object.freeze({ ...tab.binding });
    const preparation =
      alive() && originalRequest.redirectedFrom() === null ? prepareOwnerNavigation(tab) : null;
    if (!preparation) {
      await abort('aborted');
      return;
    }
    const original = ownOperation(record, async () => {
      let cohort: ReturnType<typeof claimNavigation> = null;
      let flow: Awaited<ReturnType<typeof acquire>> | undefined;
      let failed = false,
        primary: unknown;
      const controller = new AbortController();
      const on = page.on.bind(page),
        off = page.off.bind(page);
      const authorizeOrdinary = config.policy.authorizeAction.bind(config.policy);
      let listening = false,
        request = originalRequest,
        redirects = 0;
      let resolveCommit!: () => void, rejectCommit!: (reason: unknown) => void;
      const committed = new Promise<void>((resolve, reject) => {
        resolveCommit = resolve;
        rejectCommit = reject;
      });
      void committed.catch(() => {});
      const guard = () => {
        const custody = alive(),
          canonical = cohort ? currentNavigation(cohort) : false;
        const authority = flow?.authorization.isCurrent();
        if (!authority || !custody || !canonical || !cohort || !navigationStateCurrent(cohort))
          throw new BrowserLifecycleError('STALE_BINDING');
      };
      const observeRequest = (candidate: Request) => {
        try {
          if (
            !candidate.isNavigationRequest() ||
            candidate.frame() !== frame ||
            candidate === originalRequest
          )
            return;
          guard();
          if (candidate.redirectedFrom() !== request || ++redirects > 16)
            throw new BrowserLifecycleError('STALE_BINDING');
          const target = new URL(candidate.url());
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
            throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
          request = candidate;
          cohort!.target = target.href;
        } catch (reason) {
          rejectCommit(reason);
          record.lifetime.requestRetirement('engineFault');
        }
      };
      const observeClose = () => rejectCommit(new BrowserLifecycleError('BROWSER_STOPPED'));
      const observeCommit = (observed: import('playwright-core').Frame) => {
        if (observed !== frame) return;
        try {
          guard();
          if (cohort!.phase !== 'committed' || !cohort!.adopted || page.url() !== cohort!.target)
            throw new BrowserLifecycleError('STALE_BINDING');
          resolveCommit();
        } catch (reason) {
          rejectCommit(reason);
        }
      };
      try {
        // Completion custody only: genuine native input and incoming HTTP publication return
        // before deliberately fencing the controller that authorized that input.
        await tab.tail;
        await join(binding);
        await joinTabCaptureOriginals(tab);
        if (!alive() || !sameBinding(binding, tab.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        flow = await acquire(binding);
        await flow.ready;
        if (!alive() || !sameBinding(binding, tab.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        cohort = claimNavigation(record, binding, current, preparation);
        if (!cohort) throw new BrowserLifecycleError('STALE_BINDING');
        const target = new URL(originalRequest.url());
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
          throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
        cohort.target = target.href;
        guard();
        if (
          (await flow.authorization.authorize(cohort.binding, target.href, controller.signal)) !==
          'allowed'
        )
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        const reset = await resetInput(record, binding, cohort);
        guard();
        if (reset.status !== 'ready' || !navigationResetObserved(cohort, reset.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        if (
          (await flow.authorization.authorize(reset.binding, target.href, controller.signal)) !==
          'allowed'
        )
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        if ((await authorizeOrdinary(cohort.binding, controller.signal)) !== 'allowed')
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        listening = true;
        on('request', observeRequest);
        on('framenavigated', observeCommit);
        on('close', observeClose);
        guard();
        cohort.phase = 'entered';
        // Fallback never skips pre-existing route owners or the independent protected broker.
        await fallback();
        await committed;
        guard();
        if (
          (await flow.authorization.authorize(tab.binding, page.url(), controller.signal)) !==
          'allowed'
        )
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        flow.complete(Object.freeze({ ...tab.binding }));
      } catch (reason) {
        failed = true;
        primary = reason;
        record.lifetime.requestRetirement('engineFault');
      } finally {
        // Every original closure enters independently; even undefined remains a primary failure.
        for (const close of [
          () => {
            controller.abort();
          },
          () => {
            if (listening) off('request', observeRequest);
          },
          () => {
            if (listening) off('framenavigated', observeCommit);
          },
          () => {
            if (listening) off('close', observeClose);
          },
          () => flow?.close(),
          () => {
            if (failed) return abort('aborted');
          },
        ]) {
          try {
            await close();
          } catch (reason) {
            if (cohort) cohort.cleanupUncertain = true;
            record.lifetime.uncertain = true;
            record.lifetime.requestRetirement('engineFault');
            if (!failed) {
              failed = true;
              primary = reason;
            }
          }
        }
        if (cohort) finishNavigation(cohort, !failed);
        finishOwnerPreparation(tab, preparation);
      }
      if (failed) throw primary;
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      return Object.freeze({ ...tab.binding });
    });
    void original.catch(() => {});
    try {
      observeTransition?.(binding, original);
    } catch (reason) {
      record.lifetime.uncertain = true;
      record.lifetime.requestRetirement('engineFault');
      throw reason;
    }
    try {
      await deadline(original, 5000, 'NAVIGATION_TIMEOUT');
    } catch (reason) {
      record.lifetime.uncertain = true;
      record.lifetime.requestRetirement('engineFault');
      throw reason;
    }
  };
  await ownOperation(record, () => Reflect.apply(route, page, ['**/*', handler]));
  let lastURL = page.url();
  registerOwnerSameDocument(tab, page, (observed) => {
    if (observed !== frame) return null;
    const url = observed.url(),
      previous = new URL(lastURL),
      next = new URL(url);
    // Same-origin is only a candidate; exact original native WithinDocument proof is mandatory.
    if (
      url === lastURL ||
      previous.origin !== next.origin ||
      !['http:', 'https:'].includes(next.protocol)
    )
      return null;
    const binding = Object.freeze({ ...tab.binding });
    const preparation = alive() && page.url() === url ? prepareOwnerNavigation(tab) : null;
    if (!preparation) return false;
    const original = ownOperation(record, async () => {
      let cohort: ReturnType<typeof claimNavigation> = null;
      let flow: Awaited<ReturnType<typeof acquire>> | undefined;
      const controller = new AbortController();
      let failed = false,
        primary: unknown;
      const guard = () => {
        const custody = alive(),
          canonical = cohort ? currentNavigation(cohort) : false;
        const authorized = flow?.authorization.isCurrent();
        if (!custody || !canonical || !authorized || !cohort || !navigationStateCurrent(cohort))
          throw new BrowserLifecycleError('STALE_BINDING');
      };
      try {
        await withinDocument.match(url, binding);
        await tab.tail;
        await join(binding);
        await joinTabCaptureOriginals(tab);
        if (!alive() || page.url() !== url || !sameBinding(binding, tab.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        flow = await acquire(binding);
        await flow.ready;
        if (!alive() || page.url() !== url || !sameBinding(binding, tab.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        cohort = claimNavigation(record, binding, current, preparation);
        if (!cohort) throw new BrowserLifecycleError('STALE_BINDING');
        cohort.target = url;
        guard();
        if ((await flow.authorization.authorize(binding, url, controller.signal)) !== 'allowed')
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        const reset = await resetInput(record, binding, cohort);
        guard();
        if (reset.status !== 'ready' || !navigationResetObserved(cohort, reset.binding))
          throw new BrowserLifecycleError('STALE_BINDING');
        if (
          (await flow.authorization.authorize(reset.binding, url, controller.signal)) !== 'allowed'
        )
          throw new BrowserLifecycleError('POLICY_REFUSED');
        guard();
        if ((await config.policy.authorizeAction(cohort.binding, controller.signal)) !== 'allowed')
          throw new BrowserLifecycleError('POLICY_REFUSED');
        const observedURL = page.url();
        guard();
        if (observedURL !== url) throw new BrowserLifecycleError('STALE_BINDING');
        cohort.phase = 'entered';
        if (!commitNavigation(tab, url) || !adoptObservedOwnerNavigation(cohort))
          throw new BrowserLifecycleError('STALE_BINDING');
        guard();
        tab.diagnostics.replaceEpoch();
        guard();
        flow.complete(Object.freeze({ ...tab.binding }));
      } catch (reason) {
        failed = true;
        primary = reason;
        record.lifetime.requestRetirement('engineFault');
      } finally {
        for (const close of [() => controller.abort(), () => flow?.close()]) {
          try {
            await close();
          } catch (reason) {
            if (cohort) cohort.cleanupUncertain = true;
            record.lifetime.uncertain = true;
            record.lifetime.requestRetirement('engineFault');
            if (!failed) {
              failed = true;
              primary = reason;
            }
          }
        }
        if (cohort) finishNavigation(cohort, !failed);
        finishOwnerPreparation(tab, preparation);
      }
      if (failed) throw primary;
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      return Object.freeze({ ...tab.binding });
    });
    void original.catch(() => {});
    try {
      observeTransition?.(binding, original);
    } catch (reason) {
      record.lifetime.uncertain = true;
      record.lifetime.requestRetirement('engineFault');
      throw reason;
    }
    void deadline(original, 5000, 'NAVIGATION_TIMEOUT').catch(() => {
      record.lifetime.uncertain = true;
      record.lifetime.requestRetirement('engineFault');
    });
    return true;
  });
  const remember = (observed: import('playwright-core').Frame) => {
    try {
      if (observed === frame) lastURL = observed.url();
    } catch {
      record.lifetime.requestRetirement('engineFault');
    }
  };
  const on = page.on;
  await ownOperation(record, () => Reflect.apply(on, page, ['framenavigated', remember]));
}
