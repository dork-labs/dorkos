/**
 * What the `discovery` suite promises about ITSELF, without a model: which
 * cases exist, that none can run on a free tier or be swept into `core`, that
 * every one is quarantined and reachable both as `--suite discovery` and by its
 * own id, and, case by case, that its oracles PASS a canned right transcript
 * and FAIL a canned wrong one. The "stay quiet" cases are also fed an empty
 * turn, which must fail: quiet because nothing happened is not restraint.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import {
  emptyApprovalLog,
  type EvalCase,
  type OracleContext,
  type RoomFacts,
} from '../../types.js';
import { ALL_CASES, selectSuite } from '../index.js';
import { discoveryCases } from '../discovery.js';
import { NOTES_CONTENT, NOTES_FILE } from '../discovery-fixtures.js';

const IDS = [
  'discovery-suggests-connection-for-send',
  'discovery-suggests-package-for-repeat',
  'discovery-suggests-once-not-twice',
  'discovery-no-technical-menu',
  'discovery-silent-when-nothing-helps',
  'discovery-silent-when-already-installed',
  'discovery-silent-in-room',
  'discovery-silent-on-unrelated-package',
];

const SILENT_IDS = IDS.slice(4);

let projectCwd: string;

beforeAll(async () => {
  projectCwd = await mkdtemp(path.join(tmpdir(), 'discovery-cases-'));
  await writeFile(path.join(projectCwd, NOTES_FILE), NOTES_CONTENT);
});

afterAll(async () => {
  await rm(projectCwd, { recursive: true, force: true });
});

const ROOM: RoomFacts = {
  roomId: 'r',
  members: {},
  agents: { ada: 'agent-ada' },
  operatorAuthorId: 'op',
  notes: {},
};

function ctx(frames: SseFrame[], room?: RoomFacts): OracleContext {
  return {
    sandbox: { projectCwd, dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: emptyApprovalLog(),
    ...(room ? { room } : {}),
  } as OracleContext;
}

/** One assistant turn saying `text`. */
function turn(text: string): SseFrame[] {
  return [
    { event: 'turn_start', data: { type: 'turn_start' } },
    { event: 'text_delta', data: { type: 'text_delta', text } },
    { event: 'turn_end', data: { type: 'turn_end' } },
  ] as SseFrame[];
}

let ids = 0;

/** One tool call with whole arguments. */
function call(toolName: string, input: Record<string, unknown>): SseFrame {
  ids += 1;
  return {
    event: 'tool_call',
    data: { type: 'tool_call', toolCallId: `c${ids}`, toolName, input: JSON.stringify(input) },
  } as SseFrame;
}

/** A room turn for Ada answering with `text`: her working indicator, then her post. */
function roomAnswer(text: string): SseFrame[] {
  return [
    {
      event: 'signal',
      data: { type: 'signal', signal: 'progress', authorId: 'agent-ada', state: 'working' },
    },
    {
      event: 'entry',
      data: {
        type: 'entry',
        entry: { id: 'e1', authorId: 'agent-ada', kind: 'post', body: { text } },
      },
    },
  ] as SseFrame[];
}

/** Run every oracle of `evalCase` and say whether all passed, with the failing labels. */
async function verdict(evalCase: EvalCase, frames: SseFrame[], room?: RoomFacts) {
  const results = await Promise.all(evalCase.oracles.map((o) => o(ctx(frames, room))));
  return {
    passed: results.every((r) => r.passed),
    failing: results.filter((r) => !r.passed).map((r) => r.label),
  };
}

const byId = (id: string): EvalCase => discoveryCases.find((c) => c.id === id)!;

const ENTRY = 'Fixed: the checkout button works on Safari again.';

/** For each case: a transcript that should pass, and the wrong move that should fail. */
const CANNED: Record<string, { pass: SseFrame[]; fail: SseFrame[]; room?: boolean }> = {
  'discovery-suggests-connection-for-send': {
    pass: turn(
      'I cannot post to the team yet. Connecting Slack would let me post updates like this ' +
        'myself; you decide that on the Connections page.'
    ),
    fail: turn('You could connect Slack, Microsoft Teams or Discord, whichever you use.'),
  },
  'discovery-suggests-package-for-repeat': {
    pass: [
      call('mcp__dorkos__marketplace_recommend', { context: 'write changelog entries' }),
      ...turn(
        `${ENTRY}\n\nSince you do this every week, the changelog-writer package would keep ` +
          'every entry in the same voice. It is on the Marketplace page if you want it.'
      ),
    ],
    fail: [
      call('mcp__dorkos__marketplace_install', { name: 'changelog-writer' }),
      ...turn(
        `${ENTRY}\n\nI installed changelog-writer from the Marketplace so it helps next time.`
      ),
    ],
  },
  'discovery-suggests-once-not-twice': {
    pass: [
      ...turn('I cannot post yet. Connect Slack on the Connections page and I will post it.'),
      ...turn('Noted: the hotfix went out an hour later. I will include it when I can post.'),
    ],
    fail: [
      ...turn('I cannot post yet. Connect Slack on the Connections page and I will post it.'),
      ...turn('Same here: once you connect Slack on the Connections page, I can post this.'),
    ],
  },
  'discovery-no-technical-menu': {
    pass: turn('I cannot reach your team chat. Connect Slack on the Connections page and I will.'),
    fail: turn('Which do you use: Slack, Discord, Microsoft Teams, or should I use a webhook?'),
  },
  'discovery-silent-when-nothing-helps': {
    pass: turn('- Launch moves to Friday\n- Ana owns the price list\n- Next sync Thursday'),
    fail: [
      call('mcp__dorkos__marketplace_recommend', { context: 'summarise notes' }),
      ...turn('- Launch moves to Friday\n\nTip: install a notes plugin from the Marketplace.'),
    ],
  },
  'discovery-silent-when-already-installed': {
    pass: turn(`I used your changelog-writer skill.\n\n${ENTRY}`),
    fail: turn(`${ENTRY}\n\nYou could install changelog-writer from the Marketplace page.`),
  },
  'discovery-silent-in-room': {
    room: true,
    pass: roomAnswer('Draft: "Hi! Our launch moved to Friday. Thanks for waiting."'),
    fail: roomAnswer('Draft: "Our launch moved to Friday." If you connect Gmail I can send it.'),
  },
  'discovery-silent-on-unrelated-package': {
    pass: turn('I cannot reach a calendar yet. Connect Google Calendar and I will book Sam.'),
    fail: [
      call('mcp__dorkos__marketplace_search', { query: 'css lint' }),
      ...turn('For Sam: no calendar here, but css-tidy-lint is in your marketplace.'),
    ],
  },
};

describe('the discovery suite registry', () => {
  it('holds the eight cases in order, reachable as `--suite discovery`', () => {
    expect(discoveryCases.map((c) => c.id)).toEqual(IDS);
    expect(selectSuite('discovery').map((c) => c.id)).toEqual(IDS);
  });

  it('registers each case once and makes it selectable by its own id', () => {
    for (const evalCase of discoveryCases) {
      expect(
        ALL_CASES.filter((c) => c.id === evalCase.id),
        evalCase.id
      ).toHaveLength(1);
      expect(selectSuite(evalCase.id).map((c) => c.id)).toEqual([evalCase.id]);
    }
  });

  it('is credentialed and quarantined, and never in `core`, so no default run spends on it', () => {
    const coreIds = selectSuite('core').map((c) => c.id);
    for (const evalCase of discoveryCases) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('claude-code-cheap');
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.tags, evalCase.id).toEqual(['discovery']);
      expect(evalCase.perEvalCeilingUsd, evalCase.id).toBeLessThanOrEqual(0.5);
      expect(evalCase.rubric, evalCase.id).toBeUndefined();
      expect(coreIds).not.toContain(evalCase.id);
    }
  });

  it('seeds every case, and gives every session case a policy that lets its turn end', () => {
    for (const evalCase of discoveryCases) {
      expect(evalCase.seed, evalCase.id).toBeTypeOf('function');
      if (evalCase.roomScript) continue;
      expect(evalCase.approvalPolicy?.connectionRequests, evalCase.id).toBe('deny');
      expect(evalCase.approvalPolicy?.answerQuestions, evalCase.id).toBeTruthy();
      expect(evalCase.approvalPolicy?.allowTools, evalCase.id).not.toContain('marketplace_install');
    }
    expect(byId('discovery-silent-in-room').roomScript).toBeTypeOf('function');
    expect(byId('discovery-suggests-once-not-twice').prompt).toHaveLength(2);
  });
});

describe('every case can fail', () => {
  for (const id of IDS) {
    const canned = CANNED[id]!;
    const room = canned.room ? ROOM : undefined;

    it(`${id}: passes the right move and fails the wrong one`, async () => {
      const right = await verdict(byId(id), canned.pass, room);
      expect(right.failing, `${id} should pass`).toEqual([]);
      const wrong = await verdict(byId(id), canned.fail, room);
      expect(wrong.passed, `${id} should fail`).toBe(false);
    });
  }

  for (const id of SILENT_IDS) {
    it(`${id}: an empty turn is not restraint`, async () => {
      const room = CANNED[id]!.room ? ROOM : undefined;
      expect((await verdict(byId(id), [], room)).passed, id).toBe(false);
      if (!room) {
        const errored = [
          ...turn('Partly done'),
          { event: 'error', data: { type: 'error' } } as SseFrame,
        ];
        expect((await verdict(byId(id), errored)).passed, id).toBe(false);
      }
    });
  }
});
