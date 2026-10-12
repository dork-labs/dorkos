/**
 * Every `discovery` oracle with a real PASS and a real FAIL, so an always-pass
 * oracle is caught without a model (README: "A new oracle ships with a drill"),
 * and the suggestion phrasings pinned on both sides, including the limits
 * their module doc admits to.
 */
import { describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { emptyApprovalLog, type OracleContext, type RoomFacts } from '../../types.js';
import {
  atMostTwoWays,
  chatAppsNamed,
  everyTurnAnswered,
  namesExactlyOneChatApp,
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
  waysNamed,
} from '../discovery-oracles.js';

function ctx(frames: SseFrame[], room?: RoomFacts): OracleContext {
  return {
    sandbox: { projectCwd: '/unused', dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: emptyApprovalLog(),
    ...(room ? { room } : {}),
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

/** One assistant turn saying `text`. */
function turn(text: string): SseFrame[] {
  return [
    { event: 'turn_start', data: { type: 'turn_start' } },
    { event: 'text_delta', data: { type: 'text_delta', text } },
    { event: 'turn_end', data: { type: 'turn_end' } },
  ] as SseFrame[];
}

const pass = async (o: ReturnType<typeof everyTurnAnswered>, frames: SseFrame[]) =>
  (await o(ctx(frames))).passed;

describe('the suggestion phrasings', () => {
  it('catch the shapes a suggestion takes', () => {
    for (const text of [
      'Connect Slack and I can post it for you.',
      'If you install the changelog-writer package, every entry reads the same.',
      'You can decide on the Connections page.',
      'It is on the Marketplace, if you want it.',
      'Once you connect it, I will post updates there.',
      'Want me to request access to Slack?',
      'I recommend setting up Slack for this.',
      'Once Slack is connected I can do this myself.',
    ]) {
      expect(suggestionPhrases(text), text).not.toEqual([]);
    }
  });

  it('leave a plain answer alone', () => {
    for (const text of [
      'Here is the summary:\n- Launch moves to Friday\n- Ana owns the price list',
      'Fixed: the checkout button works on Safari again.',
      'Hi all, the launch moved to Friday. Thanks for your patience!',
    ]) {
      expect(suggestionPhrases(text), text).toEqual([]);
    }
  });

  it('over-read a report of a failure, the strict direction its doc names', () => {
    expect(suggestionPhrases('I could not connect to Slack.')).not.toEqual([]);
  });

  it('count chat apps and ways by name, Teams only in full', () => {
    expect(chatAppsNamed('Tell the teams on Slack or Discord')).toEqual(['Slack', 'Discord']);
    expect(chatAppsNamed('Microsoft Teams')).toEqual(['Microsoft Teams']);
    expect(waysNamed('Slack, or a webhook with an API key')).toEqual([
      'Slack',
      'webhook',
      'API key',
    ]);
  });
});

describe('the turn guard', () => {
  it('passes answered turns and fails an empty, errored, missing or extra one', async () => {
    expect(await pass(everyTurnAnswered(1), turn('Done.'))).toBe(true);
    expect(await pass(everyTurnAnswered(2), [...turn('One.'), ...turn('Two.')])).toBe(true);
    expect(await pass(everyTurnAnswered(1), [])).toBe(false);
    expect(await pass(everyTurnAnswered(1), turn('  '))).toBe(false);
    expect(await pass(everyTurnAnswered(2), turn('Only one.'))).toBe(false);
    const errored = [...turn('Partly'), { event: 'error', data: { type: 'error' } } as SseFrame];
    expect(await pass(everyTurnAnswered(1), errored)).toBe(false);
  });
});

describe('the "should suggest" oracles', () => {
  it('namesExactlyOneChatApp wants one app, suggested', async () => {
    const one = turn('I cannot post yet. Connect Slack on the Connections page and I will.');
    expect(await pass(namesExactlyOneChatApp, one)).toBe(true);
    expect(await pass(namesExactlyOneChatApp, turn('Connect Slack or Discord.'))).toBe(false);
    expect(await pass(namesExactlyOneChatApp, turn('Slack is down today.'))).toBe(false);
    expect(await pass(namesExactlyOneChatApp, turn('Done.'))).toBe(false);
  });

  it('pointsToWhereTheyDecide reads the page name', async () => {
    expect(await pass(pointsToWhereTheyDecide('Connections'), turn('See Connections.'))).toBe(true);
    expect(await pass(pointsToWhereTheyDecide('Connections'), turn('See settings.'))).toBe(false);
    expect(await pass(pointsToWhereTheyDecide('Marketplace'), turn('In the Marketplace.'))).toBe(
      true
    );
  });

  it('suggestsChatAppInTurn reads the turn it names', async () => {
    const frames = [...turn('Connect Slack and I will post it.'), ...turn('Done.')];
    expect(await pass(suggestsChatAppInTurn(0), frames)).toBe(true);
    expect(await pass(suggestsChatAppInTurn(1), frames)).toBe(false);
  });

  it('atMostTwoWays passes one or two, fails a menu and fails none', async () => {
    expect(await pass(atMostTwoWays, turn('Connect Slack.'))).toBe(true);
    expect(await pass(atMostTwoWays, turn('Connect Slack, or I can email it.'))).toBe(true);
    expect(await pass(atMostTwoWays, turn('Slack, Discord or a webhook?'))).toBe(false);
    expect(await pass(atMostTwoWays, turn('Done.'))).toBe(false);
  });

  it('replyNamesPackageWithWhy wants the name and a reason', async () => {
    const o = replyNamesPackageWithWhy('changelog-writer');
    const good = 'The changelog writer package would keep every entry in the same voice.';
    expect(await pass(o, turn(good))).toBe(true);
    expect(await pass(o, turn('Try changelog-writer.'))).toBe(false);
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

  it('noDiscoveryLookups fails on any lookup, joined from streamed pieces', async () => {
    expect(await pass(noDiscoveryLookups, call('Read', { file_path: 'a.md' }))).toBe(true);
    for (const tool of [
      'mcp__dorkos__marketplace_recommend',
      'mcp__dorkos__connector_list_toolkits',
      'mcp__dorkos__connector_recommend',
      'mcp__dorkos__marketplace_search',
      'mcp__dorkos__connectors.request_connection',
    ]) {
      expect(await pass(noDiscoveryLookups, call(tool, { context: 'x' })), tool).toBe(false);
    }
  });

  it('noSuggestionToGet allows using the package and fails telling them to get it', async () => {
    const o = noSuggestionToGet('changelog-writer');
    expect(await pass(o, turn('I used your changelog-writer skill. Fixed: Safari checkout.'))).toBe(
      true
    );
    expect(await pass(o, turn('Install changelog-writer from the Marketplace.'))).toBe(false);
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
  const run = async (o: ReturnType<typeof roomPostsSuggestNothing>, frames: SseFrame[], r = room) =>
    (await o(ctx(frames, r))).passed;

  it('roomPostsSuggestNothing needs a post, and fails a suggestion', async () => {
    const o = roomPostsSuggestNothing('ada');
    expect(await run(o, [post('agent-ada', 'Draft: the launch moved to Friday.')])).toBe(true);
    expect(await run(o, [post('op', 'Thanks!')])).toBe(false);
    expect(await run(o, [])).toBe(false);
    const suggests = post('agent-ada', 'Draft below. If you connect Gmail I can send it.');
    expect(await run(o, [suggests])).toBe(false);
    expect(await run(o, [post('agent-ada', 'Hi')], { ...room, agents: {} })).toBe(false);
  });

  it('roomPostMatches reads only the agent posts', async () => {
    const o = roomPostMatches('ada', /friday/i, 'x');
    expect(await run(o, [post('agent-ada', 'Moved to Friday.')])).toBe(true);
    expect(await run(o, [post('op', 'Friday?'), post('agent-ada', 'Sure.')])).toBe(false);
  });
});
