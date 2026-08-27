/**
 * What the marketplace capabilities read off an invocation context — the seam
 * between the tier gate and the marketplace's own, older confirmation step
 * (spec `agent-approval-settings` §3.3, §3.4).
 *
 * `callerContext` in `marketplace-capabilities.ts` turns that context into
 * `preApproved`, which is what stops a handler asking a second time for something
 * a person just allowed. It tests TWO different proofs of the same fact —
 * `context.approval` and `context.trusted` — and the whole value of this file is
 * that both are pinned, so a change to one arm cannot silently break the other.
 *
 * ## Why the trusted arm has its own test, and why it was written first
 *
 * `GrantedApproval` became a discriminated union so a standing permission can be
 * told from a spent approval. Editing the `context.approval` arm to read a union is
 * exactly the kind of edit that disturbs the `context.trusted` arm sitting next to
 * it in the same expression. Saying "be careful" would have been an invariant that
 * holds because nobody has broken it yet, which is the pattern this feature exists
 * to remove.
 *
 * So this file landed BEFORE the union, green against the code as it stood, and was
 * checked capable of going red by breaking the arm on purpose. A test written after
 * the change it protects has never been red and proves nothing.
 *
 * ## The trusted arm may be unreachable in production, and it is kept anyway
 *
 * A trusted-caller marker is minted at only a few routes, and the marketplace ones
 * call the install and uninstall flows directly rather than through
 * `registry.invoke`, which is what populates a handler context. So nothing in the
 * tree is known to reach a marketplace handler WITH a marker today. That is a
 * reason to pin the arm, not to delete it: the trusted path is how the cockpit
 * avoids asking a person twice, and an unreachable arm is the kind that rots
 * silently.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

import { marketplaceDomain } from '../marketplace-capabilities.js';
import { trustedCaller } from '../../core/capabilities/trusted-caller.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import type {
  ConfirmationProvider,
  ConfirmationRequest,
  ConfirmationResult,
} from '../confirmation-provider.js';
import type { UninstallRequest, UninstallResult } from '../../marketplace/flows/uninstall.js';

/** The one `destructive` marketplace capability, and the one this file drives. */
const uninstall = marketplaceDomain.capabilities.find((c) => c.id === 'marketplace.uninstall')!;

/** What every test here asks for. */
const INPUT = { name: 'sentry-monitor' };

/**
 * A registry dependency bag holding only what the uninstall handler reads, plus
 * spies on the two things this file asserts about: whether the confirmation step
 * was asked, and whether the uninstall actually ran.
 *
 * @returns The bag and the two spies.
 */
function buildDeps(): {
  deps: CapabilityDeps;
  askedForConfirmation: ReturnType<typeof vi.fn>;
  ranUninstall: ReturnType<typeof vi.fn>;
} {
  const askedForConfirmation = vi.fn(
    async (_req: ConfirmationRequest): Promise<ConfirmationResult> => ({
      status: 'pending',
      token: 'confirmation-token',
    })
  );
  const ranUninstall = vi.fn(async (req: UninstallRequest): Promise<UninstallResult> => ({
    ok: true,
    packageName: req.name,
    removedFiles: 1,
    preservedData: [],
  }));

  const confirmationProvider: ConfirmationProvider = {
    requestInstallConfirmation: askedForConfirmation,
    resolveToken: async () => ({ status: 'declined', reason: 'not used in these tests' }),
  };

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const marketplaceDeps = {
    dorkHome: '/tmp/.dork-test',
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: { uninstall: ranUninstall } as unknown as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider,
    logger,
  } satisfies MarketplaceMcpDeps;

  const deps: CapabilityDeps = { logger, marketplaceDeps };

  return { deps, askedForConfirmation, ranUninstall };
}

/**
 * Invoke `marketplace.uninstall` with one handler context.
 *
 * @param context - The context the registry would have handed the handler.
 * @returns Whether the confirmation step was asked, and whether the uninstall ran.
 */
async function invokeWith(
  context: CapabilityHandlerContext
): Promise<{ asked: boolean; ran: boolean }> {
  const { deps, askedForConfirmation, ranUninstall } = buildDeps();
  await uninstall.invoke(deps, uninstall.input.parse(INPUT), context);
  return {
    asked: askedForConfirmation.mock.calls.length > 0,
    ran: ranUninstall.mock.calls.length > 0,
  };
}

describe('callerContext turns a proof of consent into preApproved', () => {
  it('asks the confirmation step when the context carries no proof at all', async () => {
    // The control. Without this, every assertion below could pass against a
    // handler that simply never asks anybody anything.
    expect(await invokeWith({})).toEqual({ asked: true, ran: false });
  });

  it('does not ask again when the tier gate spent an approval', async () => {
    const result = await invokeWith({ approval: { via: 'approval', approvalId: 'appr_01' } });

    expect(result).toEqual({ asked: false, ran: true });
  });

  it('does not ask again when a standing permission allowed the call', async () => {
    // Spec §3.4: the gate resolves a permission and puts it on the context, where
    // the same arm converts it. One lookup, two enforcement points — which is what
    // stops "stop asking" meaning "stop asking at one of the two places that ask".
    const result = await invokeWith({ approval: { via: 'standing-grant', grantId: 'grant_01' } });

    expect(result).toEqual({ asked: false, ran: true });
  });

  it('does not ask again when the caller proved it may DECIDE approvals', async () => {
    // The arm this file exists for. A trusted caller has already cleared a bar at
    // least as high as the confirmation this flow would go and fetch, so asking it
    // to answer its own question would be the second card that spec `agent-trust`
    // §3.2 set out to remove.
    const marker = trustedCaller({
      agentIdentityPresented: false,
      approvalTokenPresented: false,
      loginEnabled: () => false,
    });
    expect(marker, 'a caller presenting neither header may decide under local-trust').toBeDefined();

    const result = await invokeWith({ trusted: marker! });

    expect(result).toEqual({ asked: false, ran: true });
  });
});
