/**
 * @vitest-environment node
 *
 * The owner's link routes on `/api/hub/computers`, behind the real `/api`
 * chain: minting a link code and unlinking a computer answer only the owner's
 * own browser sign-in on a hub, never an agent or an API key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { parseRelayLinkCode } from '@dorkos/shared/session-relay-link';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: audit.record,
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { LinkCodeBook } from '../../services/core/hub-relay/index.js';
import type { HubComputerLinkDeps } from '../hub-computer-links.js';
import { createHubComputerRoutes, type HubComputerRoutesDeps } from '../hub-computers.js';

const caller: { credential: 'cookie' | 'api-key' | null } = { credential: 'cookie' };
const codes = new LinkCodeBook();

const deps = {
  isHub: vi.fn(() => true),
  linkedComputerIds: () => ['mac-1'],
  connection: () => null,
  wake: vi.fn(),
  viewers: { open: vi.fn(() => () => {}) },
} satisfies HubComputerRoutesDeps;

const links = {
  servingOrigin: vi.fn((): string | null => 'https://me.dorkos.app'),
  mint: vi.fn((mintedBy: Parameters<HubComputerLinkDeps['mint']>[0]) => codes.mint(mintedBy)),
  forget: vi.fn(async (computerId: string) => computerId === 'mac-1'),
  record: () => null,
} satisfies HubComputerLinkDeps;

const server = listeningServer(
  honoGroupListener(
    { path: '/api/hub/computers', routes: createHubComputerRoutes(deps, links) },
    {
      before: async (c, next) => {
        if (caller.credential)
          c.set('user', { userId: 'user_owner', credential: caller.credential });
        await next();
      },
    }
  )
);

beforeEach(() => {
  vi.clearAllMocks();
  caller.credential = 'cookie';
  deps.isHub.mockReturnValue(true);
  links.servingOrigin.mockReturnValue('https://me.dorkos.app');
});

const ROUTES = [
  ['post', '/api/hub/computers/link-code'],
  ['delete', '/api/hub/computers/mac-1'],
] as const;

describe('who is answered', () => {
  it.each(ROUTES)('refuses %s %s to a caller presenting agent identity', async (method, path) => {
    const res = await request(server)[method](path).set('X-DorkOS-Agent', 'agent-token');
    expect(res.status).toBe(403);
    expect(links.mint).not.toHaveBeenCalled();
    expect(links.forget).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('refuses %s %s to an API key', async (method, path) => {
    caller.credential = 'api-key';
    const res = await request(server)[method](path);
    expect(res.status).toBe(403);
    expect(links.mint).not.toHaveBeenCalled();
    expect(links.forget).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('refuses %s %s with no sign-in', async (method, path) => {
    caller.credential = null;
    expect((await request(server)[method](path)).status).toBe(401);
  });

  it.each(ROUTES)('answers %s %s with the /api 404 off a hub', async (method, path) => {
    deps.isHub.mockReturnValue(false);
    expect((await request(server)[method](path)).status).toBe(404);
  });
});

describe('POST /api/hub/computers/link-code', () => {
  it('mints a code with the hub host folded in, never cached, and records it', async () => {
    const res = await request(server).post('/api/hub/computers/link-code');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const parsed = parseRelayLinkCode(res.body.linkCode);
    expect(parsed?.origin).toBe('https://me.dorkos.app');
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    // The code it answered is the one the book will redeem.
    expect(codes.consume(parsed!.code).ok).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.relay.link_code.create', outcome: 'ok' })
    );
  });

  it('answers 503 while the hub does not serve', async () => {
    links.servingOrigin.mockReturnValue(null);
    const res = await request(server).post('/api/hub/computers/link-code');
    expect(res.status).toBe(503);
    expect(links.mint).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/hub/computers/:computerId', () => {
  it('unlinks a computer and records it', async () => {
    const res = await request(server).delete('/api/hub/computers/mac-1');
    expect(res.status).toBe(204);
    expect(links.forget).toHaveBeenCalledWith('mac-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub.relay.computer.unlink',
        target: { type: 'computer', id: 'mac-1' },
      })
    );
  });

  it('answers a fixed refusal, never a bare 500, when the store fails, and records it', async () => {
    links.forget.mockRejectedValueOnce(new Error('disk full'));
    const res = await request(server).delete('/api/hub/computers/mac-1');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Couldn't unlink that computer. Try again.",
      code: 'UNLINK_FAILED',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub.relay.computer.unlink',
        outcome: 'failed',
        error: 'store_failed',
      })
    );
  });

  it('answers 404 for a computer it does not serve', async () => {
    const res = await request(server).delete('/api/hub/computers/mac-2');
    expect(res.status).toBe(404);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
