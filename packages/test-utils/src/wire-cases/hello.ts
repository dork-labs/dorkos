/**
 * The hello's cases (spec `space-computer-contract` §15.1 H1, step W1), plus
 * the harness's own drop and restart cases (step W3). Written once; the suite
 * runs each in process and over the wire.
 *
 * @module test-utils/wire-cases/hello
 */
import { expect } from 'vitest';
import { SESSION_RELAY_FEATURES } from '@dorkos/shared/session-relay';
import type { RelayCall } from '@dorkos/shared/session-relay-agent-computer';
import type { WireCase, WireStart } from '../wire-conformance.js';

const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const LIST: RelayCall = { op: 'tools.list', agentId: AGENT, sessionId: SESSION };
const CALL: RelayCall = {
  op: 'tools.call',
  agentId: AGENT,
  sessionId: SESSION,
  tool: 'mesh_list',
  input: {},
};
const STATUS: RelayCall = { op: 'computer.status', busy: false, turns: [] };

/** Feature lists that overlap in part: only `tools.list` is in both. */
const PARTIAL: WireStart = {
  computer: [...SESSION_RELAY_FEATURES, 'tools.list', 'tools.call'],
  home: ['tools.list', 'computer.status'],
};

/** The refusal for a feature the other side did not agree to. */
const needsUpdate = (feature: string) => ({
  ok: false,
  error: expect.objectContaining({ status: 501, code: 'needs_update', feature }),
});

/** H1, the hello's cases, and the harness's drop and restart. */
export const HELLO_CASES: readonly WireCase[] = [
  {
    name: 'H1: each side agrees only the overlap of the two lists',
    async run(runner) {
      const ends = await runner.start(PARTIAL);
      expect(ends.home.agreed()).toEqual(['tools.list']);
      expect(ends.computer.agreed()).toEqual(['tools.list']);
      expect(ends.home.connected() && ends.computer.connected()).toBe(true);
    },
  },
  {
    name: 'H1: a call outside the overlap is refused on the computer, before it is sent',
    async run(runner) {
      const ends = await runner.start(PARTIAL);
      const before = ends.computer.sent();
      const outcome = ends.computer.call(CALL);
      await ends.settle();
      await expect(outcome).resolves.toEqual(needsUpdate('tools.call'));
      expect(ends.computer.sent()).toBe(before);
      expect(ends.home.served).toEqual([]);
    },
  },
  {
    name: 'H1: a call inside the overlap is served by the home',
    async run(runner) {
      const ends = await runner.start(PARTIAL);
      const outcome = ends.computer.call(LIST);
      await ends.settle();
      await expect(outcome).resolves.toEqual({ ok: true, body: { tools: [] } });
      expect(ends.home.served).toEqual([LIST]);
    },
  },
  {
    name: 'H1: a call outside the overlap that reaches the home is refused, and the connection stays up',
    async run(runner) {
      const ends = await runner.startUnchecked(PARTIAL);
      await expect(ends.send(STATUS)).resolves.toEqual(needsUpdate('computer.status'));
      await expect(ends.send(LIST)).resolves.toEqual({ ok: true, body: { tools: [] } });
      expect(ends.home.served).toEqual([LIST]);
      expect(ends.home.connected()).toBe(true);
    },
  },
  {
    name: 'a drop fails the call in flight, and both ends see the link gone',
    async run(runner) {
      const ends = await runner.start({ ...PARTIAL, hold: ['tools.list'] });
      const outcome = ends.computer.call(LIST);
      await ends.settle();
      expect(ends.home.served).toEqual([LIST]);
      ends.drop();
      await expect(outcome).resolves.toMatchObject({ ok: false, error: { status: 503 } });
      expect(ends.computer.connected()).toBe(false);
      expect(ends.home.connected()).toBe(false);
    },
  },
  {
    name: 'a restart works the agreed set out again from the new hellos, never copied over',
    async run(runner) {
      const first = await runner.start(PARTIAL);
      expect(first.computer.agreed()).toEqual(['tools.list']);
      // The computer comes back naming only `computer.status`.
      const computer = await first.restart('computer', [
        ...SESSION_RELAY_FEATURES,
        'computer.status',
      ]);
      expect(computer.computer.agreed()).toEqual(['computer.status']);
      expect(computer.home.agreed()).toEqual(['computer.status']);
      // The home comes back serving only `tools.list`: nothing overlaps now.
      const home = await computer.restart('home', ['tools.list']);
      expect(home.computer.agreed()).toEqual([]);
      expect(home.home.agreed()).toEqual([]);
      expect(home.computer.connected() && home.home.connected()).toBe(true);
    },
  },
];
