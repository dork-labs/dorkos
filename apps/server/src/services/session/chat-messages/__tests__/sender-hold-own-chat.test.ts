/**
 * A chat message carries its sender's hold only when the SENDING chat holds outside words
 * (DOR-4693, Security's ruling `dor4693-carried-outsider-spread-ruling`). Before, a sending chat
 * this process had no level for was read through its whole agent, so one marked chat stamped the
 * hold on every message any of that agent's chats sent, and each held message marked the turn it
 * started: the hold spread through every agent on the machine.
 *
 * Driven through the real level seam, the real live-turn count and a real chat record store.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sessionMetadata } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { noteOwnersCleanSend } from '../../../core/turn-power/held-chat-mark.js';
import {
  carryBridgedSender,
  setContinuationHoldDb,
} from '../../../core/turn-power/continuation-hold.js';
import { linkSessionId, resetSessionKeys } from '../../resolution/session-key-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { parseCarriedHold, senderCeilingJson } from '../chat-message-ceiling.js';
import { outsiderStartCeiling } from '../../../runtimes/claude-code/mcp-tools/session-start-facts.js';

let root: string;
let home: string;
let db: ReturnType<typeof createTestDb>;
let counter = 0;
const fresh = () => `sender-hold-${(counter += 1)}`;

/** A runtime through the level seam; every chat set to Full. */
function recorded(): AgentRuntime {
  return recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
}

/** A chat the store knows, with a clean record: the shape a chat has after a restart. */
function knownClean(sessionId: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: 'claude-code', createdAt: new Date().toISOString() })
    .run();
}

/** Whether a message this chat sends now carries a hold, as the live service stamps it. */
function sendCarriesHold(sessionId: string): boolean {
  return parseCarriedHold(
    senderCeilingJson({ turnLevelOf: lastTurnLevelOf }, { sessionId, agentPath: home })
  );
}

beforeEach(async () => {
  resetLiveOutsiderTurns();
  resetSessionKeys();
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-sender-hold-'));
  home = path.join(root, 'agents', 'lane');
  await mkdir(home, { recursive: true });
  registerTestHomes([home]);
  db = createTestDb();
  setContinuationHoldDb(db);
});

afterEach(async () => {
  setContinuationHoldDb(undefined);
  clearTestHomes();
  resetSessionKeys();
  await rm(root, { recursive: true, force: true });
});

describe('the hold a message carries comes from its own chat (DOR-4693)', () => {
  it('leaves a clean chat’s message unheld while another chat of the same agent is marked', async () => {
    const marked = fresh();
    const clean = fresh();
    knownClean(clean);
    const running = recorded().sendMessage(marked, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    });
    await running.next();
    try {
      expect(sendCarriesHold(marked)).toBe(true);
      expect(sendCarriesHold(clean)).toBe(false);
    } finally {
      await running.return(undefined);
    }
  });

  // Security: the start path is a raise path, so it keeps the same rule as the send path.
  it('starts a session with the hold only from the chat that holds it', async () => {
    const marked = fresh();
    const clean = fresh();
    knownClean(clean);
    const running = recorded().sendMessage(marked, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    });
    await running.next();
    try {
      const start = (sessionId: string) =>
        outsiderStartCeiling({ agentPath: home, chat: { sessionId, chosenFull: false } });
      expect(start(marked).carriedMarks).toEqual({ outsider: true });
      expect(start(clean).carriedMarks).toBeUndefined();
      // A caller that names no chat is still read through its agent.
      expect(outsiderStartCeiling({ agentPath: home, chat: null }).carriedMarks).toEqual({
        outsider: true,
      });
    } finally {
      await running.return(undefined);
    }
  });

  it('holds a message from a chat nothing knows: unknown is not clean', () => {
    expect(sendCarriesHold(fresh())).toBe(true);
  });

  it('keeps a renamed chat’s own mark under its new id', async () => {
    const born = fresh();
    const renamed = fresh();
    const running = recorded().sendMessage(born, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    });
    await running.next();
    try {
      linkSessionId(born, renamed);
      expect(sendCarriesHold(renamed)).toBe(true);
    } finally {
      await running.return(undefined);
    }
  });

  it('still holds a chat after its marked turn ends, from its own durable record', async () => {
    const chat = fresh();
    for await (const _event of recorded().sendMessage(chat, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    })) {
      // drain: the turn ends, and only the chat's record is left to say it held words
    }
    expect(sendCarriesHold(chat)).toBe(true);
  });

  it('ignores a stale stranger record on a chat no binding started', () => {
    const chat = fresh();
    db.insert(sessionMetadata)
      .values({
        sessionId: chat,
        runtime: 'claude-code',
        createdAt: new Date().toISOString(),
        launchOrigin: 'agent-launch',
        bridgedSender: 'stranger',
      })
      .run();
    expect(sendCarriesHold(chat)).toBe(false);
  });

  it('holds a Telegram or Slack chat whose bridge carried a stranger’s words', () => {
    const chat = fresh();
    db.insert(sessionMetadata)
      .values({
        sessionId: chat,
        runtime: 'claude-code',
        createdAt: new Date().toISOString(),
        launchOrigin: 'relay-binding',
        bridgedSender: 'stranger',
      })
      .run();
    expect(sendCarriesHold(chat)).toBe(true);
  });

  it('records a marked turn’s hold, but no bridge, on a chat no binding started', async () => {
    const chat = fresh();
    db.insert(sessionMetadata)
      .values({
        sessionId: chat,
        runtime: 'claude-code',
        createdAt: new Date().toISOString(),
        launchOrigin: 'interactive',
      })
      .run();
    for await (const _event of recorded().sendMessage(chat, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    })) {
      // drain
    }
    const row = db
      .select({ held: sessionMetadata.lastTurnHeld, sender: sessionMetadata.bridgedSender })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, chat))
      .get();
    expect(row).toEqual({ held: true, sender: null });
  });

  it('keeps a bridged chat’s stranger record when it moves to a new id', () => {
    const born = fresh();
    const renamed = fresh();
    db.insert(sessionMetadata)
      .values({
        sessionId: born,
        runtime: 'claude-code',
        createdAt: new Date().toISOString(),
        launchOrigin: 'relay-binding',
        bridgedSender: 'stranger',
      })
      .run();
    linkSessionId(born, renamed);
    carryBridgedSender(born, renamed);
    const moved = db
      .select({ sender: sessionMetadata.bridgedSender })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, renamed))
      .get();
    expect(moved?.sender).toBe('stranger');
    expect(sendCarriesHold(renamed)).toBe(true);
  });

  // Security: no bulk clear. Only the owner's own clean send clears it (DOR-4515): a later turn
  // nobody newly asked for re-reads the same words, so it keeps the hold.
  it('keeps holding through a later turn that is not the owner’s own clean send', async () => {
    const chat = fresh();
    for await (const _event of recorded().sendMessage(chat, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    })) {
      // drain
    }
    for await (const _event of recorded().sendMessage(chat, 'a scheduled run', {
      cwd: home,
      unattended: true,
    })) {
      // drain
    }
    expect(sendCarriesHold(chat)).toBe(true);
  });

  it('stops holding once the owner’s own clean send starts', async () => {
    const chat = fresh();
    for await (const _event of recorded().sendMessage(chat, 'a stranger’s words', {
      cwd: home,
      permissionCeiling: 'runtime-default',
    })) {
      // drain
    }
    noteOwnersCleanSend('owner-send-1', chat);
    for await (const _event of recorded().sendMessage(chat, 'the owner', {
      cwd: home,
      turnStarter: 'person',
      messageId: 'owner-send-1',
    })) {
      // drain
    }
    expect(sendCarriesHold(chat)).toBe(false);
  });
});
