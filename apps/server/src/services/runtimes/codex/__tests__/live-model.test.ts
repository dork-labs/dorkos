/**
 * The live arm runs on the account's own default model, never on whatever the
 * person's `~/.codex/config.toml` names (measured: a ChatGPT sign-in whose
 * config named a model it cannot use failed every live turn on both
 * transports). Free: a stub runtime, no Codex.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ModelOption, StreamEvent } from '@dorkos/shared/types';
import { accountDefaultModel, onModel } from './live-model.js';

const option = (value: string, isDefault = false) =>
  ({ value, displayName: value, description: '', isDefault }) as unknown as ModelOption;

function stub(models: ModelOption[]) {
  const sent: Array<{ model?: string }> = [];
  const runtime = {
    getSupportedModels: async () => models,
    async *sendMessage(_id: string, _content: string, opts?: { model?: string }) {
      sent.push({ ...(opts?.model !== undefined ? { model: opts.model } : {}) });
      yield { type: 'done', data: { sessionId: _id } } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return { runtime, sent };
}

async function drain(gen: AsyncGenerator<StreamEvent>) {
  for await (const _ of gen) void _;
}

describe('the model a live Codex run uses', () => {
  it('is the model Codex marks default for the account, else its first', async () => {
    expect(await accountDefaultModel(stub([option('a'), option('b', true)]).runtime)).toBe('b');
    expect(await accountDefaultModel(stub([option('a'), option('c')]).runtime)).toBe('a');
    expect(await accountDefaultModel(stub([]).runtime)).toBeUndefined();
  });

  it('rides every turn unless the caller chose a model, and changes nothing without one', async () => {
    const pinned = stub([]);
    onModel(pinned.runtime, 'gpt-default');
    await drain(pinned.runtime.sendMessage('s', 'hi'));
    await drain(pinned.runtime.sendMessage('s', 'hi', { model: 'chosen' }));
    expect(pinned.sent).toEqual([{ model: 'gpt-default' }, { model: 'chosen' }]);

    const untouched = stub([]);
    onModel(untouched.runtime, undefined);
    await drain(untouched.runtime.sendMessage('s', 'hi'));
    expect(untouched.sent).toEqual([{}]);
  });
});
