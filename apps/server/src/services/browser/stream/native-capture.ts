import type {
  PrivateBrowserCaptureOwner,
  PrivateBrowserCaptureDispatcher,
  OwnedCaptureAuthorization,
} from '@dorkos/browser/server-owner';
import { BrowserCaptureRequestSchema } from '@dorkos/shared/browser-schemas';
import { ViewerRefusal } from './subscriptions.js';
import {
  originalCaptureCancellation,
  isOriginalCaptureCancellation,
} from './capture-cancellation.js';

/** Private original engine dispatcher bank; no direct engine.capture fallback or authority DTO. */
export class BrowserViewCapture {
  readonly owner: PrivateBrowserCaptureOwner;
  private dispatch?: PrivateBrowserCaptureDispatcher['capture'];
  private closed = false;
  private closing?: Promise<void>;
  private readonly work = new Set<Promise<unknown>>();
  private readonly authorizationWork = new Set<Promise<unknown>>();
  private failed = false;
  private first: unknown;
  constructor() {
    this.owner = Object.freeze({
      registerDispatcher: (original: PrivateBrowserCaptureDispatcher) => {
        if (this.closed || this.dispatch) throw new ViewerRefusal('authority');
        const capture = original.capture.bind(original);
        if (this.closed || this.dispatch) throw new ViewerRefusal('authority');
        this.dispatch = capture;
      },
    });
  }
  capture(
    value: unknown,
    authorization: OwnedCaptureAuthorization
  ): ReturnType<PrivateBrowserCaptureDispatcher['capture']> {
    if (!this.dispatch || this.closed) return Promise.reject(new ViewerRefusal('authority'));
    if (this.work.size >= 16) return Promise.reject(new ViewerRefusal('capacity'));
    const request = BrowserCaptureRequestSchema.parse(value);
    const command = Object.freeze({
      kind: 'capture',
      ...request,
      binding: Object.freeze({ ...request.binding }),
    });
    const dispatch = this.dispatch;
    const current = authorization.isCurrent.bind(authorization),
      authorize = authorization.authorize.bind(authorization);
    const original: OwnedCaptureAuthorization = Object.freeze({
      isCurrent: () => {
        const admitted = current();
        return admitted && !this.closed;
      },
      authorize: async (...args: Parameters<OwnedCaptureAuthorization['authorize']>) => {
        if (this.closed || this.authorizationWork.size >= 16) return 'refused';
        const entered = Promise.resolve().then(() => {
          if (this.closed) return 'refused' as const;
          return authorize(...args);
        });
        this.authorizationWork.add(entered);
        void entered.then(
          () => this.authorizationWork.delete(entered),
          (error: unknown) => {
            this.authorizationWork.delete(entered);
            if (!this.failed) {
              this.failed = true;
              this.first = error;
            }
          }
        );
        // The engine policy timeout may stop waiting; retain the original actor refresh separately.
        const result = await entered;
        return this.closed ? 'refused' : result;
      },
    });
    if (this.closed || this.dispatch !== dispatch)
      return Promise.reject(new ViewerRefusal('authority'));
    if (this.work.size >= 16) return Promise.reject(new ViewerRefusal('capacity'));
    // Charge before any fallible currentness or engine producer. Close retains this exact promise.
    const operation = Promise.resolve().then(() => {
      const admitted = original.isCurrent();
      if (!admitted || this.closed) {
        const error = new ViewerRefusal('authority');
        if (admitted === false || this.closed) originalCaptureCancellation(error);
        throw error;
      }
      return dispatch(command, original);
    });
    this.work.add(operation);
    void operation.then(
      () => this.work.delete(operation),
      (error: unknown) => {
        this.work.delete(operation);
        if (!isOriginalCaptureCancellation(error) && !this.failed) {
          this.failed = true;
          this.first = error;
        }
      }
    );
    return operation;
  }
  /** Original retained authorization custody only; this count conveys no permission or readiness. */
  pendingAuthorizations(): number {
    return this.authorizationWork.size;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const work = [...this.work];
    this.closing = Promise.allSettled([...work, ...this.authorizationWork]).then((results) => {
      for (const [index, result] of results.entries())
        if (
          result.status === 'rejected' &&
          !this.failed &&
          (index >= work.length || !isOriginalCaptureCancellation(result.reason))
        ) {
          this.failed = true;
          this.first = result.reason;
        }
      if (this.failed) throw this.first;
    });
    return this.closing;
  }
}
