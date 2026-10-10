/**
 * The `commitments` capability domain (spec `heartbeats` §12): `commitment_add`
 * records the CALLING agent's promise only, `commitment_update` lets the
 * promising agent or a person change one and refuses another agent, and
 * `commitments_list` lets any agent read every agent's list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import { commitmentsDomain } from '../commitment-capabilities.js';
import { CommitmentService } from '../commitment-service.js';
import { CommitmentStore } from '../commitment-store.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** An agent identity at a home folder. */
function identityAt(agentPath: string, extra: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentPath,
    displayName: agentPath.split('/').pop()!,
    createdAt: '2026-10-10T09:00:00.000Z',
    ...extra,
  } as AgentIdentity;
}

const ana = identityAt('/agents/ana');
const bo = identityAt('/agents/bo');
const AGENT_IDS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };

/** What the tools answer, loosely: a refusal, one commitment, or a list. */
interface CallResult {
  ok?: boolean;
  code?: string;
  commitment?: Commitment;
  commitments?: Commitment[];
  truncated?: boolean;
}

/** One capability of the domain, parsed and invoked the way the registry does. */
async function call(
  deps: CapabilityDeps,
  id: string,
  input: Record<string, unknown>,
  context: CapabilityHandlerContext
) {
  const capability = commitmentsDomain.capabilities.find((c) => c.id === id);
  if (!capability) throw new Error(`commitments domain does not declare ${id}`);
  const parsed = capability.input.parse(input);
  return (await capability.invoke(deps, parsed, context)) as CallResult;
}

describe('commitments domain', () => {
  let service: CommitmentService;
  let deps: CapabilityDeps;

  beforeEach(() => {
    service = new CommitmentService({ store: new CommitmentStore(createTestDb()) });
    deps = {
      logger: noopLogger,
      commitmentDeps: {
        service,
        agentIdForPath: (agentPath: string) => AGENT_IDS[agentPath],
      },
    } as unknown as CapabilityDeps;
  });

  afterEach(() => service.stop());

  it('declares the three tools with no area, each with a written reason', () => {
    expect(
      commitmentsDomain.capabilities.map((c) => [c.id, c.surfaces.mcp?.toolName, c.tier, c.area])
    ).toEqual([
      ['commitments.add', 'commitment_add', 'act', null],
      ['commitments.update', 'commitment_update', 'act', null],
      ['commitments.list', 'commitments_list', 'observe', null],
    ]);
    for (const c of commitmentsDomain.capabilities) expect(c.areaNote).toBeTruthy();
  });

  it('never tells an agent it will be woken: nothing wakes it yet (DOR-2788 PR 3)', () => {
    const add = commitmentsDomain.capabilities.find((c) => c.id === 'commitments.add')!;
    expect(add.description.toLowerCase()).not.toContain('wake');
    expect(add.description.toLowerCase()).not.toContain('woken');
  });

  describe('commitment_add', () => {
    it("records the calling agent's own promise, with its chat as the source", async () => {
      const result = await call(
        deps,
        'commitments.add',
        { what: 'Send Acme the quote', to: 'external:Acme', sourceEntryId: 'entry-1' },
        { identity: ana, sessionId: 'chat-ana', mcpServer: 'in-session' }
      );
      expect(result).toMatchObject({
        ok: true,
        commitment: {
          agentId: 'agent-ana',
          to: 'external:Acme',
          sourceSessionId: 'chat-ana',
          sourceRoomEntryId: 'entry-1',
          state: 'open',
        },
      });
    });

    it.each([
      ['no identity', {}],
      ['a revoked identity', { identity: identityAt('/agents/ana', { inactive: 'revoked' }) }],
    ] as const)('refuses with NO_AGENT for %s, recording nothing', async (_label, context) => {
      const result = await call(
        deps,
        'commitments.add',
        { what: 'Anything' },
        context as CapabilityHandlerContext
      );
      expect(result).toMatchObject({ ok: false, code: 'NO_AGENT' });
      expect(service.list()).toEqual([]);
    });

    it('refuses an agent Mesh does not know', async () => {
      const result = await call(
        deps,
        'commitments.add',
        { what: 'Anything' },
        { identity: identityAt('/agents/stranger') }
      );
      expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_AGENT' });
    });

    it('refuses a promise longer than 300 characters before it reaches the service', async () => {
      await expect(
        call(deps, 'commitments.add', { what: 'x'.repeat(301) }, { identity: ana })
      ).rejects.toThrow();
    });
  });

  describe('commitment_update', () => {
    let id: string;

    beforeEach(async () => {
      const made = await call(deps, 'commitments.add', { what: 'Ship it' }, { identity: ana });
      id = made.commitment!.id;
    });

    it('lets the promising agent mark it kept', async () => {
      const result = await call(
        deps,
        'commitments.update',
        { id, state: 'kept' },
        { identity: ana }
      );
      expect(result).toMatchObject({ ok: true, commitment: { state: 'kept' } });
    });

    it('refuses another agent with NOT_YOURS, and the promise stays open', async () => {
      const result = await call(
        deps,
        'commitments.update',
        { id, state: 'dropped' },
        { identity: bo }
      );
      expect(result).toMatchObject({ ok: false, code: 'NOT_YOURS' });
      expect(service.get(id)!.state).toBe('open');
    });

    it('lets a person (no agent behind the call) drop it', async () => {
      const result = await call(deps, 'commitments.update', { id, state: 'dropped' }, {});
      expect(result).toMatchObject({ ok: true, commitment: { state: 'dropped' } });
    });

    it.each([
      ['an identity that did not verify', { agentIdentityPresented: true }],
      ['an in-session chat with no agent', { mcpServer: 'in-session', sessionId: 's1' }],
      ['a revoked agent', { identity: identityAt('/agents/ana', { inactive: 'revoked' }) }],
    ] as const)('never reads %s as a person', async (_label, context) => {
      const result = await call(
        deps,
        'commitments.update',
        { id, state: 'kept' },
        context as CapabilityHandlerContext
      );
      expect(result).toMatchObject({ ok: false, code: 'NO_AGENT' });
      expect(service.get(id)!.state).toBe('open');
    });
  });

  describe('commitments_list', () => {
    it('reads open promises only by default, and never shows the source chat', async () => {
      const made = await call(
        deps,
        'commitments.add',
        { what: 'Open one' },
        { identity: ana, sessionId: 'chat-ana' }
      );
      const closed = await call(deps, 'commitments.add', { what: 'Kept one' }, { identity: ana });
      service.update({ kind: 'person' }, closed.commitment!.id, { state: 'kept' });

      const byDefault = await call(deps, 'commitments.list', {}, { identity: bo });
      expect(byDefault.commitments!.map((c) => c.what)).toEqual(['Open one']);
      expect(byDefault.commitments![0]!.sourceSessionId).toBeNull();
      expect(service.get(made.commitment!.id)!.sourceSessionId).toBe('chat-ana');

      const all = await call(deps, 'commitments.list', { state: 'all' }, { identity: bo });
      expect(all.commitments!.map((c) => c.what)).toEqual(['Open one', 'Kept one']);
      const limited = await call(deps, 'commitments.list', { state: 'all', limit: 1 }, {});
      expect(limited.commitments).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      expect(all.truncated).toBe(false);
    });

    it("lets another agent read every agent's list", async () => {
      await call(deps, 'commitments.add', { what: 'Ana promise' }, { identity: ana });
      await call(deps, 'commitments.add', { what: 'Bo promise' }, { identity: bo });

      const everyone = await call(deps, 'commitments.list', {}, { identity: bo });
      expect(everyone.commitments!.map((c) => c.what).sort()).toEqual([
        'Ana promise',
        'Bo promise',
      ]);
      const anas = await call(deps, 'commitments.list', { agentId: 'agent-ana' }, { identity: bo });
      expect(anas.commitments!.map((c) => c.what)).toEqual(['Ana promise']);
    });
  });
});
