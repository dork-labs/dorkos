/**
 * Turn marks that outlive the process (DOR-3036): a room post's marks on its row, an external
 * caller's marks on the schedules it writes, and a queued extension message's mark after restart.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { entryMarksOf, noteEntryLevel, setEntryMarksStore } from '../turn-levels.js';
import { createEntryMarksStore } from '../../../rooms/limits/entry-marks-store.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import { teammateOf } from '../../../rooms/limits/space-teammates.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { launchCeiling } from '../../../session/message-dispatcher/state.js';
import { extensionClientId } from '../../../extensions/agent-send/extension-client-id.js';
import { registerTaskTools } from '../../external-mcp/task-tools.js';
import { TaskStore } from '../../../tasks/task-store.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { ToolRegistrar } from '../../mcp-tool-gate.js';

const PRIYA = { roomId: 'space-room', authorId: 'priya' };

describe('a room post’s marks, after a restart', () => {
  let harness: RoomHarness;
  let channel: RoomWithRoster;
  let bo: string;

  beforeEach(() => {
    harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
    });
    channel = harness.service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: ['/agents/bo'] },
      harness.human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    setEntryMarksStore(createEntryMarksStore(harness.db));
  });

  afterEach(() => setEntryMarksStore(null));

  /** An agent post whose level this process never kept, as after a restart. */
  function postByBo(): { id: string; authorId: string } {
    return harness.service.post(channel.id, { authorId: bo, text: 'checking the build' });
  }

  it('keeps a post’s marks on its row when its level is kept', () => {
    const entry = postByBo();
    noteEntryLevel(entry.id, { ...READ_ONLY_LEVEL, outsider: true, teammate: [PRIYA] }, channel.id);
    const store = createEntryMarksStore(harness.db);
    expect(store.read(channel.id, entry.id)).toEqual({ outsider: true, teammate: [PRIYA] });
  });

  it('reads a teammate-marked post as marked once its level is gone, so the answering turn is fenced', () => {
    const entry = postByBo();
    createEntryMarksStore(harness.db).write(channel.id, entry.id, {
      outsider: true,
      teammate: [PRIYA],
    });

    expect(entryMarksOf(entry.id, channel.id)).toEqual({ outsider: true, teammate: [PRIYA] });
    expect(teammateOf(harness.authors, [entry], false, channel.id)).toEqual({ teammate: true });
    expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
      permissionCeiling: ['runtime-default', { ...READ_ONLY_LEVEL, teammate: [PRIYA] }],
    });
  });

  it('in a space’s copy, reads a post nobody knows the marks of as a teammate’s chain', () => {
    const entry = postByBo();
    expect(entryMarksOf(entry.id, channel.id)).toBeNull();
    expect(teammateOf(harness.authors, [entry], true, channel.id)).toEqual({ teammate: true });
    expect(ceilingForEntry(harness.authors, entry, true, channel.id)).toEqual({
      permissionCeiling: [
        'runtime-default',
        { ...READ_ONLY_LEVEL, teammate: [{ roomId: channel.id, authorId: bo }] },
      ],
    });
    // Outside a space nothing changes: the runtime default, as for any unkept agent post.
    expect(teammateOf(harness.authors, [entry], false, channel.id)).toEqual({});
    expect(ceilingForEntry(harness.authors, entry, false, channel.id)).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('a known unmarked post stays unmarked', () => {
    const entry = postByBo();
    createEntryMarksStore(harness.db).write(channel.id, entry.id, {});
    expect(teammateOf(harness.authors, [entry], true, channel.id)).toEqual({});
  });
});

describe('a queued extension message, launched after a restart', () => {
  it('keeps the outsider mark: an app’s code is not the owner’s words', () => {
    expect(launchCeiling(extensionClientId('social-manager'), 'msg-1', undefined)).toBe(
      'runtime-default'
    );
    expect(launchCeiling('person-window-1', 'msg-2', undefined)).toBeUndefined();
  });
});

describe('the external /mcp task tools', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-external-marks-'));

  /** The `tasks_create` handler the external server registers for this caller. */
  function externalCreate(store: TaskStore, identity?: { agentPath: string }) {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: { text: string }[] }>>();
    const registrar = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        handlers.set(name, handler);
      },
    } as unknown as ToolRegistrar;
    registerTaskTools(
      registrar,
      {
        transcriptReader: {},
        defaultCwd: home,
        dorkHome: home,
        taskStore: store,
      } as unknown as McpToolDeps,
      identity as never
    );
    return handlers.get('tasks_create')!;
  }

  it('mark a schedule from a caller DorkOS cannot identify, so its card says so', async () => {
    const store = new TaskStore(createTestDb());
    const reply = await externalCreate(store)({
      name: 'External nightly',
      prompt: 'check the build',
      cron: '0 3 * * *',
      target: 'global',
      reason: 'asked from outside',
    });
    const { schedule } = JSON.parse(reply.content[0]!.text) as { schedule: { id: string } };
    expect(store.getTask(schedule.id)).toMatchObject({
      status: 'pending_approval',
      originMarks: { outsider: true },
    });
  });

  it('read an identified agent through its running turns, and mark nothing when none is marked', async () => {
    const store = new TaskStore(createTestDb());
    const reply = await externalCreate(store, { agentPath: '/agents/nobody-running' })({
      name: 'Agent nightly',
      prompt: 'check the build',
      cron: '0 4 * * *',
      target: 'global',
      reason: 'the agent asked',
    });
    const { schedule } = JSON.parse(reply.content[0]!.text) as { schedule: { id: string } };
    expect(store.getTask(schedule.id)?.originMarks).toBeNull();
  });
});
