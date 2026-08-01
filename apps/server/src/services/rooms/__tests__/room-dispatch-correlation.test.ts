/**
 * One entry, three agents, three dispatch ids — and one `entryId` joining them.
 *
 * The fan-out grain is the whole reason a dispatch id is not "an id per
 * message": a room entry addressed to three agents starts three independent
 * turns, on three sessions, that finish at three different times. Giving them
 * one id would put three interleaved turns behind one filter and answer no
 * question at all. The entry is what recovers the fan-out; the dispatch is what
 * recovers each agent's own chain.
 *
 * Driven through the real service and the real dispatcher — only the runner
 * stands in, because the alternative is a model call.
 */
import { describe, it, expect } from 'vitest';
import { isDispatchId } from '@dorkos/shared/dispatch-id';
import { currentDispatch } from '../../../lib/dispatch-context.js';
import { recentRefusals, resetDispatchBuffers } from '../../observability/dispatch-buffers.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
});

describe('a room dispatch is one agent answering one trigger', () => {
  it('gives each of three addressed agents its own id, under one entry', async () => {
    /** What the dispatcher's ambient context looked like inside each turn. */
    const observed: Array<{ authorId: string; dispatchId?: string; entryId?: string }> = [];
    const runner = outcomeRunner((request) => {
      const ctx = currentDispatch();
      observed.push({
        authorId: request.authorId,
        ...(ctx ? { dispatchId: ctx.dispatchId, entryId: ctx.entryId } : {}),
      });
      // Silence, so no reply re-enters the cascade and the three turns stay
      // three peers of one entry rather than a chain.
      return { text: null };
    });

    const { service, authors, human } = createRoomHarness({
      agents,
      runner,
      // A ceiling of 0 would make the shape look sane while the real one is
      // broken; a realistic one is what the room actually runs with.
      maxAgentDepth: 3,
    });
    const room = service.createRoom(
      {
        kind: 'channel',
        title: 'Backend',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo', '/agents/cy'],
      },
      human
    );
    // A channel seeds `engaged`; `always` is what makes all three answer one
    // message, which is the fan-out this test is about.
    for (const [path, name] of [
      ['/agents/ana', 'Ana'],
      ['/agents/bo', 'Bo'],
      ['/agents/cy', 'Cy'],
    ] as const) {
      service.updateMembership(room.id, human, authors.resolveAgent(path, name).id, 'always');
    }

    const seed = service.post(room.id, { authorId: human, text: 'is the build green?' });
    await service.triggersIdle();
    await settleUntil(() => observed.length === 3, 'three agents to have taken a turn');

    const ids = observed.map((o) => o.dispatchId);
    expect(ids.every((id) => id !== undefined && isDispatchId(id))).toBe(true);
    // Three distinct ids…
    expect(new Set(ids).size).toBe(3);
    // …under exactly one entry, which is what recovers the fan-out.
    expect(new Set(observed.map((o) => o.entryId))).toEqual(new Set([seed.id]));
  });

  it('keeps one agent on one id when the runtime renames its session mid-turn', async () => {
    // The room mints a placeholder session id, the runtime answers on its own
    // canonical one, and `rebindRoomSession` reconciles afterwards. The dispatch
    // id is stable exactly where the session id is not — that is the entire
    // reason the correlation key is not `sessionId`.
    const seen: string[] = [];
    const runner = outcomeRunner((request) => {
      seen.push(currentDispatch()?.dispatchId ?? 'none');
      expect(request.sessionId).not.toBe('canonical-from-the-runtime');
      return { text: 'on it', sessionId: 'canonical-from-the-runtime' };
    });

    const { service, store, authors, human } = createRoomHarness({ agents, runner });
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    service.updateMembership(room.id, human, ana, 'always');

    service.post(room.id, { authorId: human, text: 'ping' });
    await service.triggersIdle();

    // Proof the rename actually happened, so the assertion below spans a real
    // rekey rather than a no-op.
    expect(store.getRoomSession(room.id, ana)).toBe('canonical-from-the-runtime');
    expect(seen).toHaveLength(1);
    expect(isDispatchId(seen[0])).toBe(true);
  });

  describe('refusals decided before a target is claimed', () => {
    it('files a budget refusal under the target it refused', async () => {
      // The budget is asked AFTER the guard has allowed a target and given it an
      // id, so this refusal has a real dispatch that simply never ran. Filing it
      // with no id would lose the only record of a turn that was owed.
      resetDispatchBuffers();
      const { service, authors, human } = createRoomHarness({
        agents,
        runner: outcomeRunner(() => ({ text: null })),
        maxAutomaticTurnsPerRoomPerHour: 0,
      });
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
        human
      );
      service.updateMembership(
        room.id,
        human,
        authors.resolveAgent('/agents/ana', 'Ana').id,
        'always'
      );

      service.post(room.id, { authorId: human, text: 'ping' });
      await service.triggersIdle();

      const budget = recentRefusals(20).find((r) => r.reason === 'room_budget');
      expect(budget).toBeDefined();
      expect(budget?.dispatchId).toBeDefined();
      expect(isDispatchId(budget?.dispatchId as string)).toBe(true);
    });

    it("never stamps a cascade refusal with the REPLYING agent's dispatch id", async () => {
      // The wrong-id case, and the reason `dispatchId: null` exists. An agent's
      // reply is posted from inside that agent's own dispatch scope, so
      // `claimTargets` — which runs synchronously inside `RoomService.post` —
      // evaluates the next hop's refusals under the REPLYING agent's id. A
      // refusal about Bo filed under Ana's dispatch is worse than one filed
      // under none: a filter over Ana's chain returns a fact about somebody else.
      resetDispatchBuffers();
      const seen: string[] = [];
      const { service, authors, human } = createRoomHarness({
        agents,
        // Ana answers by naming Bo, which re-enters the cascade at the ceiling
        // and gets Bo refused — from inside Ana's scope.
        runner: outcomeRunner((request) => {
          const id = currentDispatch()?.dispatchId;
          if (id) seen.push(id);
          return { text: request.authorId === anaId ? 'over to @bo' : 'on it' };
        }),
        maxAgentDepth: 1,
      });
      const room = service.createRoom(
        {
          kind: 'channel',
          title: 'Backend',
          members: [],
          agentPaths: ['/agents/ana', '/agents/bo'],
        },
        human
      );
      const anaId = authors.resolveAgent('/agents/ana', 'Ana').id;
      service.updateMembership(room.id, human, anaId, 'mention-only');
      service.updateMembership(
        room.id,
        human,
        authors.resolveAgent('/agents/bo', 'Bo').id,
        'mention-only'
      );

      service.post(room.id, { authorId: human, text: '@ana can you look?' });
      await service.triggersIdle();

      const cascade = recentRefusals(50).filter((r) => r.reason.startsWith('cascade_'));
      expect(cascade.length).toBeGreaterThan(0);
      // Ana's dispatch id was ambient when each of these was decided.
      expect(seen.length).toBeGreaterThan(0);
      for (const refusal of cascade) {
        expect(refusal.dispatchId).toBeUndefined();
        expect(seen).not.toContain(refusal.dispatchId);
      }
    });
  });

  it('does not leak the dispatch context back to the caller that posted', () => {
    // `RoomService.post` runs SYNCHRONOUSLY inside the HTTP handler and returns
    // before any turn does. A dispatch scope that leaked out of it would tag the
    // poster's own request — and every unrelated line after it — with one
    // agent's id.
    const { service, authors, human } = createRoomHarness({
      agents,
      runner: outcomeRunner(() => ({ text: null })),
    });
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    service.updateMembership(
      room.id,
      human,
      authors.resolveAgent('/agents/ana', 'Ana').id,
      'always'
    );
    service.post(room.id, { authorId: human, text: 'ping' });
    expect(currentDispatch()).toBeUndefined();
  });
});
