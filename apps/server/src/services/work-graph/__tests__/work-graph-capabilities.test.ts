/**
 * `work-graph.record-pr` (DOR-5264): a chat's own live turn records the pull
 * request it opened and the tickets it works on. The chat comes only from the
 * token the turn's process carries, never from the call; every other caller is
 * refused. Real stores throughout: the link store, the identity service and
 * the run record over one test database, and the live turn marks.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import { AgentIdentityService } from '../../core/agent-identity/agent-identity-service.js';
import { TokenChats } from '../../core/agent-identity/token-chats.js';
import { createServerPrincipal } from '../../connectors/principal/server-principal.js';
import { marksOf, markRunningTurnOutsider } from '../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { RunStore } from '../../runs/run-store.js';
import { workGraphDomain } from '../work-graph-capabilities.js';
import { WorkLinkStore } from '../work-link-store.js';

const ANA = '/agents/ana';
const BO = '/agents/bo';
const AGENT_IDS: Record<string, string> = { [ANA]: 'agent-ana', [BO]: 'agent-bo' };
const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const OTHER_CHAT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const PR_URL = 'https://github.com/dork-labs/dorkos/pull/4242';

let db: Db;
let links: WorkLinkStore;
let identities: AgentIdentityService;
let runs: RunStore;
let busy: Set<string>;
let chatAgents: Map<string, string>;
let deps: CapabilityDeps;

beforeEach(() => {
  db = createTestDb();
  links = new WorkLinkStore({ db });
  identities = new AgentIdentityService(db, new TokenChats(2));
  runs = new RunStore(db, { epoch: '01THISBOOT0000000000000000' });
  busy = new Set();
  chatAgents = new Map([
    [CHAT, ANA],
    [OTHER_CHAT, ANA],
  ]);
  deps = {
    logger: noopLogger,
    workGraphDeps: {
      store: () => links,
      agentIdForPath: (agentPath) => AGENT_IDS[agentPath],
      resolveChat: (chatId) => links.resolveRekey(chatId),
      liveRun: (chatId) => {
        const run = runs.liveRunOf(chatId);
        return run ? { agentId: run.agentId } : undefined;
      },
      projectorBusy: (chatId) => busy.has(chatId),
      chatAgentPath: async (chatId) => chatAgents.get(chatId),
      marksOf,
    },
  };
});

afterEach(() => resetLiveOutsiderTurns());

/** A live run of `chatId` for the agent at `agentPath`. */
function startTurn(chatId: string, agentPath = ANA) {
  return runs.create({
    chatKey: chatId,
    status: 'running',
    openedBy: 'runtime',
    origin: null,
    agentId: AGENT_IDS[agentPath],
  });
}

/** The identity the HTTP chain resolves from a token minted for `chatId`'s process. */
async function tokenFor(chatId: string | undefined, agentPath = ANA) {
  const token = await identities.mint({ agentPath, displayName: agentPath.split('/').pop()! });
  // A process holding it started for `chatId` (the process token port's provider).
  if (chatId) identities.chats.hold(createHash('sha256').update(token).digest('hex'), chatId);
  return { token, identity: async () => identities.resolve(token) };
}

async function contextOf(
  identity: Awaited<ReturnType<AgentIdentityService['resolve']>>,
  extra: Partial<CapabilityHandlerContext> = {}
): Promise<CapabilityHandlerContext> {
  return { ...(identity ? { identity } : {}), ...extra } as CapabilityHandlerContext;
}

const capability = workGraphDomain.capabilities[0]!;

async function call(input: Record<string, unknown>, context: CapabilityHandlerContext) {
  return capability.invoke(deps, capability.input.parse(input), context) as Promise<{
    ok: true;
    chat: string;
    pr: string;
    tickets: string[];
    refused: { ref: string; reason: string }[];
  }>;
}

async function refusal(input: Record<string, unknown>, context: CapabilityHandlerContext) {
  try {
    await call(input, context);
  } catch (error) {
    return (error as { payload?: { code?: string } }).payload?.code ?? String(error);
  }
  return 'recorded';
}

const allLinks = () =>
  links.from({ kind: 'chat', id: CHAT }).concat(links.from({ kind: 'chat', id: OTHER_CHAT }));

describe('work-graph.record-pr', () => {
  it('records opened and works_on from the token’s chat, and returns refused tickets by name', async () => {
    startTurn(CHAT);
    const { identity } = await tokenFor(CHAT);
    const result = await call(
      {
        pr: PR_URL,
        tickets: ['DOR-5264', 'https://linear.app/dork-labs/issue/DOR-4970/x', 'PR #9', 'dor-1'],
      },
      await contextOf(await identity())
    );
    expect(result).toEqual({
      ok: true,
      chat: CHAT,
      pr: 'dork-labs/dorkos#4242',
      tickets: ['DOR-5264', 'DOR-4970'],
      refused: [
        { ref: 'PR #9', reason: 'not-a-ticket' },
        { ref: 'dor-1', reason: 'unrecognised' },
      ],
    });
    expect(
      links
        .from({ kind: 'chat', id: CHAT })
        .map((l) => [l.relation, l.to.id, l.source, l.recordingChatId])
    ).toEqual([
      ['opened', 'dork-labs/dorkos#4242', 'open-pr', CHAT],
      ['works_on', 'DOR-5264', 'open-pr', CHAT],
      ['works_on', 'DOR-4970', 'open-pr', CHAT],
    ]);
  });

  it('refuses a bad pull request whole, and writes nothing', async () => {
    startTurn(CHAT);
    const { identity } = await tokenFor(CHAT);
    expect(
      await refusal({ pr: 'DOR-5264', tickets: ['DOR-1'] }, await contextOf(await identity()))
    ).toBe('INVALID_PR');
    expect(allLinks()).toEqual([]);
  });

  it('takes no chat from the input', () => {
    for (const extra of [{ chat: OTHER_CHAT }, { sessionId: OTHER_CHAT }, { chatId: OTHER_CHAT }])
      expect(capability.input.safeParse({ pr: PR_URL, ...extra }).success).toBe(false);
  });

  it('writes the marks the turn carries at the call, not at the mint', async () => {
    startTurn(CHAT);
    const { identity } = await tokenFor(CHAT);
    markRunningTurnOutsider(CHAT, ANA);
    await call({ pr: PR_URL, tickets: ['DOR-7'] }, await contextOf(await identity()));
    expect(links.from({ kind: 'chat', id: CHAT }).map((l) => l.turnMarks)).toEqual([
      { outsider: true },
      { outsider: true },
    ]);
  });

  describe('refuses every caller that is not the chat’s own live turn', () => {
    it.each([
      ['a person (no identity)', async () => contextOf(undefined)],
      [
        'a token that names no chat',
        async () => contextOf(await (await tokenFor(undefined)).identity()),
      ],
      [
        'a revoked agent',
        async () => {
          const { identity } = await tokenFor(CHAT);
          await identities.revoke(ANA);
          return contextOf(await identity());
        },
      ],
      [
        'a session id that differs from the token’s chat',
        async () => contextOf(await (await tokenFor(CHAT)).identity(), { sessionId: OTHER_CHAT }),
      ],
      [
        'a runtime principal for another chat',
        async () =>
          contextOf(await (await tokenFor(CHAT)).identity(), {
            serverPrincipal: createServerPrincipal({
              kind: 'runtime',
              owner: { kind: 'local_install', installationId: 'install-1' },
              bindingId: 'binding-1',
              runtime: 'codex',
              canonicalSessionId: OTHER_CHAT,
              agentId: 'agent-ana',
              agentPath: ANA,
            }),
          }),
      ],
      [
        'a chat whose process was disposed',
        async () => {
          const { token, identity } = await tokenFor(CHAT);
          identities.chats.release([createHash('sha256').update(token).digest('hex')]);
          return contextOf(await identity());
        },
      ],
      [
        'an entry the map evicted, while another chat is mid-turn',
        async () => {
          const { identity } = await tokenFor(CHAT);
          await tokenFor(OTHER_CHAT);
          await tokenFor(OTHER_CHAT);
          return contextOf(await identity());
        },
      ],
    ])('%s', async (_name, build) => {
      startTurn(CHAT);
      startTurn(OTHER_CHAT);
      expect(await refusal({ pr: PR_URL }, await build())).toBe('NOT_A_CHAT_TURN');
      expect(allLinks()).toEqual([]);
    });

    it('a chat that is not mid-turn, and the same chat once its turn ended', async () => {
      const { identity } = await tokenFor(CHAT);
      expect(await refusal({ pr: PR_URL }, await contextOf(await identity()))).toBe(
        'NOT_A_CHAT_TURN'
      );
      const run = startTurn(CHAT);
      runs.endTurn(run, 'completed');
      expect(await refusal({ pr: PR_URL }, await contextOf(await identity()))).toBe(
        'NOT_A_CHAT_TURN'
      );
    });

    it('a turn the run record holds for another agent, or a chat of another agent', async () => {
      startTurn(CHAT, BO);
      const { identity } = await tokenFor(CHAT);
      expect(await refusal({ pr: PR_URL }, await contextOf(await identity()))).toBe(
        'NOT_A_CHAT_TURN'
      );
      busy.add(OTHER_CHAT);
      chatAgents.set(OTHER_CHAT, BO);
      const other = await tokenFor(OTHER_CHAT);
      expect(await refusal({ pr: PR_URL }, await contextOf(await other.identity()))).toBe(
        'NOT_A_CHAT_TURN'
      );
    });

    it('a fork: a token for the source chat never records for its fork', async () => {
      links.record({
        from: { kind: 'chat', id: OTHER_CHAT },
        relation: 'forked_from',
        to: { kind: 'chat', id: CHAT },
        source: 'server',
      });
      startTurn(OTHER_CHAT);
      const { identity } = await tokenFor(CHAT);
      expect(await refusal({ pr: PR_URL }, await contextOf(await identity()))).toBe(
        'NOT_A_CHAT_TURN'
      );
    });
  });

  describe('accepts the chat’s own turn', () => {
    it('when the session the surface names is the same chat', async () => {
      startTurn(CHAT);
      const { identity } = await tokenFor(CHAT);
      expect(
        await refusal({ pr: PR_URL }, await contextOf(await identity(), { sessionId: CHAT }))
      ).toBe('recorded');
    });

    it('through the projector when the run record holds no run for the turn', async () => {
      busy.add(CHAT);
      const { identity } = await tokenFor(CHAT);
      expect((await call({ pr: PR_URL }, await contextOf(await identity()))).chat).toBe(CHAT);
    });

    it('after a re-key: the token’s first id records on the chat’s current id', async () => {
      links.record({
        from: { kind: 'chat', id: OTHER_CHAT },
        relation: 'rekeyed_from',
        to: { kind: 'chat', id: CHAT },
        source: 'server',
      });
      startTurn(OTHER_CHAT);
      const { identity } = await tokenFor(CHAT);
      expect((await call({ pr: PR_URL }, await contextOf(await identity()))).chat).toBe(OTHER_CHAT);
      expect(links.from({ kind: 'chat', id: OTHER_CHAT }, 'opened')).toHaveLength(1);
    });
  });
});
