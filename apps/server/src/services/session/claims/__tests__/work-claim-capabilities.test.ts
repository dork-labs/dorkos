/**
 * The work-claim tools (DOR-4019): the agent and chat come from the verified
 * turn, a second chat is refused naming the holder, a holder the caller may not
 * read is named only as private, and only the holder releases.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../../core/capabilities/index.js';

import { workClaimDomain, type ClaimHolderChat } from '../work-claim-capabilities.js';
import { WorkClaimService } from '../work-claim-service.js';

const AGENT_IDS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };
const PRIVATE_CHATS = new Set(['ana-dm-with-person']);

interface CallResult {
  ok: boolean;
  code?: string;
  error?: string;
  renewed?: boolean;
  holder?: {
    key: string;
    chat: ClaimHolderChat & { sessionId: string | null; you: boolean };
    note: string | null;
  };
  claims?: { key: string; chat: { sessionId: string | null; you: boolean } }[];
}

let deps: CapabilityDeps;

beforeEach(() => {
  const service = new WorkClaimService({ db: createTestDb() });
  deps = {
    logger: noopLogger,
    workClaimDeps: {
      service,
      agentIdForPath: (agentPath) => AGENT_IDS[agentPath],
      describeChat: async (_caller, sessionId) =>
        PRIVATE_CHATS.has(sessionId)
          ? { title: null, link: null, private: true }
          : {
              title: `Chat ${sessionId}`,
              link: `[Chat ${sessionId}](/session?session=${sessionId})`,
              private: false,
            },
    },
  };
});

function as(agentPath: string, sessionId?: string): CapabilityHandlerContext {
  return {
    identity: { agentPath, displayName: agentPath.split('/').pop()! },
    ...(sessionId ? { sessionId } : {}),
  } as unknown as CapabilityHandlerContext;
}

async function call(id: string, input: Record<string, unknown>, context: CapabilityHandlerContext) {
  const capability = workClaimDomain.capabilities.find((c) => c.id === id);
  if (!capability) throw new Error(`work-claims does not declare ${id}`);
  return (await capability.invoke(deps, capability.input.parse(input), context)) as CallResult;
}

describe('the work-claim tools', () => {
  it('project onto both MCP servers with the three tool names', () => {
    expect(
      workClaimDomain.capabilities.map((c) => [c.id, c.tier, c.surfaces.mcp?.toolName])
    ).toEqual([
      ['work-claims.claim', 'act', 'work_claim'],
      ['work-claims.check', 'observe', 'work_claim_check'],
      ['work-claims.release', 'act', 'work_claim_release'],
    ]);
  });

  it('claim, then a sibling chat sees it and is refused with the holder named', async () => {
    expect(
      await call('work-claims.claim', { key: 'dor-7', note: 'fixing' }, as('/agents/ana', 'chat-a'))
    ).toMatchObject({
      ok: true,
      renewed: false,
    });
    const seen = await call('work-claims.check', { keys: ['DOR-7'] }, as('/agents/ana', 'chat-b'));
    expect(seen.claims).toEqual([
      expect.objectContaining({
        key: 'DOR-7',
        chat: expect.objectContaining({ sessionId: 'chat-a', you: false }),
      }),
    ]);
    const second = await call('work-claims.claim', { key: 'DOR-7' }, as('/agents/ana', 'chat-b'));
    expect(second).toMatchObject({ ok: false, code: 'CLAIMED' });
    expect(second.error).toContain('[Chat chat-a](/session?session=chat-a)');
  });

  it('names a holder the caller may not read only as a private chat', async () => {
    await call(
      'work-claims.claim',
      { key: 'DOR-8', note: 'secret plan' },
      as('/agents/ana', 'ana-dm-with-person')
    );
    const second = await call('work-claims.claim', { key: 'DOR-8' }, as('/agents/ana', 'chat-b'));
    expect(second).toMatchObject({
      ok: false,
      code: 'CLAIMED',
      holder: { chat: { private: true, sessionId: null, title: null, link: null }, note: null },
    });
    expect(second.error).toContain('a private chat of yours');
    expect(second.error).not.toContain('ana-dm-with-person');
  });

  // Security Must 1 (review of 4a29990e5f): a private chat's key is itself private text.
  it('never reveals a private chat’s key to a sibling that lists claims without naming it', async () => {
    await call(
      'work-claims.claim',
      { key: 'Offer letter for Sam - 180k' },
      as('/agents/ana', 'ana-dm-with-person')
    );
    await call('work-claims.claim', { key: 'DOR-11' }, as('/agents/ana', 'chat-a'));
    const listed = await call('work-claims.check', {}, as('/agents/ana', 'room-seat'));
    expect(JSON.stringify(listed)).not.toMatch(/OFFER LETTER|SAM|180K/i);
    expect(listed.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: null, chat: expect.objectContaining({ private: true }) }),
        expect.objectContaining({ key: 'DOR-11' }),
      ])
    );
    // A caller that names the key already knows it, so it hears back about that key.
    const named = await call(
      'work-claims.check',
      { keys: ['offer letter for sam - 180k'] },
      as('/agents/ana', 'room-seat')
    );
    expect(named.claims).toEqual([
      expect.objectContaining({
        key: 'OFFER LETTER FOR SAM - 180K',
        chat: expect.objectContaining({ private: true }),
      }),
    ]);
  });

  it('never lets one agent see or touch another agent’s claims', async () => {
    await call('work-claims.claim', { key: 'DOR-9' }, as('/agents/ana', 'chat-a'));
    expect((await call('work-claims.check', {}, as('/agents/bo', 'bo-1'))).claims).toEqual([]);
    expect(
      await call('work-claims.release', { key: 'DOR-9' }, as('/agents/bo', 'bo-1'))
    ).toMatchObject({
      ok: false,
      code: 'NOT_CLAIMED',
    });
    expect(
      await call('work-claims.claim', { key: 'DOR-9' }, as('/agents/bo', 'bo-1'))
    ).toMatchObject({ ok: true });
  });

  it('only the holding chat releases', async () => {
    await call('work-claims.claim', { key: 'DOR-10' }, as('/agents/ana', 'chat-a'));
    expect(
      await call('work-claims.release', { key: 'DOR-10' }, as('/agents/ana', 'chat-b'))
    ).toMatchObject({
      ok: false,
      code: 'NOT_YOURS',
    });
    expect(
      await call('work-claims.release', { key: 'dor-10' }, as('/agents/ana', 'chat-a'))
    ).toEqual({ ok: true });
  });

  it('refuses a call with no chat or no registered agent', async () => {
    await expect(
      call('work-claims.claim', { key: 'DOR-1' }, as('/agents/ana'))
    ).rejects.toMatchObject({
      payload: { code: 'NO_CHAT' },
    });
    await expect(
      call('work-claims.claim', { key: 'DOR-1' }, as('/agents/nobody', 'x'))
    ).rejects.toMatchObject({
      payload: { code: 'UNKNOWN_AGENT' },
    });
  });
});
