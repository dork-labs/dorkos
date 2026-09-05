/**
 * @vitest-environment node
 *
 * The compaction-model ladder (DOR-1668).
 *
 * These cases pin WHICH model DorkOS names when it compacts an OpenCode
 * session. They cannot pin the fact that `session.summarize` requires a body at
 * all — that is the shipped sidecar's rule, and only the live conformance arm
 * (`DORKOS_OPENCODE_LIVE=1`, `conformance.test.ts`) exercises a real one. The
 * requirement was read off `opencode-ai@1.18.15` itself, whose route declares
 * `payload: Struct({providerID, modelID, auto?})` with no `NoContent` arm.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { resolveCompactionModel } from '../messaging/compaction-model.js';
import { OC_SESSION_A, assistantMessage, userMessage } from './opencode-sse-fixtures.js';

/** The session's working directory — what rung 3 must scope its config read to. */
const SESSION_CWD = '/projects/alpha';

/** The common input: this session, in its own directory, with no DorkOS model set. */
const NO_MODEL = { ocSessionId: OC_SESSION_A, cwd: SESSION_CWD, trackedModel: undefined };

/**
 * A client stub carrying only the two reads the ladder makes.
 *
 * `session.messages` honors `limit` the way the sidecar does — verified live
 * against 1.18.15: it answers the NEWEST `limit` messages, ascending within
 * that window. A stub that ignored `limit` would let a windowed read that
 * truncates from the WRONG end pass, which is the whole risk of bounding it.
 */
function makeClient(options?: {
  messages?: Array<{ info: unknown; parts: unknown[] }>;
  config?: Record<string, unknown>;
}) {
  const all = options?.messages ?? [];
  return {
    session: {
      messages: vi.fn(async (request?: { query?: { limit?: number } }) => {
        const limit = request?.query?.limit;
        return { data: limit === undefined ? all : all.slice(Math.max(0, all.length - limit)) };
      }),
    },
    config: { get: vi.fn(async () => ({ data: options?.config ?? {} })) },
  };
}

/** Narrow the stub to the SDK client the resolver takes. */
function asClient(stub: ReturnType<typeof makeClient>): OpencodeClient {
  return stub as unknown as OpencodeClient;
}

describe('resolveCompactionModel', () => {
  it('prefers the session model DorkOS tracks, without reading the sidecar', async () => {
    const client = makeClient();

    const model = await resolveCompactionModel(asClient(client), {
      ocSessionId: OC_SESSION_A,
      cwd: SESSION_CWD,
      trackedModel: 'anthropic/claude-sonnet-4-5',
    });

    expect(model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
    // The operator's own pick settles it — a session with a model must never
    // cost a message-history fetch to compact.
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.config.get).not.toHaveBeenCalled();
  });

  it('splits a provider-qualified model on the FIRST slash, like the prompt path', async () => {
    const model = await resolveCompactionModel(asClient(makeClient()), {
      ocSessionId: OC_SESSION_A,
      cwd: SESSION_CWD,
      trackedModel: 'openrouter/qwen/qwen3.7-flash',
    });

    expect(model).toEqual({ providerID: 'openrouter', modelID: 'qwen/qwen3.7-flash' });
  });

  it('falls back to the model the session last ran on', async () => {
    // No DorkOS model: the honest answer is what the sidecar recorded, which is
    // also the rung OpenCode's own automatic compaction uses.
    const client = makeClient({
      messages: [
        { info: userMessage(OC_SESSION_A, 'msg_0000'), parts: [] },
        { info: assistantMessage(OC_SESSION_A, { completed: true }), parts: [] },
      ],
    });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' });
    expect(client.config.get).not.toHaveBeenCalled();
  });

  it('reads the LAST user message, not the first', async () => {
    const first = userMessage(OC_SESSION_A, 'msg_0000');
    const latest = {
      ...userMessage(OC_SESSION_A, 'msg_0002'),
      model: { providerID: 'ollama', modelID: 'qwen2.5-coder:32b' },
    };
    const client = makeClient({
      messages: [
        { info: first, parts: [] },
        { info: assistantMessage(OC_SESSION_A, { completed: true }), parts: [] },
        { info: latest, parts: [] },
      ],
    });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
  });

  it("scopes the config read to the SESSION'S directory, not the sidecar's own cwd", async () => {
    // The sidecar resolves config per directory and falls back to its OWN
    // process.cwd() when none is given — and it is spawned with no cwd of its
    // own, so an unscoped read answers with whatever project the DorkOS server
    // happens to sit in. Silently compacting on an unrelated project's model is
    // the failure this pins.
    const client = makeClient({ config: { model: 'ollama/qwen2.5-coder:32b' } });

    await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(client.config.get).toHaveBeenCalledWith({ query: { directory: SESSION_CWD } });
  });

  it('reads the tail of a long transcript, not the whole thing', async () => {
    // Compaction is for long sessions; pulling every message and every tool
    // output to read a model off the end is the expensive way to ask.
    const client = makeClient({
      messages: [
        // 60 messages of history nobody needs to read…
        ...Array.from({ length: 60 }, () => assistantMessage(OC_SESSION_A, { completed: true })),
        // …and the one at the end that actually holds the answer.
        {
          ...userMessage(OC_SESSION_A, 'msg_0099'),
          model: { providerID: 'ollama', modelID: 'qwen2.5-coder:32b' },
        },
      ].map((info) => ({ info, parts: [] })),
    });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: OC_SESSION_A },
      query: { limit: 10 },
    });
  });

  it('still finds a user message that sits behind a full window', async () => {
    // The bounded read is an optimization, never a change of answer: a tail of
    // nothing but assistant messages must fall back rather than descend to a
    // different model.
    const client = makeClient({
      messages: [
        {
          ...userMessage(OC_SESSION_A, 'msg_0000'),
          model: { providerID: 'ollama', modelID: 'qwen2.5-coder:32b' },
        },
        ...Array.from({ length: 30 }, () => assistantMessage(OC_SESSION_A, { completed: true })),
      ].map((info) => ({ info, parts: [] })),
      config: { model: 'anthropic/claude-sonnet-4-5' },
    });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
    expect(client.session.messages).toHaveBeenCalledTimes(2);
    expect(client.config.get).not.toHaveBeenCalled();
  });

  it('skips a user message that names no model, the way OpenCode does', async () => {
    // OpenCode's own resolver guards this field even though the schema calls it
    // required; a bare TypeError here would be a worse answer than descending.
    const modelless = { ...userMessage(OC_SESSION_A, 'msg_0001') } as Record<string, unknown>;
    delete modelless.model;
    const client = makeClient({
      messages: [
        {
          info: {
            ...userMessage(OC_SESSION_A, 'msg_0000'),
            model: { providerID: 'ollama', modelID: 'qwen2.5-coder:32b' },
          },
          parts: [],
        },
        { info: modelless, parts: [] },
      ],
    });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
  });

  it("falls back to the sidecar's configured default for a session that has not spoken", async () => {
    const client = makeClient({ config: { model: 'ollama/qwen2.5-coder:32b' } });

    const model = await resolveCompactionModel(asClient(client), NO_MODEL);

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
  });

  it('says what to do when nothing names a model, rather than guessing one', async () => {
    // Guessing out of the provider catalog would spend the user's money on a
    // model they never chose; the sidecar's own answer here is a bare 400.
    await expect(resolveCompactionModel(asClient(makeClient()), NO_MODEL)).rejects.toThrow(
      /Pick a model for the session/
    );
  });

  it('ignores an unparseable model string and keeps descending', async () => {
    // A bare model id with no provider cannot address an OpenCode model, so it
    // must not be forwarded as a half-filled body.
    const client = makeClient({ config: { model: 'ollama/qwen2.5-coder:32b' } });

    const model = await resolveCompactionModel(asClient(client), {
      ...NO_MODEL,
      trackedModel: 'claude-haiku-4-5',
    });

    expect(model).toEqual({ providerID: 'ollama', modelID: 'qwen2.5-coder:32b' });
  });
});
