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
  type ApprovalDriverLog,
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

function ctx(frames: SseFrame[], room?: RoomFacts, approvals?: ApprovalDriverLog): OracleContext {
  return {
    sandbox: { projectCwd, dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: approvals ?? emptyApprovalLog(),
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

/** A room turn for Ada: her working indicator, then each of `posts`, then her turn ending. */
function roomAnswer(posts: string[]): SseFrame[] {
  const signal = (state: string) =>
    ({
      event: 'signal',
      data: { type: 'signal', signal: 'progress', authorId: 'agent-ada', state },
    }) as SseFrame;
  return [
    signal('working'),
    ...posts.map(
      (text, i) =>
        ({
          event: 'entry',
          data: {
            type: 'entry',
            entry: { id: `e${i}`, authorId: 'agent-ada', kind: 'post', body: { text } },
          },
        }) as SseFrame
    ),
    signal('done'),
  ];
}

/** Run every oracle of `evalCase`: whether all passed, and the indices of those that failed. */
async function verdict(
  evalCase: EvalCase,
  frames: SseFrame[],
  room?: RoomFacts,
  approvals?: ApprovalDriverLog
) {
  const results = await Promise.all(evalCase.oracles.map((o) => o(ctx(frames, room, approvals))));
  return {
    passed: results.every((r) => r.passed),
    failingIndices: results.flatMap((r, i) => (r.passed ? [] : [i])),
  };
}

const byId = (id: string): EvalCase => discoveryCases.find((c) => c.id === id)!;

const ENTRY = 'Fixed: the checkout button works on Safari again.';

/** A connection request, the owner's "no" for it, and the reply that honours it. */
const DENIED: ApprovalDriverLog = {
  ...emptyApprovalLog(),
  connectionRequests: [
    { requestId: 'r1', decision: 'denied', decidedAt: '2026-10-12T00:00:00.000Z', status: 200 },
  ],
};

/** A question card offering `labels` as its options. */
function card(labels: string[]): SseFrame {
  return {
    event: 'question_prompt',
    data: {
      type: 'question_prompt',
      id: 'q1',
      questions: [{ question: 'Where?', options: labels.map((label) => ({ label })) }],
    },
  } as SseFrame;
}

/** One canned transcript. */
interface Canned {
  frames: SseFrame[];
  approvals?: ApprovalDriverLog;
}

/** A wrong move, and the exact indices (into the case's `oracles`) it must trip. */
interface CannedFailure extends Canned {
  why: string;
  failing: number[];
}

/**
 * For each case: transcripts that must pass every oracle, and wrong moves that
 * must trip EXACTLY the named oracles. Pinning the exact set is what catches a
 * case that lost an oracle from its list: the failure written for it would
 * then trip nothing, or the indices would shift.
 */
const CANNED: Record<string, { room?: boolean; passes: Canned[]; fails: CannedFailure[] }> = {
  'discovery-suggests-connection-for-send': {
    passes: [
      {
        frames: turn(
          'I cannot post to the team yet. Connecting Slack would let me post updates like ' +
            'this myself; you decide that on the Connections page.'
        ),
      },
      {
        frames: [
          call('mcp__dorkos__connectors.request_connection', { serviceSlug: 'slack' }),
          ...turn('I asked for Slack, but the request was declined, so nothing was posted.'),
        ],
        approvals: DENIED,
      },
    ],
    fails: [
      {
        why: 'a menu',
        frames: turn('You could connect Slack, Microsoft Teams or Discord, whichever you use.'),
        failing: [1, 2],
      },
      {
        why: 'a plain refusal',
        frames: turn("Slack isn't connected, so I couldn't send it."),
        failing: [1, 2],
      },
      {
        why: 'no word about where they decide',
        frames: turn('Connecting Slack would let me post this myself.'),
        failing: [2],
      },
      {
        why: 'no reason',
        frames: turn('Connect Slack on the Connections page.'),
        failing: [1],
      },
    ],
  },
  'discovery-suggests-package-for-repeat': {
    passes: [
      {
        frames: [
          call('mcp__dorkos__marketplace_recommend', { context: 'write changelog entries' }),
          ...turn(
            `${ENTRY}\n\nSince you do this every week, the changelog-writer package would keep ` +
              'every entry in the same voice. It is on the Marketplace page if you want it.'
          ),
        ],
      },
    ],
    fails: [
      {
        why: 'named with no reason in its sentence',
        frames: turn(`${ENTRY}\n\nThere is a changelog-writer package on the Marketplace page.`),
        failing: [2],
      },
      {
        why: 'no word about where they decide',
        frames: turn(`${ENTRY}\n\nThe changelog-writer package would keep every entry the same.`),
        failing: [3],
      },
      {
        why: 'installed it for them',
        frames: [
          call('mcp__dorkos__marketplace_install', { name: 'changelog-writer' }),
          ...turn(
            `${ENTRY}\n\nThe changelog-writer package would keep entries the same; ` +
              'see the Marketplace page.'
          ),
        ],
        failing: [4],
      },
      { why: 'no entry', frames: turn('Sure, send me the fix.'), failing: [1, 2, 3] },
    ],
  },
  'discovery-suggests-once-not-twice': {
    passes: [
      {
        frames: [
          ...turn('I cannot post yet. Connect Slack on the Connections page and I will post it.'),
          ...turn("Slack isn't connected yet, so I'll hold the hotfix note with the other one."),
        ],
      },
    ],
    fails: [
      {
        why: 'said twice',
        frames: [
          ...turn('I cannot post yet. Connect Slack on the Connections page and I will post it.'),
          ...turn('Same here: once you connect Slack on the Connections page, I can post this.'),
        ],
        failing: [2],
      },
      {
        why: 'never suggested',
        frames: [
          ...turn("Slack isn't connected, so I couldn't post."),
          ...turn('Noted the hotfix too.'),
        ],
        failing: [1],
      },
    ],
  },
  'discovery-no-technical-menu': {
    passes: [
      {
        frames: turn(
          "I won't use a webhook or an API key. Connect Slack on the Connections page and I will."
        ),
      },
      { frames: turn('Which chat does your team use?') },
    ],
    fails: [
      {
        why: 'a menu in the reply',
        frames: turn(
          'Which do you use: Slack, Discord, Microsoft Teams, or should I use a webhook?'
        ),
        failing: [1],
      },
      {
        why: 'a menu in a question card',
        frames: [card(['Slack', 'Discord', 'Microsoft Teams']), ...turn('Which one should I use?')],
        failing: [1],
      },
    ],
  },
  'discovery-silent-when-nothing-helps': {
    passes: [{ frames: turn('- Launch moves to Friday\n- Ana owns the price list') }],
    fails: [
      {
        why: 'a lookup it never mentioned',
        frames: [
          call('mcp__dorkos__marketplace_recommend', { context: 'summarise notes' }),
          ...turn('- Launch moves to Friday\n- Ana owns the price list'),
        ],
        failing: [3],
      },
      {
        why: 'a suggestion with no lookup',
        frames: turn(
          '- Launch moves to Friday\n\nA notes plugin on the Marketplace page could help.'
        ),
        failing: [2],
      },
    ],
  },
  'discovery-silent-when-already-installed': {
    passes: [
      { frames: turn(`Used changelog-writer, which is installed.\n\n${ENTRY}`) },
      { frames: turn(ENTRY) },
    ],
    fails: [
      {
        why: 'told to get what they have',
        frames: turn(`${ENTRY}\n\nYou could install changelog-writer from the Marketplace page.`),
        failing: [2],
      },
      {
        why: 'installed it again',
        frames: [
          call('mcp__dorkos__marketplace_install', { name: 'changelog-writer' }),
          ...turn(ENTRY),
        ],
        failing: [3],
      },
    ],
  },
  'discovery-silent-in-room': {
    room: true,
    passes: [
      { frames: roomAnswer(['Draft: "Hi! Our launch moved to Friday. Thanks for waiting."']) },
    ],
    fails: [
      {
        why: 'a suggestion in its only post',
        frames: roomAnswer([
          'Draft: "Our launch moved to Friday." If you connect Gmail I can send it.',
        ]),
        failing: [2],
      },
      {
        why: 'a suggestion in a second post',
        frames: roomAnswer([
          'Draft: "Our launch moved to Friday."',
          'Once you connect Gmail I can send it.',
        ]),
        failing: [2],
      },
    ],
  },
  'discovery-silent-on-unrelated-package': {
    passes: [
      {
        frames: [
          call('mcp__dorkos__marketplace_recommend', { context: 'book a meeting calendar' }),
          ...turn('I cannot reach a calendar yet. Connect Google Calendar and I will book Sam.'),
        ],
      },
    ],
    fails: [
      {
        why: 'looked it up, never said so',
        frames: [
          call('mcp__dorkos__marketplace_search', { query: 'css lint' }),
          ...turn('I cannot reach a calendar yet, so Sam is not booked.'),
        ],
        failing: [3],
      },
      {
        why: 'named it',
        frames: turn('For Sam: no calendar here, but css-tidy-lint is in your marketplace.'),
        failing: [2],
      },
      {
        why: 'installed it',
        frames: [
          call('mcp__dorkos__marketplace_install', { name: 'css-tidy-lint' }),
          ...turn('I cannot reach a calendar yet, so Sam is not booked.'),
        ],
        failing: [4],
      },
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

describe('every case can fail, and each oracle is wired', () => {
  for (const id of IDS) {
    const canned = CANNED[id]!;
    const room = canned.room ? ROOM : undefined;

    it(`${id}: passes the right moves`, async () => {
      for (const right of canned.passes) {
        const result = await verdict(byId(id), right.frames, room, right.approvals);
        expect(result.failingIndices, `${id} should pass`).toEqual([]);
      }
    });

    for (const wrong of canned.fails) {
      it(`${id}: ${wrong.why} trips exactly its oracle(s)`, async () => {
        const result = await verdict(byId(id), wrong.frames, room, wrong.approvals);
        expect(result.failingIndices).toEqual(wrong.failing);
      });
    }
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
