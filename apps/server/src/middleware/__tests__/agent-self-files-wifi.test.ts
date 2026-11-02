/**
 * From Wi-Fi, a person cannot rewrite an agent's instructions (DOR-3037):
 * SOUL.md, NOPE.md, MEMORY.md, HEARTBEAT.md, the persona and its switch, the
 * personality dials and the convention switches. Every turn reads them at the
 * agent's own level, so those words would outlive the Wi-Fi cap. Every other
 * field passes, and so does every field at this computer. A turn that read
 * outsider words is refused the same fields through `update_agent`.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import { refuseAgentSelfFilesFromWifi, WIFI_AGENT_FILES_REFUSAL } from '../agent-execution-gate.js';
import { refuseOutsiderAgentFiles } from '../../services/core/operator/agent-file-inputs.js';
import { recordTurnLevels } from '../../services/core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../services/core/turn-power/full-autonomy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { CapabilityToolError } from '../../services/core/capabilities/mcp-envelope.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const target = swappableServer();

/** A route behind the guard, reached from Wi-Fi when the request says so. */
function app() {
  const routes = new Hono<ApiEnv>();
  routes.patch('/current', refuseAgentSelfFilesFromWifi, (c) => c.json({ ok: true }));
  return target.mount(
    honoGroupListener(
      { path: '/api/agents', routes },
      {
        before: async (c, next) => {
          if (c.req.header('x-test-via') === 'wifi') markIngress(c.env.incoming, 'wifi');
          c.set('user', { userId: 'owner', credential: 'cookie' });
          await next();
        },
      }
    )
  );
}

describe('PATCH /api/agents/current from Wi-Fi', () => {
  it.each([
    ['heartbeatContent', 'wake: timed'],
    ['soulContent', 'Kind.'],
    ['nopeContent', ''],
    ['memoryContent', 'Ship on Fridays.'],
    ['persona', 'A pirate.'],
    ['personaEnabled', false],
    ['traits', { tone: 5 }],
    ['conventions', { soul: false }],
  ])('refuses %s', async (field, value) => {
    const res = await request(app())
      .patch('/api/agents/current')
      .set('x-test-via', 'wifi')
      .send({ [field]: value });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: WIFI_AGENT_FILES_REFUSAL, code: NOT_FROM_WIFI });
  });

  it('takes any other field from Wi-Fi, and every field at this computer', async () => {
    const name = await request(app())
      .patch('/api/agents/current')
      .set('x-test-via', 'wifi')
      .send({ displayName: 'Ana' });
    expect(name.status).toBe(200);
    const here = await request(app())
      .patch('/api/agents/current')
      .send({ heartbeatContent: 'wake: timed' });
    expect(here.status).toBe(200);
  });
});

/**
 * Record a turn on `sessionId`, held or not, in a chat set to `mode`: Ask first unless named, since
 * a chat set to Full is not refused for its mark (DOR-3412).
 */
async function ran(sessionId: string, opts?: MessageOpts, mode = 'acceptEdits') {
  const seam = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => mode
  );
  for await (const _event of seam.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('update_agent from a turn that read outsider words', () => {
  const identity = { agentPath: '/agents/ana' };

  it('refuses SOUL.md, HEARTBEAT.md and the persona', async () => {
    await ran('held-turn', { permissionCeiling: 'runtime-default' });
    expect(() =>
      refuseOutsiderAgentFiles(
        { heartbeatContent: 'wake: timed' },
        { sessionId: 'held-turn', identity }
      )
    ).toThrow(CapabilityToolError);
  });

  it('refuses the convention switches and the personality dials too', async () => {
    await ran('held-turn-2', { permissionCeiling: 'runtime-default' });
    for (const input of [{ conventions: { soul: false } }, { traits: { tone: 1 } }]) {
      expect(() => refuseOutsiderAgentFiles(input, { sessionId: 'held-turn-2', identity })).toThrow(
        CapabilityToolError
      );
    }
  });

  it('at Full, lets a marked turn change its own words, never a person’s limits (DOR-3412)', async () => {
    await ran('full-held-turn', { permissionCeiling: 'runtime-default' }, 'bypassPermissions');
    try {
      for (const input of [
        { soulContent: 'Kind.' },
        { heartbeatContent: 'wake: timed' },
        { persona: 'Ana' },
        { traits: { tone: 1 } },
      ]) {
        expect(
          refuseOutsiderAgentFiles(input, { sessionId: 'full-held-turn', identity })
        ).toBeUndefined();
      }
      for (const input of [
        { nopeContent: 'Never deploy.' },
        { memoryContent: '- a note' },
        { conventions: { nope: false } },
      ]) {
        expect(() =>
          refuseOutsiderAgentFiles(input, { sessionId: 'full-held-turn', identity })
        ).toThrow(CapabilityToolError);
      }
    } finally {
      resetChosenTurns();
    }
  });

  it('below Full, still refuses its own words from a marked turn', async () => {
    await ran('ask-held-turn', { permissionCeiling: 'runtime-default' }, 'default');
    try {
      expect(() =>
        refuseOutsiderAgentFiles({ soulContent: 'Kind.' }, { sessionId: 'ask-held-turn', identity })
      ).toThrow(CapabilityToolError);
    } finally {
      resetChosenTurns();
    }
  });

  it('lets the same turn change other fields, and an owner’s turn change these', async () => {
    await ran('owner-turn');
    expect(
      refuseOutsiderAgentFiles({ displayName: 'Ana' }, { sessionId: 'held-turn', identity })
    ).toBeUndefined();
    expect(
      refuseOutsiderAgentFiles({ soulContent: 'Kind.' }, { sessionId: 'owner-turn', identity })
    ).toBeUndefined();
  });
});
