/**
 * From Wi-Fi, answering a turn that runs above Default may only pick what it
 * offered (DOR-3037): option labels, listed values, yes or no. Typed words, and
 * a Deny's reason, are refused there; a turn held to the default, a request
 * at this computer, or the owner's own sign-in (DOR-3242) takes any answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => ({ id: 'owner' }),
}));

import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RequestFacts } from '../../http/request-facts.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../services/core/turn-power/turn-levels.js';
import {
  disposeProjector,
  getOrCreateProjector,
  type RawSessionEvent,
} from '../../services/session/session-state-projector.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import {
  refuseDenyReason,
  refuseTypedAnswers,
  refuseTypedElicitation,
  WIFI_FREE_TEXT_REFUSAL,
} from '../session-answer-wifi.js';

const runtime = {
  type: 'claude-code',
  getCapabilities: () => ({
    ...CLAUDE_CODE_CAPABILITIES,
    permissionModes: { ...CLAUDE_CODE_CAPABILITIES.permissionModes, default: 'default' },
  }),
  getInternalSessionId: () => undefined,
  async *sendMessage(): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  },
} as unknown as AgentRuntime;

const WIFI = {
  remoteAddress: '192.168.1.20',
  headers: {},
  ingress: 'wifi',
} as unknown as RequestFacts;
const HERE = {
  remoteAddress: '127.0.0.1',
  headers: {},
  ingress: 'direct',
} as unknown as RequestFacts;
/** The owner's own sign-in, verified on the Wi-Fi route (DOR-3242). */
const OWNER_ON_WIFI = {
  ...WIFI,
  user: { userId: 'owner', credential: 'cookie', sessionId: 'phone', route: 'wifi' },
} as unknown as RequestFacts;
/** A teammate's, verified the same way. */
const TEAMMATE_ON_WIFI = {
  ...WIFI,
  user: { userId: 'teammate', credential: 'cookie', sessionId: 'tm', route: 'wifi' },
} as unknown as RequestFacts;
const REFUSED = { error: WIFI_FREE_TEXT_REFUSAL, code: NOT_FROM_WIFI };

/** A session whose running turn ran at Full autonomy, or held, with one question and one form. */
async function session(id: string, opts?: MessageOpts): Promise<void> {
  const seam = recordTurnLevels(runtime, () => 'bypassPermissions');
  for await (const _event of seam.sendMessage(id, 'hi', opts)) {
    // drain
  }
  const projector = getOrCreateProjector(id);
  projector.ingest({
    type: 'question_prompt',
    id: 'q-1',
    startedAt: Date.now(),
    remainingMs: 60_000,
    questions: [
      {
        header: '',
        question: 'Which branch?',
        options: [{ label: 'main' }, { label: 'release' }],
        multiSelect: false,
      },
    ],
  } as unknown as RawSessionEvent);
  projector.ingest({
    type: 'elicitation_prompt',
    id: 'e-1',
    startedAt: Date.now(),
    remainingMs: 60_000,
    serverName: 'deploy',
    message: 'Deploy where?',
    requestedSchema: {
      properties: {
        target: { type: 'string', enum: ['staging', 'prod'] },
        note: { type: 'string' },
        region: { type: 'string', oneOf: [{ const: 'eu', title: 'Europe' }, { const: 'us' }] },
        tags: { type: 'array', items: { anyOf: [{ const: 'fast' }, { const: 'safe' }] } },
      },
    },
  } as unknown as RawSessionEvent);
}

afterEach(() => {
  for (const id of ['full', 'held', 'unknown']) disposeProjector(id);
});

describe('a question from Wi-Fi into a turn above Default', () => {
  it('takes an offered label, and refuses typed words', async () => {
    await session('full');
    expect(refuseTypedAnswers(WIFI, runtime, 'full', 'q-1', { '0': 'release' })).toBeUndefined();
    expect(refuseTypedAnswers(WIFI, runtime, 'full', 'q-1', { '0': 'rm -rf the repo' })).toEqual(
      REFUSED
    );
  });

  it('takes typed words into a held turn, and at this computer', async () => {
    await session('held', { permissionCeiling: 'runtime-default' });
    expect(refuseTypedAnswers(WIFI, runtime, 'held', 'q-1', { '0': 'anything' })).toBeUndefined();
    await session('full');
    expect(refuseTypedAnswers(HERE, runtime, 'full', 'q-1', { '0': 'anything' })).toBeUndefined();
  });

  it('refuses typed words when the turn has no record', () => {
    expect(refuseTypedAnswers(WIFI, runtime, 'unknown', 'q-1', { '0': 'main' })).toEqual(REFUSED);
  });
});

describe('an elicitation from Wi-Fi into a turn above Default', () => {
  it('takes a listed value or a decline, and refuses free text', async () => {
    await session('full');
    expect(
      refuseTypedElicitation(WIFI, runtime, 'full', 'e-1', 'accept', { target: 'staging' })
    ).toBeUndefined();
    expect(
      refuseTypedElicitation(WIFI, runtime, 'full', 'e-1', 'decline', undefined)
    ).toBeUndefined();
    expect(
      refuseTypedElicitation(WIFI, runtime, 'full', 'e-1', 'accept', { note: 'also wipe prod' })
    ).toEqual(REFUSED);
    expect(
      refuseTypedElicitation(WIFI, runtime, 'full', 'e-1', 'accept', {
        region: 'eu',
        tags: ['fast', 'safe'],
      })
    ).toBeUndefined();
    expect(
      refuseTypedElicitation(WIFI, runtime, 'full', 'e-1', 'accept', { region: 'mars' })
    ).toEqual(REFUSED);
  });
});

describe('a Deny from Wi-Fi into a turn above Default', () => {
  it('takes no reason, and refuses a typed one', async () => {
    await session('full');
    expect(refuseDenyReason(WIFI, runtime, 'full', undefined)).toBeUndefined();
    expect(refuseDenyReason(WIFI, runtime, 'full', 'do this instead')).toEqual(REFUSED);
  });
});

describe("the owner's own sign-in on Wi-Fi (DOR-3242)", () => {
  it('types any answer, form value or Deny reason, as at this computer', async () => {
    await session('full');
    const owner = OWNER_ON_WIFI;
    expect(refuseTypedAnswers(owner, runtime, 'full', 'q-1', { '0': 'anything' })).toBeUndefined();
    expect(
      refuseTypedElicitation(owner, runtime, 'full', 'e-1', 'accept', { note: 'typed' })
    ).toBeUndefined();
    expect(refuseDenyReason(owner, runtime, 'full', 'do this instead')).toBeUndefined();
  });

  it('still refuses a teammate’s typed words', async () => {
    await session('full');
    const teammate = TEAMMATE_ON_WIFI;
    expect(refuseTypedAnswers(teammate, runtime, 'full', 'q-1', { '0': 'anything' })).toEqual(
      REFUSED
    );
    expect(refuseDenyReason(teammate, runtime, 'full', 'do this instead')).toEqual(REFUSED);
  });
});
