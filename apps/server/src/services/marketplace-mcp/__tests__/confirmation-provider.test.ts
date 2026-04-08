import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
  InAppConfirmationProvider,
  type ConfirmationResult,
  type InAppConfirmationCallback,
} from '../confirmation-provider.js';
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
    preview: PermissionPreview;
  }> = {}
) {
  return {
    packageName: overrides.packageName ?? 'code-review-suite',
    marketplace: overrides.marketplace ?? 'dorkos-community',
    operation: overrides.operation ?? ('install' as const),
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

  beforeEach(() => {
    provider = new TokenConfirmationProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('requestInstallConfirmation', () => {
    it('issues a pending result with a token', async () => {
      const result = await provider.requestInstallConfirmation(buildRequest());
      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.token).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
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
      const result = await provider.resolveToken('not-a-real-token');
      expect(result).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns pending while the token has not been approved or declined', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      const resolved = await provider.resolveToken(issued.token);
      expect(resolved).toEqual({ status: 'pending', token: issued.token });
    });

    it('returns approved after approve() is called and consumes the token (single-use)', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      provider.approve(issued.token);

      const first = await provider.resolveToken(issued.token);
      expect(first).toEqual({ status: 'approved' });

      // Single-use: a second resolve must NOT return approved.
      const second = await provider.resolveToken(issued.token);
      expect(second).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns declined after decline() is called and consumes the token (single-use)', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      provider.decline(issued.token, 'user said no');

      const first = await provider.resolveToken(issued.token);
      expect(first).toEqual({ status: 'declined', reason: 'user said no' });

      // Single-use: a second resolve must NOT return declined-with-reason.
      const second = await provider.resolveToken(issued.token);
      expect(second).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('returns declined for a token decline()d without a reason', async () => {
      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      provider.decline(issued.token);

      const result = await provider.resolveToken(issued.token);
      expect(result.status).toBe('declined');
      if (result.status === 'declined') {
        expect(result.reason).toBeUndefined();
      }
    });

    it('expires tokens after exactly 5 minutes and removes them on resolve', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-07T00:00:00.000Z'));

      const issued = await provider.requestInstallConfirmation(buildRequest());
      if (issued.status !== 'pending') throw new Error('expected pending');

      // Just under the boundary (4m 59.999s) — still pending.
      vi.setSystemTime(new Date('2026-04-07T00:04:59.999Z'));
      const stillPending = await provider.resolveToken(issued.token);
      expect(stillPending.status).toBe('pending');

      // Exactly 5 minutes is NOT expired (`> ttlMs` is the spec).
      vi.setSystemTime(new Date('2026-04-07T00:05:00.000Z'));
      const atBoundary = await provider.resolveToken(issued.token);
      expect(atBoundary.status).toBe('pending');

      // Just past the boundary — expired.
      vi.setSystemTime(new Date('2026-04-07T00:05:00.001Z'));
      const expired = await provider.resolveToken(issued.token);
      expect(expired).toEqual({
        status: 'declined',
        reason: 'Token expired',
      });

      // Token is removed after expiry resolution.
      const followup = await provider.resolveToken(issued.token);
      expect(followup).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('treats approve() on an unknown token as a no-op', async () => {
      provider.approve('ghost-token');
      const result = await provider.resolveToken('ghost-token');
      expect(result).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
    });

    it('treats decline() on an unknown token as a no-op', async () => {
      provider.decline('ghost-token', 'never existed');
      const result = await provider.resolveToken('ghost-token');
      expect(result).toEqual({
        status: 'declined',
        reason: 'Unknown or expired token',
      });
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
