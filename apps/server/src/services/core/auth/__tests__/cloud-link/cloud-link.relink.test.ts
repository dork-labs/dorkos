import { describe, it, expect, vi } from 'vitest';
import { configManager } from '../../../config-manager.js';
import { CloudLinkManager } from '../../cloud-link.js';
import { DEVICE_TOKEN_REQUEST_TIMEOUT_MS, linkProofForKey } from '../../cloud-link-client.js';
import { logger } from '../../../../../lib/logger.js';
import {
  noSleep,
  routerFetch,
  CODES,
  useCloudLinkSandbox,
  setCloud,
  type Step,
} from './cloud-link.fixtures.js';

describe('CloudLinkManager', () => {
  let manager: CloudLinkManager;
  useCloudLinkSandbox('dorkos-cloud-link-', () => manager?.stop());

  describe('a relink that does not finish while this computer is still linked', () => {
    const HELD = {
      instanceToken: 'dork_inst_held',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
      previousLinkProof: null,
    };

    it.each([
      ['denied', { status: 400, body: { error: 'access_denied' } }],
      ['expired', { status: 400, body: { error: 'expired_token' } }],
      ['failed', { status: 500, body: {} }],
    ] as const)('goes straight back to linked when the relink ends %s', async (outcome, step) => {
      setCloud(HELD);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ code: () => CODES, token: () => step }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      expect(manager.getStatus().state).toBe('pending');
      await manager.pendingLink;
      expect(manager.getStatus()).toMatchObject({ state: 'linked', relinkOutcome: outcome });
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
    });

    it('still ends denied or expired on a computer with no link to keep', async () => {
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error: 'access_denied' } }),
        }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().state).toBe('denied');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('cancels a pending relink back to linked, and clears the note', async () => {
      setCloud(HELD);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error: 'expired_token' } }),
        }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().relinkOutcome).toBe('expired');
      await manager.cancelLink();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    /**
     * A cloud whose first token answer arrives only when the test says so.
     * At token exchange the cloud issues the new key and retires the old one,
     * so an answer that was already on its way must never be thrown away.
     * Later token polls answer `expired_token`.
     */
    function exchangeOnCue(answer: 'approved' | 'denied') {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let tokenCalls = 0;
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        void init;
        const p = new URL(url).pathname;
        if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
        if (p.endsWith('/device/token')) {
          tokenCalls += 1;
          if (tokenCalls > 1) {
            return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
          }
          await released;
          return answer === 'approved'
            ? new Response(JSON.stringify({ access_token: 'dork_inst_new' }))
            : new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 });
        }
        if (p.endsWith('/instances/heartbeat')) {
          return new Response(
            JSON.stringify({ ok: true, instanceId: 'i', lastSeenAt: '2026-09-30T00:00:00Z' })
          );
        }
        if (p.endsWith('/instances/revoke')) return new Response(JSON.stringify({ ok: true }));
        throw new Error(`unexpected request: ${p}`);
      });
      const exchanging = () => vi.waitFor(() => expect(tokenCalls).toBeGreaterThanOrEqual(1));
      return { fetchImpl, release, exchanging };
    }

    function managerWith(fetchImpl: ReturnType<typeof vi.fn>, sleep = noSleep) {
      return new CloudLinkManager({
        fetchImpl: fetchImpl as never,
        sleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
    }

    it.each([
      ['held', 'approved', 'dork_inst_new', 'linked'],
      ['held', 'denied', 'dork_inst_held', 'linked'],
      ['none', 'approved', 'dork_inst_new', 'linked'],
      ['none', 'denied', null, 'idle'],
    ] as const)(
      'a cancel with a key %s while an exchange is in flight keeps an %s answer honest',
      async (key, answer, token, state) => {
        if (key === 'held') setCloud(HELD);
        const cloud = exchangeOnCue(answer);
        manager = managerWith(cloud.fetchImpl);
        await manager.startLink();
        await cloud.exchanging();
        let cancelled = false;
        const cancelling = manager.cancelLink().then((status) => {
          cancelled = true;
          return status;
        });
        await Promise.resolve();
        // The cancel waits for the answer already on its way.
        expect(cancelled).toBe(false);
        cloud.release();
        const status = await cancelling;
        expect(configManager.getDot('cloud.instanceToken')).toBe(token);
        expect(status.state).toBe(state);
        expect(status.relinkOutcome).toBeUndefined();
        expect(manager.getStatus()).toEqual(status);
      }
    );

    it('cancels at once between polls, without sending a token request', async () => {
      setCloud(HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl, () => new Promise<void>(() => {}));
      await manager.startLink();
      const status = await manager.cancelLink();
      expect(status.state).toBe('linked');
      expect(cloud.fetchImpl.mock.calls.some((c) => String(c[0]).endsWith('/device/token'))).toBe(
        false
      );
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
    });

    it('keeps a key issued while Link again restarts the flow, and proves the new key next', async () => {
      setCloud(HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl);
      await manager.startLink();
      await cloud.exchanging();
      const restarting = manager.startLink();
      cloud.release();
      await restarting;
      await manager.pendingLink;
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_new');
      const codeCalls = cloud.fetchImpl.mock.calls.filter((c) =>
        String(c[0]).endsWith('/device/code')
      );
      expect(codeCalls).toHaveLength(2);
      const secondScope = JSON.parse(
        JSON.parse((codeCalls[1]![1] as RequestInit).body as string).scope
      ) as Record<string, unknown>;
      expect(secondScope.previousLinkProof).toBe(linkProofForKey('dork_inst_new'));
    });

    it('withdraws locally at once on unlink, then clears and revokes a key issued meanwhile', async () => {
      setCloud(HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl);
      await manager.startLink();
      await cloud.exchanging();
      const unlinking = manager.unlink();
      // Withdrawn before any await: the held key is gone and nothing waits on the exchange.
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(manager.getStatus().state).toBe('idle');
      cloud.release();
      await unlinking;
      await manager.pendingLink;
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(manager.getStatus().state).toBe('idle');
      const revoked = cloud.fetchImpl.mock.calls
        .filter((c) => String(c[0]).endsWith('/instances/revoke'))
        .map((c) => ((c[1] as RequestInit).headers as Record<string, string>).authorization);
      expect(revoked).toEqual(['Bearer dork_inst_held', 'Bearer dork_inst_new']);
    });

    it.each(['cancelLink', 'startLink'] as const)(
      'lets %s finish within the token request bound when the request hangs',
      async (action) => {
        vi.useFakeTimers();
        try {
          setCloud(HELD);
          let tokenRequests = 0;
          const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            const p = new URL(url).pathname;
            if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
            if (p.endsWith('/device/token')) {
              tokenRequests += 1;
              if (tokenRequests > 1) {
                return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
              }
              // Hangs until its own signal gives up on it.
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            }
            throw new Error(`unexpected request: ${p}`);
          });
          manager = managerWith(fetchImpl);
          await manager.startLink();
          for (let i = 0; i < 20 && tokenRequests === 0; i++) await vi.advanceTimersByTimeAsync(0);
          expect(tokenRequests).toBe(1);
          let settled = false;
          const acting = (
            action === 'cancelLink' ? manager.cancelLink() : manager.startLink()
          ).then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(DEVICE_TOKEN_REQUEST_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await acting;
          expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it.each([200, 400])(
      'bounds the token request body too, when a %i arrives and its body stalls',
      async (status) => {
        vi.useFakeTimers();
        try {
          setCloud(HELD);
          let tokenRequests = 0;
          const fetchImpl = vi.fn(async (url: string) => {
            const p = new URL(url).pathname;
            if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
            if (p.endsWith('/device/token')) {
              tokenRequests += 1;
              if (tokenRequests > 1) {
                return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
              }
              // Headers now, then a body that never ends and ignores every signal.
              return new Response(new ReadableStream({ start() {} }), { status });
            }
            throw new Error(`unexpected request: ${p}`);
          });
          manager = managerWith(fetchImpl);
          await manager.startLink();
          for (let i = 0; i < 20 && tokenRequests === 0; i++) await vi.advanceTimersByTimeAsync(0);
          expect(tokenRequests).toBe(1);
          let settled = false;
          const cancelling = manager.cancelLink().then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(DEVICE_TOKEN_REQUEST_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await cancelling;
          expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it('keeps a key issued after stop, but starts nothing for it', async () => {
      vi.useFakeTimers();
      try {
        const cloud = exchangeOnCue('approved');
        manager = new CloudLinkManager({
          fetchImpl: cloud.fetchImpl as never,
          sleep: noSleep,
          heartbeatIntervalMs: 1_000,
          resolveTelemetryInstanceId: async () => undefined,
        });
        const sync = vi.fn(async () => {});
        manager.setManagedProviderSync(sync);
        await manager.startLink();
        await vi.advanceTimersByTimeAsync(0);
        expect(cloud.fetchImpl.mock.calls.some((c) => String(c[0]).endsWith('/device/token'))).toBe(
          true
        );
        const poll = manager.pendingLink;
        manager.stop();
        cloud.release();
        await poll;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_new');
        expect(sync).not.toHaveBeenCalled();
        expect(
          cloud.fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/instances/heartbeat'))
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the note a relink left is cleared whenever the link changes', () => {
    const HELD = {
      instanceToken: 'dork_inst_held',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
      previousLinkProof: null,
    };
    const OK_HEARTBEAT: Step = {
      status: 200,
      body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-09-30T00:00:00Z' },
    };

    /** Leave a `denied` note on a computer that keeps its key. */
    async function deniedRelink(extra: Parameters<typeof routerFetch>[0] = {}) {
      setCloud(HELD);
      let token: Step = { status: 400, body: { error: 'access_denied' } };
      const fetchImpl = routerFetch({
        code: () => CODES,
        token: () => token,
        heartbeat: () => OK_HEARTBEAT,
        revoke: () => ({ status: 200, body: { ok: true } }),
        ...extra,
      });
      manager = new CloudLinkManager({
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().relinkOutcome).toBe('denied');
      return {
        approveNext: () => {
          token = { status: 200, body: { access_token: 'dork_inst_new' } };
        },
      };
    }

    it('drops the note when a new link is started and approved', async () => {
      const { approveNext } = await deniedRelink();
      approveNext();
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note when a new link is started, even if that start fails', async () => {
      let codeRequests = 0;
      await deniedRelink({
        code: () => (++codeRequests === 1 ? CODES : { status: 502, body: {} }),
      });
      await expect(manager.startLink()).rejects.toThrow();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note on unlink, so a later link starts clean', async () => {
      await deniedRelink();
      await manager.unlink();
      setCloud(HELD);
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note when the key is refused, so a later link starts clean', async () => {
      let heartbeat: Step = { status: 401, body: {} };
      await deniedRelink({ heartbeat: () => heartbeat });
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('unlinked');
      heartbeat = OK_HEARTBEAT;
      setCloud(HELD);
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });
  });
});
