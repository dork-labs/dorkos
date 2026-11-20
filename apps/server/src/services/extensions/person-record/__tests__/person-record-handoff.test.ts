/**
 * Work a person's request hands to an agent never counts as the person
 * (DOR-4301, Security's Should 1): an agent started with `ctx.agent.send` or
 * `ctx.sessions.start` during the request, and an agent tool's handler run
 * while it is open, record nothing, even before the response ends.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentSendService } from '../../agent-send/agent-send.js';
import { setAgentSendService } from '../../agent-send/agent-send.js';
import { setStartWorkService, type StartWorkService } from '../../start-work.js';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import {
  PersonRecordStore,
  outsidePersonRequest,
  runInPersonRequest,
  setPersonRecordStore,
} from '../person-record.js';

const APP = 'made-up-desk';
let dorkHome: string;

beforeEach(async () => {
  dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dor4301-handoff-'));
  setPersonRecordStore(new PersonRecordStore(createTestDb()));
});

afterEach(async () => {
  setPersonRecordStore(null);
  setAgentSendService(undefined);
  setStartWorkService(undefined);
  await fs.rm(dorkHome, { recursive: true, force: true });
});

function buildCtx() {
  return createDataProviderContext({ extensionId: APP, extensionDir: '/fake/app', dorkHome }).ctx;
}

/** Whether a record made here would count. */
function tryRecord(ctx: ReturnType<typeof buildCtx>, text: string): Promise<boolean> {
  return ctx.personRecord!.record(text).then(
    () => true,
    () => false
  );
}

describe('work handed off from a person’s request', () => {
  it('records nothing from an agent that ctx.agent.send started', async () => {
    const ctx = buildCtx();
    let fromAgent: Promise<boolean> = Promise.resolve(true);
    setAgentSendService({
      // A send that starts the agent right away, as a dispatch that opens a chat does.
      send: async () => {
        fromAgent = tryRecord(ctx, 'the agent’s words');
        return { id: 'm1', status: 'started' };
      },
      subscribe: () => () => {},
    } as unknown as AgentSendService);

    const fromPerson = await runInPersonRequest(APP, async (end) => {
      try {
        await ctx.agent.send({ to: 'made-up-agent', text: 'hello', idempotencyKey: 'k1' });
        return await tryRecord(ctx, 'the person’s words');
      } finally {
        end();
      }
    });
    expect(fromPerson).toBe(true);
    expect(await fromAgent).toBe(false);
  });

  it('records nothing from a chat that ctx.sessions.start opened', async () => {
    const ctx = buildCtx();
    let fromChat: Promise<boolean> = Promise.resolve(true);
    setStartWorkService({
      start: async () => {
        fromChat = tryRecord(ctx, 'the chat’s words');
        return { sessionId: 's1' };
      },
    } as unknown as StartWorkService);

    await runInPersonRequest(APP, async (end) => {
      try {
        await ctx.sessions.start({} as never);
      } finally {
        end();
      }
    });
    expect(await fromChat).toBe(false);
  });

  it('records nothing from code run outside the person’s request while it is open', async () => {
    const ctx = buildCtx();
    const results = await runInPersonRequest(APP, async (end) => {
      try {
        const outside = await outsidePersonRequest(() => tryRecord(ctx, 'outside'));
        const inside = await tryRecord(ctx, 'inside');
        return { outside, inside };
      } finally {
        end();
      }
    });
    expect(results).toEqual({ outside: false, inside: true });
  });
});
