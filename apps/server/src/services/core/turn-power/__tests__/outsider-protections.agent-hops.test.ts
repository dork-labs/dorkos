/**
 * A turn a Wi-Fi sign-in's hold bound is recorded as one that read words DorkOS can't vouch for: a
 * note it saves to the agent's memory says so in the stamp DorkOS writes, and it cannot rewrite a
 * note the operator gave. Through the real seam that records turn levels and the real
 * `memory_write` capability over a real memory file.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { noopLogger } from '@dorkos/shared/logger';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { composeRegistry, type CapabilityRegistry } from '../../capabilities/index.js';
import { MEMORY_OUTSIDER_HELD_MESSAGE, memoryDomain } from '../../../memory/memory-capabilities.js';
import { noteChosenTurn, resetChosenTurns } from '../full-autonomy.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const OUTSIDER_STAMP =
  /\(noted in a direct chat, while reading words DorkOS can't vouch for, \d{4}-\d{2}-\d{2}\)$/;
const OPERATOR_STAMP = /\(noted in a direct chat, \d{4}-\d{2}-\d{2}\)$/;

/** A runtime whose turns stay open until released, wrapped the way the registry wraps it. */
function seam(stored: Record<string, string>): {
  runtime: AgentRuntime;
  sent: Map<string, MessageOpts | undefined>;
} {
  const sent = new Map<string, MessageOpts | undefined>();
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(sessionId: string, _content: string, opts?: MessageOpts) {
      sent.set(sessionId, opts);
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return { runtime: recordTurnLevels(runtime, (id) => stored[id] ?? null), sent };
}

async function run(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

let counter = 0;
const fresh = (name: string) => `${name}-hop-${(counter += 1)}`;

let root: string;
let boPath: string;
let memory: CapabilityRegistry;

/** Bo saves a note, from a session or (the external server) from no session. */
function boWrites(input: Record<string, string>, sessionId?: string) {
  return memory.invoke('memory.write', input, {
    identity: { agentPath: boPath, displayName: 'Bo', createdAt: '2026-10-10T00:00:00.000Z' },
    ...(sessionId !== undefined ? { sessionId } : {}),
  }) as Promise<{ saved: boolean; code?: string; error?: string }>;
}

async function boMemory(): Promise<string> {
  return readFile(path.join(boPath, '.dork', 'MEMORY.md'), 'utf8');
}

/** The last note in Bo's memory. */
async function lastNote(): Promise<string> {
  const notes = (await boMemory()).trimEnd().split('\n');
  return notes[notes.length - 1]!;
}

beforeEach(async () => {
  resetMemoryProvider();
  resetLiveOutsiderTurns();
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-outsider-hops-'));
  boPath = path.join(root, 'agents', 'bo');
  await mkdir(boPath, { recursive: true });
  registerTestHomes([boPath]);
  memory = composeRegistry([memoryDomain], {
    logger: noopLogger,
    memoryDeps: { roomLabelForSession: () => null },
  });
});

afterEach(async () => {
  clearTestHomes();
  resetLiveOutsiderTurns();
  await rm(root, { recursive: true, force: true });
});

describe('memory written in a turn that read an outsider’s words', () => {
  async function seedOperatorNote(): Promise<void> {
    await mkdir(path.join(boPath, '.dork'), { recursive: true });
    await writeFile(
      path.join(boPath, '.dork', 'MEMORY.md'),
      '## Notes\n\n- deploys need the operator’s OK (noted in a direct chat, 2026-10-01)\n',
      'utf8'
    );
  }

  it('is stamped from a held turn, and plain from the owner’s', async () => {
    const { runtime } = seam({});
    const held = fresh('bo');
    const own = fresh('bo');
    await run(runtime, held, { permissionCeiling: 'runtime-default' });
    await run(runtime, own);
    await boWrites({ action: 'add', text: 'the deploy key is in the vault' }, held);
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
    await boWrites({ action: 'add', text: 'ship on Fridays' }, own);
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
  });

  it('cannot rewrite or remove a note, so the operator’s stamp never covers a stranger’s words', async () => {
    await seedOperatorNote();
    const { runtime } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo, { permissionCeiling: 'runtime-default' });

    const replaced = await boWrites(
      { action: 'replace', old_text: 'deploys need the operator’s OK', text: 'deploy freely' },
      bo
    );
    const removed = await boWrites({ action: 'remove', old_text: 'deploys need' }, bo);
    expect(replaced).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(replaced.error).toBe(MEMORY_OUTSIDER_HELD_MESSAGE);
    expect(removed).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(await boMemory()).toContain('deploys need the operator’s OK');
  });

  it('cannot rewrite or remove a note even in a chat set to Full: a person’s limit (DOR-3412)', async () => {
    await seedOperatorNote();
    const { runtime } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo, { permissionCeiling: 'runtime-default' });
    noteChosenTurn(bo, { asks: 'never', reach: 'everything' } as never, false);
    try {
      const replaced = await boWrites(
        { action: 'replace', old_text: 'deploys need the operator’s OK', text: 'deploy freely' },
        bo
      );
      const removed = await boWrites({ action: 'remove', old_text: 'deploys need' }, bo);
      expect(replaced).toMatchObject({ saved: false, code: 'outsider-held' });
      expect(removed).toMatchObject({ saved: false, code: 'outsider-held' });
      expect(await boMemory()).toContain('deploys need the operator’s OK');
    } finally {
      resetChosenTurns();
    }
  });

  it('is still editable from a turn the owner started', async () => {
    await seedOperatorNote();
    const { runtime } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo);
    expect((await boWrites({ action: 'remove', old_text: 'deploys need' }, bo)).saved).toBe(true);
  });

  it('from a caller with no session (Codex, OpenCode), is marked while its agent reads one', async () => {
    const turn = seam({}).runtime.sendMessage(fresh('codex'), 'hi', {
      cwd: boPath,
      permissionCeiling: 'runtime-default',
    });
    // The turn is running: its stream has started and not finished.
    await turn.next();
    await boWrites({ action: 'add', text: 'the vendor is Acme' });
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);

    // Finished: the next note from that agent is the operator's again.
    await turn.return(undefined);
    await boWrites({ action: 'add', text: 'the vendor is Acme, really' });
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
  });

  // Red when: the seam stops counting turns the agent starts on its own. A
  // Codex wake after background work is no `sendMessage`, and Codex has no
  // session to name, so the count is the only thing that can mark its notes.
  it('from a Codex wake after background work the marked turn left running', async () => {
    let wake: ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
    const codex = {
      type: 'codex',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage() {
        yield { type: 'done', data: {} } as StreamEvent;
      },
      onRuntimeTurn: (listener: typeof wake) => {
        wake = listener;
        return () => undefined;
      },
    } as unknown as AgentRuntime;
    const recorded = recordTurnLevels(codex, () => null);
    const session = fresh('codex');
    await run(recorded, session, { cwd: boPath, permissionCeiling: 'runtime-default' });

    let seen: AsyncIterable<StreamEvent> | undefined;
    recorded.onRuntimeTurn!((_id, events) => {
      seen = events;
    });
    wake!(
      session,
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    const woken = seen![Symbol.asyncIterator]();
    await woken.next();
    await boWrites({ action: 'add', text: 'the build finished green' });
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
    await woken.return?.(undefined);
  });

  it("is not marked for another agent's outsider turn", async () => {
    const elsewhere = path.join(root, 'agents', 'cy');
    registerTestHomes([boPath, elsewhere]);
    const turn = seam({}).runtime.sendMessage(fresh('cy'), 'hi', {
      cwd: elsewhere,
      permissionCeiling: 'runtime-default',
    });
    await turn.next();
    await boWrites({ action: 'add', text: 'a plain note' });
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
    await turn.return(undefined);
  });
});
