/**
 * Opening a note saved while reading outside words marks the reader's turn (DOR-3969, spec §4.7):
 * the note carries those words on. A note saved in a clean turn leaves the reader clean.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import {
  markRunningTurnOutsider,
  marksOf,
  recordTurnLevels,
} from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { memoryDomain } from '../memory-capabilities.js';
import { resetMemoryProvider } from '../index.js';

let root: string;
let agentPath: string;
let registry: CapabilityRegistry;
let counter = 0;
const fresh = () => `memory-read-marks-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

const as = (sessionId: string): { identity: AgentIdentity; sessionId: string } => ({
  identity: { agentPath, displayName: 'Wren', createdAt: '2026-11-17T12:00:00.000Z' },
  sessionId,
});

describe('opening a note marks the turn when the note was saved while reading outside words', () => {
  beforeEach(async () => {
    resetMemoryProvider();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-memory-read-marks-'));
    agentPath = path.join(root, 'agents', 'wren');
    await mkdir(agentPath, { recursive: true });
    registry = composeRegistry([memoryDomain], {
      logger: noopLogger,
      memoryDeps: { roomLabelForSession: () => null },
    });
  });

  afterEach(async () => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    await rm(root, { recursive: true, force: true });
  });

  /** Save a note from a chat, marked first when `marked`; then open it from a fresh chat. */
  async function openAfterSaving(marked: boolean) {
    const writer = fresh();
    await ranAtFull(writer);
    if (marked) markRunningTurnOutsider(writer, agentPath);
    await registry.invoke(
      'memory.write',
      { action: 'add', note: 'garden', description: 'Garden plan', text: 'Plant beans in May.' },
      as(writer)
    );
    const reader = fresh();
    await ranAtFull(reader);
    await registry.invoke('memory.read', { note: 'garden' }, as(reader));
    return marksHold(marksOf(reader, agentPath));
  }

  it('marks the reader when a line was saved while reading outside words', async () => {
    expect(await openAfterSaving(true)).toBe(true);
  });

  it('leaves the reader clean when every line was saved in a clean turn', async () => {
    expect(await openAfterSaving(false)).toBe(false);
  });
});
