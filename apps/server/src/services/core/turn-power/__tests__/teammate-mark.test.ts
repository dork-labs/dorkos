/**
 * What a turn carrying a teammate's mark gets at the seam every turn passes (DOR-3036, DOR-3440):
 * every space's limit and its meter, and nothing lowered. Read through the real decorators the
 * registry wraps every runtime in.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  MessageOpts,
  TeammateOrigin,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { READ_ONLY_LEVEL, stricterLevel } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, markedBoundOf, marksOf, recordTurnLevels } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { meterTeammateTurns, setTeammateTurnCostSink } from '../teammate-turn-cost.js';
import { setTeammateSpaceGate, TEAMMATE_LIMIT_REFUSAL } from '../teammate-mark.js';
import { ceilingCarrying, parseStoredMarks } from '../turn-marks.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const PRIYA: TeammateOrigin = { roomId: 'space-a', authorId: 'priya' };
const SAM: TeammateOrigin = { roomId: 'space-b', authorId: 'sam' };
/** What a turn a teammate's chain reached is sent with: the record, which lowers nothing. */
const MARKED: TurnPermissionLevel = { asks: 'never', reach: 'everything', teammate: [PRIYA] };

/** A runtime of `type`, wrapped the way the registry wraps every runtime, recording what it got. */
function decorated(type = 'claude-code') {
  const got: Array<{ kind: string; opts: MessageOpts | undefined }> = [];
  const fake = {
    type,
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(_id: string, _content: string, opts?: MessageOpts) {
      got.push({ kind: 'send', opts });
      yield { type: 'session_status', data: { turnCostUsd: 0.1 } } as unknown as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
    async *executeCommandIntent(_id: string, _intent: string, opts?: MessageOpts) {
      got.push({ kind: 'command', opts });
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return { runtime: meterTeammateTurns(recordTurnLevels(fake, () => 'bypassPermissions')), got };
}

async function drain(stream: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of stream) {
    // drain
  }
}

let counter = 0;
const fresh = () => `teammate-mark-${(counter += 1)}`;

beforeEach(() => resetLiveOutsiderTurns());
afterEach(() => {
  setTeammateSpaceGate(null);
  setTeammateTurnCostSink(null);
  resetLiveOutsiderTurns();
});

describe('a turn carrying a teammate’s mark', () => {
  it('under the limit, reaches the runtime with its caller’s options unchanged', async () => {
    setTeammateSpaceGate(() => true);
    const { runtime, got } = decorated();
    const opts: MessageOpts = {
      permissionCeiling: MARKED,
      additionalDirectories: [{ path: '/repo', access: 'write' }],
      roomTurn: { roomId: 'local-room', authorId: 'bo', turnId: 't' },
    } as MessageOpts;
    await drain(runtime.sendMessage(fresh(), 'hi', opts));
    const sent = got[0]!.opts!;
    expect(sent.permissionCeiling).toBe(MARKED);
    expect(sent.additionalDirectories).toEqual(opts.additionalDirectories);
    expect(sent.roomTurn).toEqual(opts.roomTurn);
    expect(sent.unattended).toBeUndefined();
    expect(sent).not.toHaveProperty('teammate');
  });

  it('runs on every runtime, since there is no tier for one to hold', async () => {
    for (const type of ['codex', 'opencode', 'computer-local']) {
      const { runtime, got } = decorated(type);
      await drain(runtime.sendMessage(fresh(), 'hi', { permissionCeiling: MARKED }));
      expect(got, type).toHaveLength(1);
    }
  });

  it('is refused once any space in its chain is at its monthly limit', async () => {
    const { runtime, got } = decorated();
    setTeammateSpaceGate((roomId) => roomId !== 'space-b');
    await drain(runtime.sendMessage(fresh(), 'hi', { permissionCeiling: MARKED }));
    expect(got).toHaveLength(1);
    const twoSpaces = { ...MARKED, teammate: [PRIYA, SAM] };
    await expect(
      drain(runtime.sendMessage(fresh(), 'hi', { permissionCeiling: twoSpaces }))
    ).rejects.toThrow(TEAMMATE_LIMIT_REFUSAL);
    expect(got).toHaveLength(1);
  });

  it('is counted against every space in its chain, once each', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    const { runtime } = decorated();
    await drain(
      runtime.sendMessage(fresh(), 'hi', {
        permissionCeiling: { ...MARKED, teammate: [PRIYA, SAM, PRIYA] },
      })
    );
    expect(sink.mock.calls.map(([turn]) => turn.roomId).sort()).toEqual(['space-a', 'space-b']);
  });

  it('a command intent carries the marks it was sent with, as a turn does', async () => {
    const { runtime, got } = decorated();
    const opts: MessageOpts = { permissionCeiling: MARKED };
    await drain(runtime.executeCommandIntent(fresh(), 'compact', opts));
    expect(got[0]!.kind).toBe('command');
    expect(got[0]!.opts!.permissionCeiling).toBe(MARKED);
    expect(got[0]!.opts!.unattended).toBeUndefined();
    setTeammateSpaceGate(() => false);
    await expect(drain(runtime.executeCommandIntent(fresh(), 'compact', opts))).rejects.toThrow(
      TEAMMATE_LIMIT_REFUSAL
    );
    expect(got).toHaveLength(1);
  });

  it('a refused marked turn is still recorded as marked, so its failure is never the agent’s own', async () => {
    setTeammateSpaceGate(() => false);
    const { runtime } = decorated();
    const id = fresh();
    await expect(
      drain(runtime.sendMessage(id, 'hi', { permissionCeiling: MARKED }))
    ).rejects.toThrow(TEAMMATE_LIMIT_REFUSAL);
    expect(lastTurnLevelOf(id)?.teammate).toEqual([PRIYA]);
  });

  it('a command intent and a turn the runtime starts on its own are counted too', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    let wake: ((id: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
    const fake = {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage() {
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async *executeCommandIntent() {
        yield { type: 'text_delta', data: { text: 'compacted' } } as StreamEvent;
      },
      onRuntimeTurn: (listener: typeof wake) => {
        wake = listener;
        return () => undefined;
      },
    } as unknown as AgentRuntime;
    const runtime = meterTeammateTurns(recordTurnLevels(fake, () => 'bypassPermissions'));
    const id = fresh();
    await drain(runtime.executeCommandIntent(id, 'compact', { permissionCeiling: MARKED }));
    expect(sink).toHaveBeenCalledTimes(1);

    let own: AsyncIterable<StreamEvent> | undefined;
    runtime.onRuntimeTurn!((_id, events) => {
      own = events;
    });
    wake!(
      id,
      (async function* () {
        yield { type: 'text_delta', data: { text: 'woke' } } as StreamEvent;
      })()
    );
    for await (const _event of own!) {
      // drain
    }
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ roomId: 'space-a' }));
  });

  it('an unmarked turn is untouched', async () => {
    const { runtime, got } = decorated();
    const opts: MessageOpts = { permissionCeiling: { asks: 'when-risky', reach: 'edit' } };
    await drain(runtime.sendMessage(fresh(), 'hi', opts));
    expect(got[0]!.opts).toBe(opts);
  });
});

describe('a caller with no session (Codex, OpenCode over the external server)', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-teammate-mark-'));
    home = path.join(root, 'agents', 'scout');
    await mkdir(home, { recursive: true });
    registerTestHomes([home]);
  });

  afterEach(async () => {
    clearTestHomes();
    await rm(root, { recursive: true, force: true });
  });

  it('carries the teammate mark while one of its agent’s marked turns runs', async () => {
    const { runtime } = decorated();
    const turn = runtime.sendMessage(fresh(), 'hi', { permissionCeiling: MARKED, cwd: home });
    await turn.next();
    expect(marksOf(undefined, home)).toEqual({ teammate: [PRIYA] });
    // A spin-off it starts carries the teammate's mark too, and nothing that lowers it.
    expect(markedBoundOf(undefined, home)).toEqual(MARKED);
    await turn.return(undefined);
    expect(marksOf(undefined, home)).toEqual({});
  });
});

describe('teammate origins travel with the level', () => {
  it('are kept, once each, when two levels meet', () => {
    const a: TurnPermissionLevel = { ...READ_ONLY_LEVEL, teammate: [PRIYA] };
    const b: TurnPermissionLevel = { asks: 'when-risky', reach: 'edit', teammate: [SAM, PRIYA] };
    expect(stricterLevel(a, b).teammate).toEqual([PRIYA, SAM]);
    expect(stricterLevel(b, { asks: 'never', reach: 'everything' }).teammate).toEqual([SAM, PRIYA]);
  });

  it('ride a ceiling built for words written under them, and read back from storage', () => {
    // No other mark follows words anywhere (DOR-3440).
    expect(ceilingCarrying({ outsider: true })).toBeUndefined();
    expect(ceilingCarrying({ teammate: [PRIYA] })).toEqual(MARKED);
    expect(ceilingCarrying({ outsider: true, teammate: [PRIYA] })).toEqual(MARKED);
    expect(ceilingCarrying({})).toBeUndefined();
    expect(parseStoredMarks(JSON.stringify({ teammate: [PRIYA], junk: 1 }))).toEqual({
      teammate: [PRIYA],
    });
    expect(parseStoredMarks(null)).toEqual({});
    // Unreadable is not unmarked.
    expect(parseStoredMarks('{not json')).toEqual({ outsider: true });
  });
});
