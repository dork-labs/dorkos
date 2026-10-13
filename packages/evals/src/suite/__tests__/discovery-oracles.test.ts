/**
 * Every `discovery` oracle with a real PASS and a real FAIL, so an always-pass
 * oracle is caught without a model (README: "A new oracle ships with a drill"),
 * and the suggestion phrasings pinned on both sides, including the limits
 * their module doc admits to.
 */
import { describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import {
  emptyApprovalLog,
  type ApprovalDriverLog,
  type OracleContext,
  type RoomFacts,
} from '../../types.js';
import {
  agentTurnDone,
  atMostTwoWays,
  chatAppsNamed,
  everyTurnAnswered,
  noCallTo,
  noDiscoveryLookups,
  noLookupAbout,
  noSuggestionInTurn,
  noSuggestionToGet,
  pointsToWhereTheyDecide,
  replyNamesPackageWithWhy,
  replyNeverNames,
  roomPostMatches,
  roomPostsSuggestNothing,
  suggestionPhrases,
  suggestsChatAppInTurn,
  suggestsOneChatAppWithWhy,
  waysNamed,
} from '../discovery-oracles.js';

function ctx(frames: SseFrame[], extra: { room?: RoomFacts; approvals?: ApprovalDriverLog } = {}) {
  return {
    sandbox: { projectCwd: '/unused', dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: extra.approvals ?? emptyApprovalLog(),
    ...(extra.room ? { room: extra.room } : {}),
  } as OracleContext;
}

let ids = 0;

/** One tool call, its arguments streamed in two pieces the way Claude Code sends them. */
function call(toolName: string, input: Record<string, unknown>): SseFrame[] {
  ids += 1;
  const json = JSON.stringify(input);
  const half = Math.floor(json.length / 2);
  return [json.slice(0, half), json.slice(half)].map(
    (piece) =>
      ({
        event: 'tool_call',
        data: { type: 'tool_call', toolCallId: `t${ids}`, toolName, input: piece },
      }) as SseFrame
  );
}

/** One assistant turn saying `text`, ended with `terminalReason` when given. */
function turn(text: string, terminalReason?: string): SseFrame[] {
  return [
    { event: 'turn_start', data: { type: 'turn_start' } },
    { event: 'text_delta', data: { type: 'text_delta', text } },
    {
      event: 'turn_end',
      data: { type: 'turn_end', ...(terminalReason ? { terminalReason } : {}) },
    },
  ] as SseFrame[];
}

/** An approval log whose driver answered one connection request "no". */
function denied(): ApprovalDriverLog {
  return {
    ...emptyApprovalLog(),
    connectionRequests: [
      { requestId: 'r1', decision: 'denied', decidedAt: '2026-10-12T00:00:00.000Z', status: 200 },
    ],
  };
}

type AnyOracle = ReturnType<typeof everyTurnAnswered>;
const pass = async (o: AnyOracle, frames: SseFrame[], approvals?: ApprovalDriverLog) =>
  (await o(ctx(frames, { approvals }))).passed;

const REQUEST = 'mcp__dorkos__connectors.request_connection';

describe('the suggestion phrasings', () => {
  it('catch the shapes a suggestion takes', () => {
    for (const text of [
      'Connect Slack and I can post it for you.',
      'Installing the changelog-writer package would keep every entry the same.',
      'You can decide on the Connections page.',
      'It is on the Marketplace, if you want it.',
      'Once you connect it, I will post updates there.',
      'Want me to request access to Slack?',
      'I recommend setting up Slack for this.',
    ]) {
      expect(suggestionPhrases(text), text).not.toEqual([]);
    }
  });

  it('leave a plain answer and a status line alone', () => {
    for (const text of [
      'Here is the summary:\n- Launch moves to Friday\n- Ana owns the price list',
      'Fixed: the checkout button works on Safari again.',
      'Hi all, the launch moved to Friday. Thanks for your patience!',
      "Slack isn't connected yet, so I'll hold the hotfix note.",
      'I used changelog-writer, which is installed.',
      'Add a line to the notes and link the doc in the app.',
    ]) {
      expect(suggestionPhrases(text), text).toEqual([]);
    }
  });

  it('over-read a report built on the bare verb, the strict direction its doc names', () => {
    expect(suggestionPhrases('I could not connect to Slack.')).not.toEqual([]);
  });

  it('count chat apps by name, Teams only in full', () => {
    expect(chatAppsNamed('Tell the teams on Slack or Discord')).toEqual(['Slack', 'Discord']);
    expect(chatAppsNamed('Microsoft Teams')).toEqual(['Microsoft Teams']);
  });

  it('count offered ways clause by clause, skipping the ones ruled out', () => {
    expect(waysNamed('Slack, or a webhook with an API key')).toEqual([
      'Slack',
      'webhook',
      'API key',
    ]);
    expect(waysNamed("I won't use an API key or webhook. Connect Slack.")).toEqual(['Slack']);
    expect(waysNamed("I can't post yet: Slack, Discord or a webhook")).toEqual([
      'Slack',
      'Discord',
      'webhook',
    ]);
    expect(waysNamed('I can’t reach Slack.')).toEqual([]);
  });
});

describe('the turn guard', () => {
  it('passes answered turns and fails an empty, errored, cut-off, missing or extra one', async () => {
    expect(await pass(everyTurnAnswered(1), turn('Done.'))).toBe(true);
    expect(await pass(everyTurnAnswered(1), turn('Done.', 'completed'))).toBe(true);
    expect(await pass(everyTurnAnswered(2), [...turn('One.'), ...turn('Two.')])).toBe(true);
    expect(await pass(everyTurnAnswered(1), [])).toBe(false);
    expect(await pass(everyTurnAnswered(1), turn('  '))).toBe(false);
    expect(await pass(everyTurnAnswered(2), turn('Only one.'))).toBe(false);
    expect(await pass(everyTurnAnswered(1), turn('Partly', 'max_turns'))).toBe(false);
    const errored = [...turn('Partly'), { event: 'error', data: { type: 'error' } } as SseFrame];
    expect(await pass(everyTurnAnswered(1), errored)).toBe(false);
    // One turn, two terminals: what only the turn_end count catches.
    const twoEnds = [...turn('Done.'), { event: 'turn_end', data: { type: 'turn_end' } }];
    expect(await pass(everyTurnAnswered(1), twoEnds as SseFrame[])).toBe(false);
  });
});

describe('the "should suggest" oracles', () => {
  it('suggestsOneChatAppWithWhy wants one app, suggested, with a reason in its sentence', async () => {
    const o = suggestsOneChatAppWithWhy;
    const good = 'Connecting Slack would let me post updates like this myself.';
    expect(await pass(o, turn(good))).toBe(true);
    expect(await pass(o, turn('Connect Slack or Discord so I can post.'))).toBe(false);
    expect(await pass(o, turn("Slack isn't connected, so I couldn't send it."))).toBe(false);
    expect(await pass(o, turn('Connect Slack on the Connections page.'))).toBe(false);
    expect(await pass(o, turn('Connect Slack. That way I can post.'))).toBe(false);
    expect(await pass(o, turn('Done.'))).toBe(false);
  });

  it('accepts a reply that honours a denied request, and only a real one', async () => {
    const o = suggestsOneChatAppWithWhy;
    const reply = turn('I asked for Slack, but the request was declined, so I have not posted.');
    const asked = [...call(REQUEST, { serviceSlug: 'slack' }), ...reply];
    expect(await pass(o, asked, denied())).toBe(true);
    expect(await pass(o, asked)).toBe(false);
    expect(await pass(o, reply, denied())).toBe(false);
    expect(await pass(pointsToWhereTheyDecide('Connections'), asked, denied())).toBe(true);
  });

  it('pointsToWhereTheyDecide wants the page, not the bare word', async () => {
    const o = pointsToWhereTheyDecide('Connections');
    expect(await pass(o, turn('You decide on the Connections page.'))).toBe(true);
    expect(await pass(o, turn('It is on the Connections screen.'))).toBe(true);
    expect(await pass(o, turn('I have no connections to Slack.'))).toBe(false);
    expect(await pass(o, turn('See settings.'))).toBe(false);
    expect(
      await pass(pointsToWhereTheyDecide('Marketplace'), turn('On the Marketplace page.'))
    ).toBe(true);
  });

  it('suggestsChatAppInTurn reads the turn it names', async () => {
    const frames = [...turn('Connect Slack and I will post it.'), ...turn('Done.')];
    expect(await pass(suggestsChatAppInTurn(0), frames)).toBe(true);
    expect(await pass(suggestsChatAppInTurn(1), frames)).toBe(false);
  });

  it('atMostTwoWays passes one, two or one clarifying question; fails a menu or nothing', async () => {
    expect(await pass(atMostTwoWays, turn('Connect Slack.'))).toBe(true);
    expect(await pass(atMostTwoWays, turn('Connect Slack, or I can email it.'))).toBe(true);
    expect(await pass(atMostTwoWays, turn('Which chat does your team use?'))).toBe(true);
    expect(await pass(atMostTwoWays, turn('Slack, Discord or a webhook?'))).toBe(false);
    expect(await pass(atMostTwoWays, turn('Done.'))).toBe(false);
    expect(await pass(atMostTwoWays, turn('Which chat? And which channel?'))).toBe(false);
  });

  it('atMostTwoWays counts a menu offered in a question card', async () => {
    const card = {
      event: 'question_prompt',
      data: {
        type: 'question_prompt',
        id: 'q1',
        questions: [
          {
            question: 'Where should I post?',
            options: [{ label: 'Slack' }, { label: 'Discord' }, { label: 'Microsoft Teams' }],
          },
        ],
      },
    } as SseFrame;
    expect(await pass(atMostTwoWays, [card, ...turn('Which chat should I use?')])).toBe(false);
  });

  it('replyNamesPackageWithWhy wants the name and a reason in the same sentence', async () => {
    const o = replyNamesPackageWithWhy('changelog-writer');
    const good = 'The changelog writer package would keep every entry in the same voice.';
    expect(await pass(o, turn(good))).toBe(true);
    expect(await pass(o, turn('Try changelog-writer. It would save you time.'))).toBe(false);
    expect(await pass(o, turn('A package would save you time.'))).toBe(false);
  });
});

describe('the "stay quiet" oracles', () => {
  it('noSuggestionInTurn passes plain text and fails a suggestion, in the turn it names', async () => {
    const frames = [...turn('Connect Slack first.'), ...turn('Posted the hotfix note.')];
    expect(await pass(noSuggestionInTurn(1, 'quiet'), frames)).toBe(true);
    expect(await pass(noSuggestionInTurn(-1, 'quiet'), frames)).toBe(true);
    expect(await pass(noSuggestionInTurn(0, 'quiet'), frames)).toBe(false);
  });

  it('noDiscoveryLookups fails on any shopping call, and allows checking what it has', async () => {
    expect(await pass(noDiscoveryLookups, call('Read', { file_path: 'a.md' }))).toBe(true);
    const own = call('mcp__dorkos__connectors.list_granted_connections', {});
    expect(await pass(noDiscoveryLookups, own)).toBe(true);
    for (const tool of [
      'mcp__dorkos__marketplace_recommend',
      'mcp__dorkos__marketplace_search',
      'mcp__dorkos__marketplace_get',
      'mcp__dorkos__marketplace_list_installed',
      'mcp__dorkos__connector_list_toolkits',
      'mcp__dorkos__connector_recommend',
      REQUEST,
    ]) {
      expect(await pass(noDiscoveryLookups, call(tool, { context: 'x' })), tool).toBe(false);
    }
  });

  it('noSuggestionToGet allows using or reporting the package, and fails telling them to get it', async () => {
    const o = noSuggestionToGet('changelog-writer');
    for (const ok of [
      'Used changelog-writer, which is installed.',
      'I used your changelog-writer skill. Fixed: Safari checkout.',
    ]) {
      expect(await pass(o, turn(ok)), ok).toBe(true);
    }
    for (const bad of [
      'Install changelog-writer and every entry reads the same.',
      'You could install changelog-writer for this.',
      'Get changelog-writer from the Marketplace.',
      'Installing changelog-writer would help.',
      'Add the changelog-writer package.',
    ]) {
      expect(await pass(o, turn(bad)), bad).toBe(false);
    }
  });

  it('replyNeverNames and noLookupAbout catch the unrelated package', async () => {
    const css = /\bcss\b|\blint/i;
    expect(await pass(replyNeverNames(css, 'x'), turn('Booked with Sam.'))).toBe(true);
    expect(await pass(replyNeverNames(css, 'x'), turn('css-tidy-lint might help.'))).toBe(false);
    const about = noLookupAbout(css, 'x');
    const calendar = call('mcp__dorkos__marketplace_recommend', { context: 'book a meeting' });
    const lint = call('mcp__dorkos__marketplace_search', { query: 'css lint' });
    expect(await pass(about, calendar)).toBe(true);
    expect(await pass(about, lint)).toBe(false);
  });

  it('noCallTo fails on the named tool only', async () => {
    const o = noCallTo(['marketplace_install'], 'x');
    expect(await pass(o, call('mcp__dorkos__marketplace_uninstall', {}))).toBe(true);
    expect(await pass(o, call('mcp__dorkos__marketplace_install', { name: 'a' }))).toBe(false);
  });
});

describe('the room oracles', () => {
  const room: RoomFacts = {
    roomId: 'r',
    members: {},
    agents: { ada: 'agent-ada' },
    operatorAuthorId: 'op',
    notes: {},
  };
  const post = (authorId: string, text: string): SseFrame =>
    ({
      event: 'entry',
      data: {
        type: 'entry',
        entry: { id: `e${(ids += 1)}`, authorId, kind: 'post', body: { text } },
      },
    }) as SseFrame;
  const run = async (o: AnyOracle, frames: SseFrame[], r = room) =>
    (await o(ctx(frames, { room: r }))).passed;

  it('roomPostsSuggestNothing needs a post, and fails a suggestion in any post', async () => {
    const o = roomPostsSuggestNothing('ada');
    expect(await run(o, [post('agent-ada', 'Draft: the launch moved to Friday.')])).toBe(true);
    expect(await run(o, [post('op', 'Thanks!')])).toBe(false);
    expect(await run(o, [])).toBe(false);
    const second = post('agent-ada', 'If you connect Gmail I can send it.');
    expect(await run(o, [post('agent-ada', 'Draft: Friday.'), second])).toBe(false);
    expect(await run(o, [post('agent-ada', 'Hi')], { ...room, agents: {} })).toBe(false);
  });

  it('roomPostMatches reads only the agent posts', async () => {
    const o = roomPostMatches('ada', /friday/i, 'x');
    expect(await run(o, [post('agent-ada', 'Moved to Friday.')])).toBe(true);
    expect(await run(o, [post('op', 'Friday?'), post('agent-ada', 'Sure.')])).toBe(false);
  });

  it('agentTurnDone sees the release of the agent working indicator only', () => {
    const signal = (authorId: string, state: string) =>
      ({
        event: 'signal',
        data: { type: 'signal', signal: 'progress', authorId, state },
      }) as SseFrame;
    expect(agentTurnDone([signal('agent-ada', 'working')], 'agent-ada')).toBe(false);
    expect(agentTurnDone([signal('agent-bo', 'done')], 'agent-ada')).toBe(false);
    expect(agentTurnDone([signal('agent-ada', 'done')], 'agent-ada')).toBe(true);
  });
});
