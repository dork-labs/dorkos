import { FakeAgentRuntime } from '@dorkos/test-utils';
/** Real recorded-turn policy and outside-word capture; no provider or SQL. */
import { afterEach, describe, expect, it } from 'vitest';
import { setTeammateSpaceGate } from '../teammate-mark.js';
afterEach(() => setTeammateSpaceGate(null));
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  recordTurnLevels,
  turnSerialOf,
  lastTurnLevelOf,
  captureCurrentTransfer,
  aliasTurnLevel,
  carryTurnLevel,
  markRunningTurn,
  TURN_LEVEL_MEMORY,
} from '../turn-levels.js';
let id = 0;
const fresh = () => `capture-casey-${++id}`;
function recorder(mode = 'bypassPermissions') {
  const fake = new FakeAgentRuntime('claude-code');
  fake.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
  return recordTurnLevels(fake, () => mode);
}
async function record(runtime: AgentRuntime, session: string, opts?: MessageOpts) {
  for await (const _ of runtime.sendMessage(session, 'fixture', opts)) {
    /* local generator only */
  }
  return turnSerialOf(session)!;
}
describe('recorded current transferable handoff capture', () => {
  it('captures actual recorded Full with no new cap and clean word evidence', async () => {
    const session = fresh();
    const serial = await record(recorder(), session);
    const captured = captureCurrentTransfer(session, serial);
    expect(captured).toMatchObject({
      state: 'recorded-transfer',
      sessionId: session,
      turnSerial: serial,
      wordEvidence: 'recorded',
      carry: {
        permissionCeiling: null,
        outsideWords: false,
        externalAuthor: false,
        outsider: false,
        teammate: false,
      },
    });
    if (captured.state !== 'recorded-transfer') throw new Error('Actual recorder did not capture');
    expect(Object.isFrozen(captured.carry)).toBe(true);
    // Durable recipient+codec roundtrip now belongs to real public admission test(v2 envelope).
  });
  it('does not turn a real sender raw narrow bound or mode into a new transferred cap', async () => {
    const session = fresh();
    const runtime = recorder('plan');
    const serial = await record(runtime, session, {
      permissionCeiling: { asks: 'always', reach: 'read' },
    });
    expect(lastTurnLevelOf(session)?.reach).toBe('read');
    expect(captureCurrentTransfer(session, serial)).toMatchObject({
      state: 'recorded-transfer',
      carry: { permissionCeiling: null, outsideWords: false },
    });
  });
  it('captures actual recorded outsider mark without a fabricated runtime-default cap', async () => {
    const session = fresh();
    const serial = await record(recorder(), session, { permissionCeiling: 'runtime-default' });
    expect(captureCurrentTransfer(session, serial)).toMatchObject({
      state: 'recorded-transfer',
      carry: { permissionCeiling: null, outsider: true, externalAuthor: true, outsideWords: true },
    });
  });
  it('genuine existing alias path shares monotonic teammate scope; old capture remains immutable', async () => {
    const session = fresh(),
      alias = fresh();
    const serial = await record(recorder(), session);
    aliasTurnLevel(session, alias);
    const before = captureCurrentTransfer(session, serial);
    const publicBefore = lastTurnLevelOf(session);
    markRunningTurn(alias, { teammate: [{ roomId: 'space-r', authorId: 'casey-peer' }] });
    const after = captureCurrentTransfer(session, serial);
    expect(after).toMatchObject({
      state: 'recorded-transfer',
      carry: {
        teammate: true,
        permissionCeiling: {
          asks: 'never',
          reach: 'everything',
          teammate: [{ roomId: 'space-r', authorId: 'casey-peer' }],
        },
      },
    });
    expect(before).toMatchObject({ carry: { permissionCeiling: null } });
    // Preserve legacy per-key level updates: capture union must not change public old alias.
    expect(lastTurnLevelOf(session)).toEqual(publicBefore);
    expect(lastTurnLevelOf(alias)?.teammate).toEqual([
      { roomId: 'space-r', authorId: 'casey-peer' },
    ]);
    expect(turnSerialOf(alias)).toBe(serial);
  });
  it('refuses absent, mismatched, old-turn, independent alias and fresh replacement records', async () => {
    expect(captureCurrentTransfer(fresh(), 1).state).toBe('unknown');
    const runtime = recorder(),
      session = fresh(),
      alias = fresh();
    const oldSerial = await record(runtime, session);
    expect(captureCurrentTransfer(session, oldSerial + 1).state).toBe('unknown');
    const serial = await record(runtime, session);
    expect(captureCurrentTransfer(session, oldSerial).state).toBe('unknown');
    await record(runtime, alias);
    aliasTurnLevel(session, alias);
    expect(captureCurrentTransfer(alias, serial).state).toBe('unknown');
    const freshSeat = fresh();
    carryTurnLevel(session, freshSeat);
    expect(captureCurrentTransfer(freshSeat, serial).state).toBe('unknown');
  });
  it.each(['refused', 'fresh-carry'] as const)(
    'distinct %s target cannot borrow capture, but legacy alias level and serial still update',
    async (kind) => {
      const runtime = recorder(),
        source = fresh(),
        target = fresh();
      const sourceSerial = await record(runtime, source);
      if (kind === 'refused') {
        await record(runtime, target);
        setTeammateSpaceGate(() => false);
        await expect(
          record(runtime, target, {
            permissionCeiling: {
              asks: 'never',
              reach: 'everything',
              teammate: [{ roomId: 'limited-space', authorId: 'casey-peer' }],
            },
          })
        ).rejects.toThrow('monthly limit');
        setTeammateSpaceGate(null);
      } else carryTurnLevel(source, target);
      const sourceLevel = lastTurnLevelOf(source);
      expect(captureCurrentTransfer(source, sourceSerial).state).toBe('recorded-transfer');
      aliasTurnLevel(source, target);
      expect(captureCurrentTransfer(target, sourceSerial).state).toBe('unknown');
      expect(captureCurrentTransfer(source, sourceSerial).state).toBe('unknown');
      expect(lastTurnLevelOf(target)).toEqual(sourceLevel);
      expect(turnSerialOf(target)).toBe(sourceSerial);
    }
  );
  it('actual applyTurnMarks refusal callback cannot borrow or reset the earlier producer serial', async () => {
    const runtime = recorder(),
      session = fresh(),
      alias = fresh();
    const serial = await record(runtime, session);
    aliasTurnLevel(session, alias);
    setTeammateSpaceGate(() => false);
    await expect(
      record(runtime, session, {
        permissionCeiling: {
          asks: 'never',
          reach: 'everything',
          teammate: [{ roomId: 'limited-space', authorId: 'casey-peer' }],
        },
      })
    ).rejects.toThrow('monthly limit');
    // Existing public serial did not advance: the real inner start was refused.
    expect(turnSerialOf(session)).toBe(serial);
    expect(captureCurrentTransfer(session, serial).state).toBe('unknown');
    expect(captureCurrentTransfer(alias, serial).state).toBe('unknown');
    setTeammateSpaceGate(null);
    const next = await record(runtime, session);
    expect(next).toBeGreaterThan(serial);
    expect(captureCurrentTransfer(session, next).state).toBe('recorded-transfer');
  });
  it('detaches captured recorded marks from later mutation of actual start options', async () => {
    const origins = [{ roomId: 'space-r', authorId: 'casey-peer' }];
    const session = fresh();
    const serial = await record(recorder(), session, {
      permissionCeiling: { asks: 'never', reach: 'everything', teammate: origins },
    });
    origins[0]!.authorId = 'later-mutation';
    origins.push({ roomId: 'other-room', authorId: 'other-peer' });
    expect(captureCurrentTransfer(session, serial)).toMatchObject({
      state: 'recorded-transfer',
      carry: { permissionCeiling: { teammate: [{ roomId: 'space-r', authorId: 'casey-peer' }] } },
    });
  });
  it('preserves independent legacy serial eviction even when a mark refresh keeps the level resident', async () => {
    const runtime = recorder(),
      session = fresh();
    const serial = await record(runtime, session);
    for (let n = 0; n < TURN_LEVEL_MEMORY - 1; n++) await record(runtime, fresh());
    markRunningTurn(session, { teammate: [{ roomId: 'space-r', authorId: 'casey-peer' }] });
    await record(runtime, fresh());
    // Existing serial map is NOT refreshed by markRunningTurn, so the counter record evicts.
    expect(turnSerialOf(session)).toBeUndefined();
    expect(lastTurnLevelOf(session)?.teammate).toEqual([
      { roomId: 'space-r', authorId: 'casey-peer' },
    ]);
    // Capture has its own coupled record serial; it never falls back to the counter map.
    expect(captureCurrentTransfer(session, serial).state).toBe('recorded-transfer');
    const next = await record(runtime, session);
    expect(next).toBeGreaterThan(serial);
    expect(captureCurrentTransfer(session, serial).state).toBe('unknown');
  });
  it('actual bounded recorder eviction refuses rather than manufacturing clean marks', async () => {
    const runtime = recorder(),
      old = fresh();
    const serial = await record(runtime, old);
    for (let n = 0; n <= TURN_LEVEL_MEMORY; n++) await record(runtime, fresh());
    expect(captureCurrentTransfer(old, serial).state).toBe('unknown');
  });
});
