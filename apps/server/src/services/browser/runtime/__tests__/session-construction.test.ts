import { validateEngineConfiguration } from '@dorkos/browser';
import { joinBrowserBeforeShutdown } from '../shutdown-join.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createProductionBrowserSession } from '../production-session.js';
const original = vi.hoisted(() => ({
  grants: vi.fn(),
  input: vi.fn(),
  publications: vi.fn(),
  raster: vi.fn(),
  network: vi.fn(),
  mode: vi.fn(),
}));
vi.mock('../startup-mode.js', () => ({ captureProductionBrowserMode: original.mode }));
vi.mock('../../api/grants.js', () => ({
  OwnedBrowserGrants: class {
    closeExpiry = original.grants;
  },
}));
vi.mock('../../api/controller-input.js', () => ({
  BrowserControllerInput: class {
    close = original.input;
    joinPublications = original.publications;
  },
}));
vi.mock('../../stream/native-capture.js', () => ({
  BrowserViewCapture: class {
    close = original.raster;
  },
}));
vi.mock('../../egress/broker/live/production-composition.js', () => ({
  createProductionLiveBrowserComposition: original.network,
}));
// Constructor-source doubles only. This proves original handle/cleanup custody,
// never native birth, BetterAuth/grants, egress readiness or real pixels.
it.each([
  'constructor-false',
  'constructor-invalid-configuration',
  'reentrant-close',
  'close-getter-undefined',
] as const)(
  'retains the handle before all acquisitions and joins late constructor duties (%s)',
  async (scenario) => {
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    original.grants.mockReset().mockResolvedValue(undefined);
    original.input.mockReset().mockResolvedValue(undefined);
    original.publications.mockReset().mockResolvedValue(undefined);
    original.raster.mockReset().mockReturnValue(held);
    original.mode.mockReset().mockReturnValue({
      ownerId: 'source-double-owner',
      current: () => true,
      configuration: { network: { policyRevision: 1 } },
    });
    original.network.mockReset();
    const resources: {
      owner?: ReturnType<typeof createProductionBrowserSession>;
      opening?: Promise<unknown>;
      closing?: Promise<void>;
      accepted?: { reason: unknown };
    } = {};
    let cleanup: Promise<void> | undefined;
    const networkClose = vi.fn(() => held),
      authorize = vi.fn();
    const finish = () => {
      if (cleanup) return cleanup;
      release();
      cleanup = (async () => {
        const results = await Promise.allSettled([
          ...(resources.opening ? [resources.opening] : []),
          ...(resources.closing ? [resources.closing] : []),
          ...(resources.owner ? [resources.owner.close()] : []),
        ]);
        for (const result of results)
          if (
            result.status === 'rejected' &&
            (!resources.accepted || !Object.is(resources.accepted.reason, result.reason))
          )
            throw result.reason;
      })();
      return cleanup;
    };
    onTestFinished(finish);
    original.network.mockImplementation(() => {
      if (scenario === 'constructor-false') throw false;
      if (scenario === 'constructor-invalid-configuration') validateEngineConfiguration({});
      if (scenario === 'close-getter-undefined')
        return {
          get close() {
            void resources.owner!.close().catch(() => {});
            throw undefined;
          },
          authorizeWorkspace: authorize,
        };
      void resources.owner!.close().catch(() => {});
      return { close: networkClose, authorizeWorkspace: authorize };
    });
    const owner = (resources.owner = createProductionBrowserSession({
      admission: { kind: 'production-browser-mode' },
    } as Parameters<typeof createProductionBrowserSession>[0]));
    expect(original.network).not.toHaveBeenCalled();
    expect(original.grants).not.toHaveBeenCalled();
    const opening = (resources.opening = owner.open(
      {},
      'source-double-workspace',
      { requestId: 'source_double_request_00000001', mode: 'ephemeral' },
      new AbortController().signal
    ));
    const outcome = opening.then(
      () => ({ ok: true as const }),
      (reason: unknown) => ({ ok: false as const, reason })
    );
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('constructor must refuse');
    resources.accepted = { reason: result.reason };
    if (scenario === 'constructor-false') expect(result.reason).toBe(false);
    if (scenario === 'close-getter-undefined') expect(result.reason).toBeUndefined();
    const remaining = vi.fn(async () => {
      if (scenario === 'constructor-invalid-configuration') throw undefined;
    });
    const closing = (resources.closing = Promise.resolve().then(() =>
      joinBrowserBeforeShutdown(() => owner.close(), remaining)
    ));
    let joined = false;
    void closing.then(
      () => {
        joined = true;
      },
      () => {
        joined = true;
      }
    );
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(remaining).not.toHaveBeenCalled();
    expect(original.grants).toHaveBeenCalledTimes(1);
    expect(original.input).toHaveBeenCalledTimes(1);
    expect(original.raster).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
    expect(original.publications).not.toHaveBeenCalled();
    release();
    const retired = await closing.then(
      () => ({ ok: true as const }),
      (reason: unknown) => ({ ok: false as const, reason })
    );
    expect(retired.ok).toBe(false);
    expect(remaining).toHaveBeenCalledOnce();
    if (!retired.ok) expect(Object.is(retired.reason, result.reason)).toBe(true);
    if (scenario === 'reentrant-close') expect(networkClose).toHaveBeenCalledTimes(1);
    await finish();
  }
);
