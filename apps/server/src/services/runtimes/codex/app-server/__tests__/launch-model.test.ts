/** The real launch seam must correct unavailable account models before inference. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';

import { createTestDb } from '@dorkos/test-utils/db';
import { SessionEventStore } from '../../../../session/session-event-store.js';
import {
  setSessionEventStore,
  getOrCreateProjector,
  disposeProjector,
} from '../../../../session/session-state-projector.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { readLogBackedHistory } from '../../../../session/log-backed-history.js';

const harnesses: ReturnType<typeof makeAppServerHarness>[] = [];
function setup(options?: Parameters<typeof makeAppServerHarness>[0]) {
  const h = makeAppServerHarness(options);
  harnesses.push(h);
  const home = h.host.home(PERSON_HOME);
  home.config = { model: 'old-model', model_provider: 'openai' };
  home.modelList = () => ({ data: [row('available', true)], nextCursor: null });
  return { h, home };
}
function row(model: string, isDefault = false) {
  return { model, displayName: model, description: '', isDefault, supportedReasoningEfforts: [] };
}
const notices = (events: StreamEvent[]) =>
  events.filter((event) => event.type === 'model_substituted');
afterEach(async () => {
  disposeProjector('durable-launch');
  setSessionEventStore(undefined);
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

describe('the model a Codex turn actually starts on', () => {
  it.each([undefined, 'explicit-old'])(
    'replaces an unavailable %s choice on load and turn start',
    async (model) => {
      const { h, home } = setup();
      const events = await h.run(h.request({ sessionId: 'first', settings: { model } }));
      const process = home.processes[0]!;
      expect(process.requestsOf('config/read')[0]!).toMatchObject({ cwd: '/project' });
      expect(process.requestsOf('model/list')).toHaveLength(1);
      expect(process.requestsOf('thread/start')[0]!).toMatchObject({ model: 'available' });
      expect(process.requestsOf('turn/start')[0]!).toMatchObject({ model: 'available' });
      expect(notices(events)).toEqual([
        {
          type: 'model_substituted',
          data: {
            from: model ?? 'old-model',
            fromName: model ?? 'old-model',
            to: 'available',
            toName: 'available',
            reason: 'account-not-available',
          },
        },
      ]);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    }
  );

  it('persists the replacement and only announces the same replacement once', async () => {
    const { h, home } = setup();
    const remember = vi.fn().mockResolvedValue(undefined);
    const first = await h.run(h.request({ sessionId: 'repeated', onModelReplacement: remember }));
    const second = await h.run(
      h.request({
        sessionId: 'repeated',
        boundThreadId: h.bindings[0]!.threadId,
        onModelReplacement: remember,
      })
    );
    expect(remember.mock.calls).toEqual([['available'], ['available']]);
    expect(notices(first)).toHaveLength(1);
    expect(notices(second)).toHaveLength(0);
    expect(home.processes[0]!.requestsOf('turn/start').map((params) => params.model)).toEqual([
      'available',
      'available',
    ]);
    expect(home.processes[0]!.requestsOf('thread/start')).toHaveLength(1);
  });

  it('closes visibly without inference when saving the replacement cannot finish', async () => {
    const { h, home } = setup();
    const events = await h.run(
      h.request({
        sessionId: 'save-error',
        onModelReplacement: async () => {
          throw new Error('disk');
        },
      })
    );
    expect(home.processes[0]!.requestsOf('turn/start')).toEqual([]);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ code: 'codex_model_save_unavailable' }),
      }),
    ]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    const retry = await h.run(h.request({ sessionId: 'save-error' }));
    expect(retry.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('keeps a valid explicit model ahead of an unavailable config default', async () => {
    const { h, home } = setup();
    const events = await h.run(h.request({ sessionId: 'valid', settings: { model: 'available' } }));
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({ model: 'available' });
    expect(notices(events)).toEqual([]);
  });

  it('reads every page and uses only the marked default', async () => {
    const { h, home } = setup();
    home.modelList = (cursor) =>
      cursor === null
        ? { data: [row('first-row')], nextCursor: 'later' }
        : { data: [row('account-default', true)], nextCursor: null };
    await h.run(h.request({ sessionId: 'paged' }));
    expect(home.processes[0]!.requestsOf('model/list')).toHaveLength(2);
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({
      model: 'account-default',
    });
  });

  it.each(['empty', 'unmarked', 'throws', 'malformed', 'config-error'])(
    'does not guess when discovery is %s',
    async (kind) => {
      const { h, home } = setup();
      if (kind === 'config-error') home.configReadError = true;
      home.modelList = () => {
        if (kind === 'throws') throw new Error('unavailable');
        return kind === 'malformed'
          ? { data: [{}] }
          : { data: kind === 'unmarked' ? [row('first-row')] : [], nextCursor: null };
      };
      const events = await h.run(h.request({ sessionId: kind, settings: { model: 'chosen' } }));
      expect(home.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({ model: 'chosen' });
      expect(notices(events)).toEqual([]);
    }
  );

  it('preserves a custom service’s model even when OpenAI does not list it', async () => {
    const { h, home } = setup();
    home.config = { model: 'local-model', model_provider: 'local' };
    const events = await h.run(h.request({ sessionId: 'custom' }));
    expect(home.processes[0]!.requestsOf('model/list')).toHaveLength(0);
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).not.toHaveProperty('model');
    expect(notices(events)).toEqual([]);
  });
  it('uses the selected account’s own live default after an account switch', async () => {
    let selected = PERSON_HOME;
    const { h } = setup({ personHome: () => selected });
    await h.run(h.request({ sessionId: 'account-one' }));
    selected = '/fake/other/.codex';
    const second = h.host.home(selected);
    second.config = { model: 'other-old', model_provider: 'openai' };
    second.modelList = () => ({ data: [row('other-default', true)], nextCursor: null });
    const events = await h.run(h.request({ sessionId: 'account-two' }));
    expect(second.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({
      model: 'other-default',
    });
    expect(notices(events)[0]!.data).toMatchObject({
      from: 'other-old',
      to: 'other-default',
      reason: 'account-not-available',
    });
  });

  it('does not replace an overridden OpenAI endpoint’s model', async () => {
    const { h, home } = setup();
    Object.assign(home.config, { model_providers: { openai: { base_url: 'http://local/v1' } } });
    await h.run(h.request({ sessionId: 'custom-openai' }));
    expect(home.processes[0]!.requestsOf('model/list')).toEqual([]);
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).not.toHaveProperty('model');
  });

  it('stops during discovery before loading or starting inference', async () => {
    const { h, home } = setup();
    const controller = new AbortController();
    home.modelList = () => {
      controller.abort();
      return { data: [row('available', true)], nextCursor: null };
    };
    const events = await h.run(
      h.request({ sessionId: 'stopped-discovery', signal: controller.signal })
    );
    expect(home.processes[0]!.requestsOf('model/list')).toHaveLength(1);
    expect(home.processes[0]!.requestsOf('thread/start')).toEqual([]);
    expect(home.processes[0]!.requestsOf('turn/start')).toEqual([]);
    expect(events).toEqual([{ type: 'done', data: { sessionId: 'stopped-discovery' } }]);
  });

  it('keeps a typed visible model error when account discovery is unavailable', async () => {
    const { h, home } = setup();
    home.modelList = () => {
      throw new Error('unknown catalog');
    };
    home.nextTurn((ctx) =>
      ctx.complete('failed', {
        message: "The 'chosen' model is not supported when using Codex with a ChatGPT account.",
      })
    );
    const events = await h.run(
      h.request({ sessionId: 'typed-error', settings: { model: 'chosen' } })
    );
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({ model: 'chosen' });
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'model_unavailable',
          message: expect.stringContaining('Choose another model'),
        }),
      }),
    ]);
    expect(notices(events)).toEqual([]);
  });
  it('selects the marked default with no configured choice, without a replacement notice', async () => {
    const { h, home } = setup();
    home.config = {};
    const events = await h.run(h.request({ sessionId: 'no-choice' }));
    expect(home.processes[0]!.requestsOf('thread/start')[0]!).toMatchObject({ model: 'available' });
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).toMatchObject({ model: 'available' });
    expect(notices(events)).toEqual([]);
  });

  it('does not swap a config model already on the account list', async () => {
    const { h, home } = setup();
    home.config.model = 'available';
    const remember = vi.fn();
    const events = await h.run(
      h.request({ sessionId: 'config-valid', onModelReplacement: remember })
    );
    expect(home.processes[0]!.requestsOf('model/list')).toHaveLength(1);
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).not.toHaveProperty('model');
    expect(notices(events)).toEqual([]);
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(['thread/start', 'turn/start'])(
    'keeps a typed model recovery when %s rejects the chosen model',
    async (phase) => {
      const { h, home } = setup();
      home.modelList = () => {
        throw new Error('unknown catalog');
      };
      const error = "The 'chosen' model is not supported when using Codex with a ChatGPT account.";
      if (phase === 'thread/start') home.threadStartError = error;
      else home.turnStartError = error;
      const events = await h.run(
        h.request({ sessionId: 'rpc-model-error', settings: { model: 'chosen' } })
      );
      expect(home.processes[0]!.requestsOf(phase)).toHaveLength(1);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            category: 'model_unavailable',
            message: expect.stringContaining('Choose another model'),
          }),
        }),
      ]);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    }
  );
  it('treats malformed config as unknown, rather than proof a model is unavailable', async () => {
    const { h, home } = setup();
    Object.assign(home.config, { model: 42 });
    const events = await h.run(h.request({ sessionId: 'malformed-config' }));
    expect(home.processes[0]!.requestsOf('model/list')).toEqual([]);
    expect(home.processes[0]!.requestsOf('turn/start')[0]!).not.toHaveProperty('model');
    expect(notices(events)).toEqual([]);
  });
  it('records the actual launch explanation eagerly and reopens it from durable history after text', async () => {
    const { h } = setup();
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    const projector = getOrCreateProjector('durable-launch', undefined, { persist: 'history' });
    const request = h.request({ sessionId: 'durable-launch' });
    async function* observed() {
      for await (const event of h.transport.runTurn(request)) {
        yield event;
        if (event.type === 'model_substituted')
          expect(store.readModelSubstitutions('durable-launch')).toHaveLength(1);
      }
    }
    await feedProjector(projector, observed(), { userMessage: 'hello' });
    expect(
      store.readAll('durable-launch').filter((event) => event.type === 'model_substituted')
    ).toEqual([
      expect.objectContaining({
        from: 'old-model',
        to: 'available',
        reason: 'account-not-available',
      }),
    ]);
    disposeProjector('durable-launch');
    const history = readLogBackedHistory('durable-launch');
    expect(
      history
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === 'model_substituted')
    ).toEqual([
      {
        type: 'model_substituted',
        from: 'old-model',
        fromName: 'old-model',
        to: 'available',
        toName: 'available',
        reason: 'account-not-available',
      },
    ]);
    expect(history.some((message) => message.content === 'pong')).toBe(true);
    const reopened = getOrCreateProjector('durable-launch', undefined, { persist: 'history' });
    expect(
      reopened.replayFrom(0).filter((event) => event.type === 'model_substituted')
    ).toHaveLength(1);
  });
});
