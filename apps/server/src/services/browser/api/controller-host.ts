import type { Request, Response } from 'express';
import { readCallerAuthority } from '../../../lib/caller-authority.js';
import { resolveDecisionAuthority } from '../../core/approvals/decision-authority.js';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import type {
  OwnedInputAuthorization,
  OwnedNavigationAuthorization,
} from '@dorkos/browser/server-owner';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import { OwnedBrowserController, type BrowserControllerNavigationFlow } from './controller.js';
import type { OwnedBrowserGrants } from './grants.js';
import { BrowserApiRefusal } from './service.js';
import { BrowserControllerIdentities } from './controller-auth.js';

/** Private session-qualified controller composition with original owner or explicit grant authority. */
export class BrowserControllerHost {
  private readonly takeover: OwnedBrowserController['takeover'];
  private readonly captureNavigation: OwnedBrowserController['captureNavigation'];
  private readonly captureOwnerNavigation: OwnedBrowserController['captureOwnerNavigation'];
  private readonly ownerContinuations = new Map<
    string,
    Readonly<{
      browserId: string;
      browserGeneration: number;
      acquire(
        binding: BrowserBinding
      ):
        | ReturnType<OwnedBrowserController['captureOwnerNavigation']>
        | Promise<ReturnType<OwnedBrowserController['captureOwnerNavigation']>>;
    }>
  >();
  private navigationClosed = false;
  private readonly closeOriginalNavigation: OwnedBrowserController['closeNavigation'];
  private readonly authorization: OwnedBrowserController['authorization'];
  private readonly issueGrant?: OwnedBrowserGrants['controllerGrant'];
  private readonly captureIdentity: BrowserControllerIdentities['capture'];
  constructor(
    controller: OwnedBrowserController,
    identities: BrowserControllerIdentities,
    grants?: Pick<OwnedBrowserGrants, 'controllerGrant'>,
    identityLoss?: Pick<OwnedBrowserController, 'revokeController'>
  ) {
    this.captureNavigation = controller.captureNavigation.bind(controller);
    this.captureOwnerNavigation = controller.captureOwnerNavigation.bind(controller);
    this.closeOriginalNavigation = controller.closeNavigation.bind(controller);
    this.takeover = controller.takeover.bind(controller);
    this.authorization = controller.authorization.bind(controller);
    const bind = identities.bindController.bind(identities);
    bind(identityLoss ?? controller);
    this.captureIdentity = identities.capture.bind(identities);
    this.issueGrant = grants?.controllerGrant.bind(grants);
  }

  /** Join retained original failed-admission cleanup; never converts failure into readiness. */
  closeNavigation(): Promise<void> {
    this.navigationClosed = true;
    this.ownerContinuations.clear();
    return this.closeOriginalNavigation();
  }

  /** Only the original engine retirement observer invokes this private lifetime fence.
   * Removing a credential factory conveys no physical cleanup or new admission permission.
   */
  retireOwnerContinuations(browserId: string, browserGeneration: number): void {
    for (const [id, original] of this.ownerContinuations)
      if (original.browserId === browserId && original.browserGeneration === browserGeneration)
        this.ownerContinuations.delete(id);
  }

  /** The native constructor supplies the exact observed binding; no wire controller ticket is used. */
  async ownerContinuation(value: BrowserBinding): Promise<BrowserControllerNavigationFlow> {
    const binding = Object.freeze(BrowserBindingSchema.parse(value));
    const id = JSON.stringify([binding.browserId, binding.browserGeneration, binding.tabId]);
    const original = this.ownerContinuations.get(id);
    if (this.navigationClosed || !original) throw new BrowserApiRefusal('inaccessible');
    const flow = await original.acquire(binding);
    if (this.navigationClosed || this.ownerContinuations.get(id) !== original) {
      await flow.close();
      throw new BrowserApiRefusal('inaccessible');
    }
    return flow;
  }

  capture(req: Request, res: Response, localTicket?: string) {
    const auth = this.captureIdentity(req, res, localTicket);
    const ownerPosture = () => {
      const authority = resolveDecisionAuthority(readCallerAuthority(req, res));
      return (
        localTicket === undefined && authority.allowed && authority.posture === 'signed-in-operator'
      );
    };
    const issueGrant = (
      binding: BrowserBinding,
      reference?: { grantId: string; revision: number }
    ) => {
      if (!reference) return undefined;
      if (!this.issueGrant) throw new BrowserApiRefusal('inaccessible');
      return this.issueGrant(auth.current, reference.grantId, reference.revision, binding);
    };
    return Object.freeze({
      navigation: async (
        binding: BrowserBinding,
        controllerId: string,
        reference?: { grantId: string; revision: number }
      ) => {
        await auth.refresh();
        const grant = issueGrant(binding, reference);
        const flow = this.captureNavigation(auth.current, binding, controllerId, grant);
        const current = flow.authorization.isCurrent.bind(flow.authorization);
        const authorize = flow.authorization.authorize.bind(flow.authorization);
        const close = flow.close.bind(flow);
        const authorization: OwnedNavigationAuthorization = Object.freeze({
          isCurrent: current,
          authorize: async (...args: Parameters<OwnedNavigationAuthorization['authorize']>) => {
            try {
              await auth.refresh();
            } catch {
              return 'refused' as const;
            }
            return authorize(...args);
          },
        });
        return Object.freeze({
          authorization,
          ready: flow.ready,
          complete: flow.complete.bind(flow),
          close,
        });
      },
      takeover: async (
        binding: BrowserBinding,
        reference?: { grantId: string; revision: number }
      ) => {
        await auth.refresh();
        const grant = issueGrant(binding, reference);
        const state = await this.takeover(auth.current, binding, grant);
        // A reset is not session proof. Do not deliver its ticket after server-store revocation.
        await auth.refresh();
        this.authorization(auth.current, state.binding, state.controllerId!, grant);
        if (!reference && ownerPosture()) {
          const id = JSON.stringify([
            state.binding.browserId,
            state.binding.browserGeneration,
            state.binding.tabId,
          ]);
          if (
            this.navigationClosed ||
            (!this.ownerContinuations.has(id) && this.ownerContinuations.size >= 128)
          )
            throw new BrowserApiRefusal('inaccessible');
          const original: Readonly<{
            browserId: string;
            browserGeneration: number;
            acquire(binding: BrowserBinding): Promise<BrowserControllerNavigationFlow>;
          }> = Object.freeze({
            browserId: state.binding.browserId,
            browserGeneration: state.binding.browserGeneration,
            acquire: async (binding: BrowserBinding) => {
              if (
                this.navigationClosed ||
                !ownerPosture() ||
                this.ownerContinuations.get(id) !== original
              )
                throw new BrowserApiRefusal('inaccessible');
              await auth.refresh();
              if (
                this.navigationClosed ||
                !ownerPosture() ||
                this.ownerContinuations.get(id) !== original
              )
                throw new BrowserApiRefusal('inaccessible');
              const flow = this.captureOwnerNavigation(auth.current, binding);
              const current = flow.authorization.isCurrent.bind(flow.authorization),
                authorize = flow.authorization.authorize.bind(flow.authorization);
              return Object.freeze({
                ready: flow.ready,
                complete: flow.complete.bind(flow),
                close: flow.close.bind(flow),
                authorization: Object.freeze({
                  isCurrent: () => {
                    const posture = ownerPosture(),
                      admitted = current();
                    return (
                      posture &&
                      admitted &&
                      !this.navigationClosed &&
                      this.ownerContinuations.get(id) === original
                    );
                  },
                  authorize: async (
                    ...args: Parameters<OwnedNavigationAuthorization['authorize']>
                  ) => {
                    try {
                      await auth.refresh();
                    } catch {
                      return 'refused' as const;
                    }
                    const posture = ownerPosture(),
                      result = await authorize(...args);
                    return posture &&
                      result === 'allowed' &&
                      !this.navigationClosed &&
                      this.ownerContinuations.get(id) === original
                      ? ('allowed' as const)
                      : ('refused' as const);
                  },
                }),
              });
            },
          });
          this.ownerContinuations.set(id, original);
        }
        return state;
      },
      authorization: async (
        binding: BrowserBinding,
        controllerId: string,
        reference?: { grantId: string; revision: number }
      ): Promise<OwnedInputAuthorization> => {
        await auth.refresh();
        const grant = issueGrant(binding, reference);
        const original = this.authorization(auth.current, binding, controllerId, grant);
        return Object.freeze({
          isCurrent: original.isCurrent,
          authorize: async (...args: Parameters<OwnedInputAuthorization['authorize']>) => {
            try {
              await auth.refresh();
            } catch {
              return 'refused' as const;
            }
            return original.authorize(...args);
          },
        });
      },
    });
  }
}
