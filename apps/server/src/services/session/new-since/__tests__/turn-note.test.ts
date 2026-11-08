import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import type { StreamEvent } from '@dorkos/shared/types';
import { triggerTurn, type TriggerTurnOpts } from '../../trigger-turn.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import * as identity from '../../../core/agent-identity/index.js';
import * as seen from '../seen-versions.js';

vi.mock('../../context-assembler.js', () => ({ assembleAdditionalContext: async () => [] }));
const HOME = '/made-up/ana';
let dir: string;
let store: seen.SeenVersions;
const sessions: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'new-since-turn-'));
  await mkdir(path.join(dir, 'state'));
  await writeFile(path.join(dir, 'state/agent-seen-versions.json'), '{"ana":"0.1.0"}');
  store = new seen.SeenVersions(dir, {
    version: '0.2.0',
    dev: false,
    notes: [
      {
        version: '0.2.0',
        name: 'New feature',
        can: 'read facts.',
        covers: [],
        areas: [],
        gate: 'information only',
      },
    ],
  });
  vi.spyOn(seen, 'seenVersions').mockReturnValue(store);
  identity.setAgentHomeRegistry({
    isRegisteredHome: (home) => home === HOME,
    listRegisteredHomes: () => [HOME],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  vi.spyOn(identity, 'readHomeManifest').mockResolvedValue({ id: 'ana' } as never);
});
afterEach(async () => {
  for (const id of sessions.splice(0)) disposeProjector(id);
  identity.setAgentHomeRegistry(undefined);
  vi.restoreAllMocks();
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

async function turn(
  mode: 'run' | 'hold' | 'throw' | 'refuse' | 'fail-after-output' = 'run',
  extra: Partial<TriggerTurnOpts> = {}
): Promise<AdditionalContext> {
  const id = randomUUID();
  sessions.push(id);
  let bag: AdditionalContext = [];
  let settled!: () => void;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const capabilities = new FakeAgentRuntime().getCapabilities();
  const result = await triggerTurn({
    sessionId: id,
    clientId: 'window',
    content: 'hello',
    cwd: HOME,
    projector: getOrCreateProjector(id),
    onSettled: settled,
    ...extra,
    deps: {
      acquireLock: () => true,
      releaseLock: () => {},
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      interruptQuery: async () => ({ outcome: 'not-running', runtime: 'fake' }),
      getCapabilities: () => capabilities,
      answersDispatchHold: mode === 'hold',
      sendMessage: (_id, _content, opts) => {
        bag = opts?.additionalContext ?? [];
        if (mode === 'throw') throw new Error('launch failed');
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (mode === 'hold') {
            opts!.dispatchHold!.hold({ reason: 'background-work' } as never);
            return;
          }
          if (mode === 'refuse')
            yield {
              type: 'error',
              data: { code: 'turn_not_started', reason: 'warm-ceiling', message: 'busy' },
            } as StreamEvent;
          else yield { type: 'text_delta', data: { text: 'hello' } };
          if (mode === 'fail-after-output') throw new Error('failed during work');
          yield { type: 'done', data: {} } as StreamEvent;
        })();
      },
    },
  });
  if (result.accepted) await done;
  return bag;
}
const notes = (bag: AdditionalContext) =>
  bag.filter((entry) => entry.kind === 'new_since_last_run');

describe('new since in ordinary turns', () => {
  it('delivers once per agent across distinct sessions, including room dispatches', async () => {
    expect(notes(await turn('run', { forAgent: HOME, cwd: '/made-up/desk' }))).toHaveLength(1);
    expect(notes(await turn())).toHaveLength(0);
    expect(store.takeNewSince('ana')).toBeNull();
  });

  it('does not repeat a note the agent read before a later turn error', async () => {
    expect(notes(await turn('fail-after-output'))).toHaveLength(1);
    expect(notes(await turn())).toHaveLength(0);
  });

  it.each(['hold', 'throw', 'refuse'] as const)('hands the note back after %s', async (mode) => {
    if (mode === 'throw') await expect(turn(mode)).rejects.toThrow('launch failed');
    else expect(notes(await turn(mode))).toHaveLength(1);
    expect(notes(await turn())).toHaveLength(1);
    expect(notes(await turn())).toHaveLength(0);
  });

  it.each([{ clientId: 'todos' }, { unattended: true }, { cwd: '/made-up/folder' }])(
    'does not consume notes for an ineligible turn: %j',
    async (extra) => {
      expect(notes(await turn('run', extra))).toHaveLength(0);
      expect(notes(await turn())).toHaveLength(1);
    }
  );
});
