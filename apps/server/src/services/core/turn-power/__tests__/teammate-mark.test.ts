/**
 * What a turn carrying a teammate's mark gets at the seam every turn passes (DOR-3036): the
 * teammate tier, every space's limit, and only a runtime that can hold it. Read through the real
 * decorators the registry wraps every runtime in.
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
import { marksOf, recordTurnLevels } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { meterTeammateTurns, setTeammateTurnCostSink } from '../teammate-turn-cost.js';
import {
  setTeammateSpaceGate,
  TEAMMATE_LIMIT_REFUSAL,
  teammateRuntimeRefusal,
} from '../teammate-mark.js';
import { ceilingCarrying, parseStoredMarks } from '../turn-marks.js';
import { TEAMMATE_TIER_DENIAL, teammateTierRefusal } from '../teammate-tier.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const PRIYA: TeammateOrigin = { roomId: 'space-a', authorId: 'priya' };
const SAM: TeammateOrigin = { roomId: 'space-b', authorId: 'sam' };
/** What a chat one hop on from a teammate's turn is sent with: the sender's level, as stored. */
const MARKED: TurnPermissionLevel = { ...READ_ONLY_LEVEL, outsider: true, teammate: [PRIYA] };

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
  it('is held to the teammate tier: nobody asked, no folders, read access, no room', async () => {
    const { runtime, got } = decorated();
    await drain(
      runtime.sendMessage(fresh(), 'hi', {
        permissionCeiling: MARKED,
        additionalDirectories: [{ path: '/repo', access: 'write' }],
      } as MessageOpts)
    );
    const opts = got[0]!.opts!;
    expect(opts).toMatchObject({ teammate: true, unattended: true });
    expect(opts.additionalDirectories).toBeUndefined();
    expect(opts.permissionCeiling).toEqual([MARKED, READ_ONLY_LEVEL]);
    expect(opts.roomTurn).toBeUndefined();
  });

  it('answering a room, is fenced to that room and reads its words as words only', async () => {
    const { runtime, got } = decorated();
    await drain(
      runtime.sendMessage(fresh(), 'hi', {
        permissionCeiling: MARKED,
        roomTurn: { roomId: 'local-room', authorId: 'bo', turnId: 't' },
      })
    );
    expect(got[0]!.opts!.roomTurn).toMatchObject({
      roomId: 'local-room',
      teammate: true,
      untrustedText: true,
    });
  });

  it('is refused on a runtime that cannot hold the tier, before it runs', async () => {
    for (const type of ['codex', 'opencode', 'computer-local']) {
      const { runtime, got } = decorated(type);
      await expect(
        drain(runtime.sendMessage(fresh(), 'hi', { permissionCeiling: MARKED }))
      ).rejects.toThrow(teammateRuntimeRefusal(type));
      expect(got).toHaveLength(0);
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
    await drain(runtime.executeCommandIntent(fresh(), 'compact', { permissionCeiling: MARKED }));
    expect(got[0]).toMatchObject({ kind: 'command', opts: { teammate: true, unattended: true } });
    const codex = decorated('codex');
    await expect(
      drain(codex.runtime.executeCommandIntent(fresh(), 'compact', { permissionCeiling: MARKED }))
    ).rejects.toThrow(teammateRuntimeRefusal('codex'));
  });

  it('outside a room, reaches no room: it replies in its own chat only', () => {
    for (const name of ['post_to_room', 'read_room_history', 'get_room']) {
      expect(
        teammateTierRefusal({ roomId: null }, { source: 'dorkos', name, input: { roomId: 'r' } })
      ).toBe(TEAMMATE_TIER_DENIAL);
    }
    expect(
      teammateTierRefusal({ roomId: null }, { source: 'built-in', name: 'TodoWrite', input: {} })
    ).toBeNull();
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
    expect(marksOf(undefined, home)).toEqual({ outsider: true, teammate: [PRIYA] });
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
    expect(ceilingCarrying({ outsider: true })).toBe('runtime-default');
    expect(ceilingCarrying({ outsider: true, teammate: [PRIYA] })).toEqual([
      'runtime-default',
      { ...READ_ONLY_LEVEL, teammate: [PRIYA] },
    ]);
    expect(ceilingCarrying({})).toBeUndefined();
    expect(parseStoredMarks(JSON.stringify({ teammate: [PRIYA], junk: 1 }))).toEqual({
      teammate: [PRIYA],
    });
    expect(parseStoredMarks(null)).toEqual({});
    // Unreadable is not unmarked.
    expect(parseStoredMarks('{not json')).toEqual({ outsider: true });
  });
});
