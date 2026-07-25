import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
  InAppConfirmationProvider,
  type ConfirmationResult,
  type InAppConfirmationCallback,
} from '../confirmation-provider.js';
import { ApprovalService } from '../../core/approvals/index.js';
import type { PermissionPreview } from '../../marketplace/types.js';

/** Build an empty PermissionPreview useful for plumbing tests. */
function buildPreview(): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };
}

/** Build a default request payload used by every provider test. */
function buildRequest(
  overrides: Partial<{
    packageName: string;
    marketplace: string;
    operation: 'install' | 'uninstall' | 'create-package';
    purge: boolean;
    projectPath: string;
    packageType: string;
    preview: PermissionPreview;
  }> = {}
) {
  return {
    packageName: overrides.packageName ?? 'code-review-suite',
    marketplace: overrides.marketplace ?? 'dorkos-community',
    operation: overrides.operation ?? ('install' as const),
    ...(overrides.purge !== undefined && { purge: overrides.purge }),
    ...(overrides.projectPath !== undefined && { projectPath: overrides.projectPath }),
    ...(overrides.packageType !== undefined && { packageType: overrides.packageType }),
    preview: overrides.preview ?? buildPreview(),
  };
}

describe('AutoApproveConfirmationProvider', () => {
  it('always returns approved from requestInstallConfirmation', async () => {
    const provider = new AutoApproveConfirmationProvider();
    const result = await provider.requestInstallConfirmation(buildRequest());
    expect(result).toEqual({ status: 'approved' });
  });

  it('always returns approved from resolveToken regardless of token value', async () => {
    const provider = new AutoApproveConfirmationProvider();
    const result = await provider.resolveToken('any-token-string');
    expect(result).toEqual({ status: 'approved' });
  });

  it('returns approved for uninstall and create-package operations too', async () => {
    const provider = new AutoApproveConfirmationProvider();
    const uninstall = await provider.requestInstallConfirmation(
      buildRequest({ operation: 'uninstall' })
    );
    const createPkg = await provider.requestInstallConfirmation(
      buildRequest({ operation: 'create-package' })
    );
    expect(uninstall.status).toBe('approved');
    expect(createPkg.status).toBe('approved');
  });
});

describe('TokenConfirmationProvider', () => {
  let provider: TokenConfirmationProvider;
  let approvals: ApprovalService;

  beforeEach(() => {
    // A fresh in-memory approval store per test: the provider is a thin wrapper
    // over the shared primitive, which owns the token lifecycle.
    approvals = new ApprovalService(createTestDb());
    provider = new TokenConfirmationProvider(approvals);
  });

  /**
   * Decide every pending approval the way the cockpit does — by approval id
   * through the store. The provider deliberately exposes no decide-by-token
   * path, because the agent is the one holding the token.
   */
  function decidePending(decision: 'granted' | 'denied', reason?: string): void {
    for (const pending of approvals.listPending()) {
      if (decision === 'granted') approvals.grant(pending.approvalId);
      else approvals.deny(pending.approvalId, reason);
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('requestInstallConfirmation', () => {
    it('issues a pending result with a token', async () => {
      const result = await provider.requestInstallConfirmation(buildRequest());
      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        // 128 bits of CSPRNG randomness, hex — an opaque secret, not an id.
        expect(result.token).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it('issues a unique token for each request', async () => {
      const a = await provider.requestInstallConfirmation(buildRequest());
      const b = await provider.requestInstallConfirmation(buildRequest());
      expect(a.status).toBe('pending');
      expect(b.status).toBe('pending');
      if (a.status === 'pending' && b.status === 'pending') {
        expect(a.token).not.toBe(b.token);
      }
    });
  });

  describe('resolveToken', () => {
    it('returns declined for an unknown token', async () => {
      const result = await provider.resolveToken('not-a-real-token', buildRequest());
      expect(result).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns pending while the token has not been approved or declined', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      const resolved = await provider.resolveToken(issued.token, buildRequest());
      expect(resolved).toEqual({ status: 'pending', token: issued.token });
    });

    it('returns approved once the approval is granted, then consumes it (single-use)', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      decidePending('granted');

      const first = await provider.resolveToken(issued.token, buildRequest());
      expect(first).toEqual({ status: 'approved' });

      // Single-use: a second resolve must NOT return approved.
      const second = await provider.resolveToken(issued.token, buildRequest());
      expect(second).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns declined once the approval is denied, then consumes it (single-use)', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      decidePending('denied', 'user said no');

      const first = await provider.resolveToken(issued.token, buildRequest());
      expect(first).toEqual({ status: 'declined', reason: 'user said no' });

      // Single-use: a second resolve must NOT return declined-with-reason.
      const second = await provider.resolveToken(issued.token, buildRequest());
      expect(second).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns declined without a reason when the denial gave none', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      decidePending('denied');

      const result = await provider.resolveToken(issued.token, buildRequest());
      expect(result.status).toBe('declined');
      if (result.status === 'declined') {
        expect(result.reason).toBeUndefined();
      }
    });

    it('expires tokens after exactly 10 minutes and retires them on resolve', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-07T00:00:00.000Z'));

      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      // Just under the boundary (9m 59.999s) — still pending.
      vi.setSystemTime(new Date('2026-04-07T00:09:59.999Z'));
      const stillPending = await provider.resolveToken(issued.token, buildRequest());
      expect(stillPending.status).toBe('pending');

      // Exactly the TTL is NOT expired (`> expiresAt` is the rule).
      vi.setSystemTime(new Date('2026-04-07T00:10:00.000Z'));
      const atBoundary = await provider.resolveToken(issued.token, buildRequest());
      expect(atBoundary.status).toBe('pending');

      // Just past the boundary — expired.
      vi.setSystemTime(new Date('2026-04-07T00:10:00.001Z'));
      const expired = await provider.resolveToken(issued.token, buildRequest());
      expect(expired).toEqual({
        status: 'declined',
        reason: 'Token expired',
      });

      // Token is removed after expiry resolution.
      const followup = await provider.resolveToken(issued.token, buildRequest());
      expect(followup).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('refuses an approved token presented for a different package', async () => {
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ packageName: 'harmless-plugin' })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      // The confused-deputy case: consent was for one package, the retry names
      // another. The approval must not transfer.
      const redirected = await provider.resolveToken(
        issued.token,
        buildRequest({ packageName: 'something-else' })
      );
      expect(redirected).toEqual({
        status: 'declined',
        reason: 'This approval was granted for a different action',
      });

      // Refusing a mismatch must not spend the approval — the package the user
      // actually approved still installs.
      const asApproved = await provider.resolveToken(
        issued.token,
        buildRequest({ packageName: 'harmless-plugin' })
      );
      expect(asApproved).toEqual({ status: 'approved' });
    });

    it('refuses an uninstall approval escalated to a purging uninstall', async () => {
      // The data-loss case: the card said "keeping its saved data", so the token
      // must not license the variant that deletes .dork/data/ and secrets.json.
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ operation: 'uninstall', packageName: 'sentry-monitor', purge: false })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const escalated = await provider.resolveToken(
        issued.token,
        buildRequest({ operation: 'uninstall', packageName: 'sentry-monitor', purge: true })
      );
      expect(escalated).toEqual({
        status: 'declined',
        reason: 'This approval was granted for a different action',
      });

      // The approval the user actually gave is untouched and still spendable.
      const asApproved = await provider.resolveToken(
        issued.token,
        buildRequest({ operation: 'uninstall', packageName: 'sentry-monitor', purge: false })
      );
      expect(asApproved).toEqual({ status: 'approved' });
    });

    it('refuses an install approval retried without the marketplace it pinned', async () => {
      // A named marketplace pins resolution; omitting it searches every enabled
      // source, first match wins. Those are different effects, so the binding
      // must not treat an absent marketplace as the one the user approved.
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ marketplace: 'dorkos-community' })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const unpinned = await provider.resolveToken(issued.token, {
        packageName: 'code-review-suite',
        operation: 'install',
        preview: buildPreview(),
      });
      expect(unpinned).toEqual({
        status: 'declined',
        reason: 'This approval was granted for a different action',
      });

      // And the reverse: an approval granted with no marketplace pinned cannot be
      // spent against one particular source.
      const anySource = await provider.requestInstallConfirmation({
        packageName: 'code-review-suite',
        operation: 'install',
        preview: buildPreview(),
      });
      if (anySource.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const pinned = await provider.resolveToken(
        anySource.token,
        buildRequest({ marketplace: 'somewhere-else' })
      );
      expect(pinned.status).toBe('declined');
    });

    it('refuses an approval redirected at a different project', async () => {
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ projectPath: '/Users/dev/projects/alpha' })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const redirected = await provider.resolveToken(
        issued.token,
        buildRequest({ projectPath: '/Users/dev/projects/beta' })
      );
      expect(redirected.status).toBe('declined');
    });

    it('refuses a create-package approval retried for a different package type', async () => {
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ operation: 'create-package', packageType: 'agent' })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const swapped = await provider.resolveToken(
        issued.token,
        buildRequest({ operation: 'create-package', packageType: 'plugin' })
      );
      expect(swapped.status).toBe('declined');
    });

    it('refuses an approved token presented for a different operation', async () => {
      const issued = await provider.requestInstallConfirmation(
        buildRequest({ operation: 'install' })
      );
      if (issued.status !== 'pending') throw new Error('expected pending');
      decidePending('granted');

      const redirected = await provider.resolveToken(
        issued.token,
        buildRequest({ operation: 'uninstall' })
      );
      expect(redirected.status).toBe('declined');
    });
  });
});

describe('InAppConfirmationProvider', () => {
  it('delegates requestInstallConfirmation to the injected callback', async () => {
    const callback = vi.fn<InAppConfirmationCallback>().mockResolvedValue({
      status: 'approved',
    });
    const provider = new InAppConfirmationProvider(callback);

    const req = buildRequest();
    const result = await provider.requestInstallConfirmation(req);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(req);
    expect(result).toEqual({ status: 'approved' });
  });

  it('passes declined results through verbatim', async () => {
    const callback = vi.fn<InAppConfirmationCallback>().mockResolvedValue({
      status: 'declined',
      reason: 'user closed dialog',
    });
    const provider = new InAppConfirmationProvider(callback);

    const result: ConfirmationResult = await provider.requestInstallConfirmation(buildRequest());
    expect(result).toEqual({ status: 'declined', reason: 'user closed dialog' });
  });

  it('returns declined from resolveToken because the in-app provider issues no tokens', async () => {
    const callback = vi.fn<InAppConfirmationCallback>();
    const provider = new InAppConfirmationProvider(callback);

    const result = await provider.resolveToken('any-token');
    expect(result).toEqual({
      status: 'declined',
      reason: 'In-app provider does not issue tokens',
    });
    expect(callback).not.toHaveBeenCalled();
  });
});
