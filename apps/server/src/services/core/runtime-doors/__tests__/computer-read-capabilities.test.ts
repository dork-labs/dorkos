/**
 * This computer's own reads on the capability mount (DOR-4978): the hand
 * routes' readers, codes and sentences, kept. Every read stays open to the
 * callers it always was, an agent included; the chat read still hides a chat
 * an agent may not read; the OpenRouter sign-in read still stays at this
 * computer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityHandlerContext, CapabilityRequestFacts } from '../../capabilities/index.js';
import { CapabilityToolError } from '../../capabilities/capability-definition.js';
import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { initConfigManager } from '../../config-manager.js';
import {
  computerReadsDomains,
  setComputerReader,
  type ComputerReader,
} from '../computer-read-capabilities.js';

const CHAT = '00000000-0000-4000-8000-00000000c0de';
const HIDDEN = '00000000-0000-4000-8000-00000000beef';
const AGENT = { 'X-DorkOS-Agent': 'agent-1' };

/** A reader whose chat check hides one chat, and whose git read refuses one folder. */
const reader = {
  autoModeStops: () => ({
    stops: 0,
    stopsByTool: {},
    stopSessions: 0,
    assertions: 0,
    assertionsByTier: { observe: 0, act: 0, destructive: 0 },
    since: '2026-11-28T00:00:00.000Z',
  }),
  mayReadChat: (_context, chatId) => chatId !== HIDDEN,
  chatSpine: async (sessionId) => ({
    sessionId,
    runtime: 'claude-code',
    runtimeBound: true,
    lifecycle: null,
    seq: null,
    subscribers: null,
    waiters: null,
    projectorLive: false,
    lockHeldBy: null,
    lockAcquiredAt: null,
    pendingInteractions: [],
    durableEvents: { total: 0, byType: {} },
  }),
  keepAwake: () => ({
    enabled: true,
    supported: true,
    reason: null,
    asserted: false,
    working: { chats: 0, rooms: 0, tasks: 0, waking: false },
    wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
  }),
  gitStatus: async () => {
    throw new CapabilityToolError({
      code: 'PATH_OUTSIDE_BOUNDARY',
      error: 'Access denied: /Users/fixture/secret is outside',
    });
  },
  openRouterSignIn: () => ({ status: 'pending' }),
} as Partial<ComputerReader> as ComputerReader;

const server = listeningServer(
  honoGroupListener(computerReadsDomains.map((domain) => capabilityGroup(domain)))
);

// The `/api` chain reads config (login, the host allowlist): a fresh one, in a throwaway home.
let dorkHome: string;
beforeAll(() => {
  dorkHome = mkdtempSync(join(tmpdir(), 'dork-computer-reads-'));
  initConfigManager(dorkHome);
  setComputerReader(reader);
});
afterAll(() => {
  setComputerReader(undefined);
  rmSync(dorkHome, { recursive: true, force: true });
});

/** A call's context from somewhere other than this computer. */
const away = {
  request: { atThisComputerWithoutProgramKey: false } as CapabilityRequestFacts,
} as CapabilityHandlerContext;

describe('this computer’s reads', () => {
  it('answer an agent, as the hand routes did', async () => {
    for (const path of [
      '/api/keep-awake',
      '/api/debug/auto-mode-stops',
      `/api/debug/sessions/${CHAT}`,
    ]) {
      const res = await request(server).get(path).set(AGENT);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it('hide a chat an agent may not read, and refuse an id that is not one, in the hand route’s words', async () => {
    const hidden = await request(server).get(`/api/debug/sessions/${HIDDEN}`).set(AGENT);
    expect([hidden.status, hidden.body.code, hidden.body.detail]).toEqual([
      404,
      'session_not_found',
      'No chat with that id.',
    ]);
    const bad = await request(server).get('/api/debug/sessions/..%2F..%2Fetc%2Fpasswd');
    expect([bad.status, bad.body.detail]).toEqual([400, 'That isn’t a chat id.']);
  });

  it('refuse a folder outside the boundary with the fixed sentence, never the path', async () => {
    const res = await request(server).get('/api/git/status?dir=/Users/fixture/secret');
    expect([res.status, res.body.code]).toEqual([403, 'outside_boundary']);
    expect(res.body.detail).toBe('Pick a folder inside the ones DorkOS may use.');
    expect(res.text).not.toContain('/Users/fixture');
  });

  it('say DorkOS is starting before boot wires the reader', async () => {
    setComputerReader(undefined);
    try {
      const res = await request(server).get('/api/keep-awake');
      expect([res.status, res.body.code]).toEqual([503, 'temporarily_unavailable']);
    } finally {
      setComputerReader(reader);
    }
  });

  it('answer an OpenRouter sign-in at this computer, and refuse one from elsewhere', async () => {
    const res = await request(server).get('/api/runtimes/opencode/openrouter/oauth/status?state=s');
    expect([res.status, res.body]).toEqual([200, { status: 'pending' }]);
    const capability = computerReadsDomains
      .flatMap((domain) => domain.capabilities)
      .find((each) => each.id === 'runtimes.openrouter_sign_in_status')!;
    await expect(
      Promise.resolve().then(() => capability.invoke({ logger: noopLogger }, {}, away))
    ).rejects.toMatchObject({
      payload: { code: 'RUNTIMES_NOT_LOCAL', error: expect.stringContaining('this computer') },
    });
  });
});
