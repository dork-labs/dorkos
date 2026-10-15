/**
 * Fakes for heartbeat triage tests: a chat-completions server that answers one
 * label, and the changes a beat may carry. Nothing here touches the network.
 *
 * @module services/decisions/__tests__/triage-fakes
 */
import {
  createMemoryCallCounter,
  createOpenAiCompatibleModel,
  type FetchLike,
} from '@dorkos/decisions';
import type { Change } from '../../heartbeats/gatherers/index.js';
import type { TriageBeatDeps } from '../heartbeat-triage.js';

/** One request the fake server saw. */
export interface SeenRequest {
  /** The URL posted to. */
  url: string;
  /** The authorization header, as sent. */
  authorization: string | undefined;
  /** The parsed body. */
  body: Record<string, unknown>;
}

/** How the fake server answers. */
export interface FakeAnswer {
  /** The label it picks. */
  label: string;
  /** The probability its tokens carry; omit to send no logprobs (ask-twice). */
  probability?: number;
  /** Answer with this HTTP status instead. */
  status?: number;
}

/**
 * A fake chat-completions server.
 *
 * @param answer - What it answers each time; a function to vary it per call.
 */
export function fakeChatServer(answer: FakeAnswer | ((n: number) => FakeAnswer)) {
  const seen: SeenRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url,
      authorization: init.headers.authorization,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const a = typeof answer === 'function' ? answer(seen.length - 1) : answer;
    if (a.status && a.status !== 200) {
      return { ok: false, status: a.status, json: async () => ({}) };
    }
    const content = JSON.stringify({ triage: a.label });
    const at = content.indexOf(`"${a.label}"`);
    const span = a.label.length + 2;
    const choice: Record<string, unknown> = {
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    };
    if (a.probability !== undefined) {
      choice.logprobs = {
        content: [...content].map((token, i) => ({
          token,
          logprob: i >= at && i < at + span ? Math.log(a.probability!) / span : 0,
        })),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [choice],
        usage: { prompt_tokens: 120, completion_tokens: 6 },
      }),
    };
  };
  return { fetch, seen };
}

/** A change the rules cannot settle: new commits on main by someone else. */
export const COMMITS: Change = {
  gatherer: 'workspace',
  key: 'commits:main',
  summary: '3 new commits on main by Ana.',
  at: '2026-10-12T13:50:00Z',
  signal: 'commits',
};

/** A change about money. */
export const MONEY: Change = {
  gatherer: 'workspace',
  key: 'commits:billing',
  summary: 'A commit changed the billing page.',
  at: '2026-10-12T13:51:00Z',
  signal: 'commits',
  touches: ['money'],
};

/**
 * Triage deps whose decision model is the real bridge over a fake server, for
 * tests outside this directory (which may not import the decision port).
 *
 * @param answer - What the fake server answers.
 */
export function fakeTriageDeps(answer: FakeAnswer): TriageBeatDeps {
  const server = fakeChatServer(answer);
  let sent = 0;
  const counted: FetchLike = async (url, init) => {
    sent += 1;
    return server.fetch(url, init);
  };
  const model = createOpenAiCompatibleModel({
    baseUrl: 'http://credits.test/v1',
    model: 'small-1',
    fetch: counted,
    circuitBreaker: false,
  });
  return {
    creditsModel: async () => ({ model, requests: () => sent }),
    counter: createMemoryCallCounter(),
  };
}
