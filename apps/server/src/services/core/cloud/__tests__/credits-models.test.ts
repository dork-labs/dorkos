/**
 * The models a runtime on DorkOS credits may offer: the service's list,
 * filtered by the protocol the runtime speaks, only once the service says which
 * protocols its models are on, with the last good list standing in (across a
 * restart) when the service cannot be read (DOR-2636).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import modelsFixture from '@dork-labs/cloud-api/fixtures/v1/inference/models.json' with { type: 'json' };
import { InferenceModelsResponseSchema, type InferenceModel } from '@dork-labs/cloud-api';
import { createCloudApiClient } from '@dork-labs/cloud-api/client';
import type { CloudV1Context } from '../v1-client.js';

const cloud = vi.hoisted(() => ({
  context: null as CloudV1Context | null,
  token: 'link-A' as string | null,
}));
vi.mock('../v1-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../v1-client.js')>()),
  captureCloudV1Context: () => cloud.context,
  readCloudInstanceToken: () => cloud.token,
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetCreditsModelsForTests,
  creditsLinkKey,
  creditsMenuFor,
  creditsModelOptions,
  judgeCreditsModel,
  readCreditsCatalogWithContext,
  resolveCreditsLaunchModel,
} from '../credits-models.js';

const CLAUDE = { credits: { protocol: 'anthropic-messages' as const } };

function model(id: string, extra: Partial<InferenceModel> = {}): InferenceModel {
  return {
    id,
    displayName: `Name of ${id}`,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supports: { tools: true, promptCaching: true, streaming: true, thinking: true },
    ...extra,
  };
}

/** A fake service: answers `GET /v1/inference/models` with `respond`, counting calls. */
function fakeCloud(respond: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: string) => {
    expect(new URL(input).pathname).toBe('/v1/inference/models');
    return respond();
  });
  let current = true;
  const context: CloudV1Context = {
    client: createCloudApiClient({ baseUrl: 'https://cloud.example.invalid', token: 'ik', fetch }),
    isCurrent: () => current,
  };
  return {
    fetch,
    context,
    relink: () => {
      current = false;
    },
  };
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const LIST = {
  catalogVersion: 'cv_1',
  models: [
    model('md_gpt_like', { protocols: ['openai-chat'], recommendedOn: ['openai-chat'] }),
    model('md_both', { protocols: ['openai-chat', 'anthropic-messages'] }),
    model('md_claude_pick', {
      protocols: ['anthropic-messages'],
      recommendedOn: ['anthropic-messages'],
      displayName: 'The service’s own name',
    }),
    model('md_unsaid'),
    model('md_later', { protocols: ['a-protocol-added-later'] }),
  ],
};

let store: string;
beforeEach(() => {
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credits-models-')), 'list.json');
  __resetCreditsModelsForTests({ storePath: store });
  cloud.context = null;
  cloud.token = 'link-A';
});
afterEach(() => {
  fs.rmSync(path.dirname(store), { recursive: true, force: true });
});

/** A restart: memory is gone, the kept list on disk is not. */
function restart(clock?: () => number): void {
  __resetCreditsModelsForTests({ storePath: store, ...(clock ? { now: clock } : {}) });
}

describe('the menu a runtime on credits offers', () => {
  it('keeps only the models offered on the runtime’s protocol, the service’s pick first', () => {
    const options = creditsModelOptions(LIST.models, 'anthropic-messages');
    // No model offered only on another protocol (no GPT in Claude Code), none
    // the service said nothing about, none on a protocol it does not know.
    expect(options.map((option) => option.value)).toEqual(['md_claude_pick', 'md_both']);
    expect(options[0]).toMatchObject({
      displayName: 'The service’s own name',
      isDefault: true,
      contextWindow: 200_000,
    });
    expect(options[1]?.isDefault).toBeUndefined();
  });

  it('marks nothing as the default when the service suggests nothing for the protocol', () => {
    const options = creditsModelOptions(
      [model('md_a', { protocols: ['anthropic-messages'], recommendedOn: ['openai-chat'] })],
      'anthropic-messages'
    );
    expect(options).toHaveLength(1);
    expect(options[0]?.isDefault).toBeUndefined();
  });

  it('says so on a model the service says cannot use tools', () => {
    const options = creditsModelOptions(
      [
        model('md_chat_only', {
          protocols: ['anthropic-messages'],
          supports: { tools: false, promptCaching: false, streaming: true, thinking: false },
        }),
      ],
      'anthropic-messages'
    );
    expect(options[0]?.supportsToolUse).toBe(false);
  });

  it('reads the published example list the same way', () => {
    const fixture = InferenceModelsResponseSchema.parse(modelsFixture);
    expect(
      creditsModelOptions(fixture.models, 'anthropic-messages').map((option) => option.value)
    ).toEqual(['md_opaque_0001']);
  });
});

const KEY_A = creditsLinkKey('link-A');

describe('reading the service’s list', () => {
  it('reads it once and reuses it while the link stands', async () => {
    const service = fakeCloud(() => answer(LIST));
    const first = await readCreditsCatalogWithContext(false, service.context, KEY_A);
    const second = await readCreditsCatalogWithContext(false, service.context, KEY_A);
    expect(first?.fresh).toBe(true);
    expect(first?.models.map((entry) => entry.id)).toContain('md_claude_pick');
    expect(second?.models).toBe(first?.models);
    expect(service.fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again once the link changed', async () => {
    const service = fakeCloud(() => answer(LIST));
    await readCreditsCatalogWithContext(false, service.context, KEY_A);
    service.relink();
    const next = fakeCloud(() => answer(LIST));
    await readCreditsCatalogWithContext(false, next.context, KEY_A);
    expect(next.fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again once the list is older than the reuse window', async () => {
    let clock = 0;
    restart(() => clock);
    const service = fakeCloud(() => answer(LIST));
    await readCreditsCatalogWithContext(false, service.context, KEY_A);
    clock += 6 * 60_000;
    await readCreditsCatalogWithContext(false, service.context, KEY_A);
    expect(service.fetch).toHaveBeenCalledTimes(2);
  });

  it('has no list while unlinked or switched off, and asks nothing', async () => {
    const service = fakeCloud(() => answer(LIST));
    expect(await readCreditsCatalogWithContext(false, null, null)).toBeNull();
    expect(await readCreditsCatalogWithContext(true, service.context, KEY_A)).toBeNull();
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it('has no list when nothing was ever kept and the service refuses or answers nonsense', async () => {
    const refused = fakeCloud(() =>
      answer({ type: 'about:blank', title: 'No', status: 503, code: 'unavailable' }, 503)
    );
    expect(await readCreditsCatalogWithContext(false, refused.context, KEY_A)).toBeNull();
    const nonsense = fakeCloud(() => answer({ models: 'not a list' }));
    expect(await readCreditsCatalogWithContext(false, nonsense.context, KEY_A)).toBeNull();
  });

  it('answers the last good list, marked out of date, when a later read fails', async () => {
    let clock = 0;
    restart(() => clock);
    let healthy = true;
    const service = fakeCloud(() => (healthy ? answer(LIST) : answer({}, 500)));
    await readCreditsCatalogWithContext(false, service.context, KEY_A);
    healthy = false;
    clock += 6 * 60_000;
    const read = await readCreditsCatalogWithContext(false, service.context, KEY_A);
    expect(read?.fresh).toBe(false);
    expect(read?.models.map((entry) => entry.id)).toContain('md_claude_pick');
  });

  it('keeps the last good list across a restart, for the same link only', async () => {
    await readCreditsCatalogWithContext(false, fakeCloud(() => answer(LIST)).context, KEY_A);
    restart();
    const down = fakeCloud(() => answer({}, 500));
    const read = await readCreditsCatalogWithContext(false, down.context, KEY_A);
    expect(read?.fresh).toBe(false);
    expect(read?.models.map((entry) => entry.id)).toContain('md_claude_pick');
    // Another link (another account) never reads this one's list.
    restart();
    expect(
      await readCreditsCatalogWithContext(false, down.context, creditsLinkKey('link-B'))
    ).toBeNull();
    // And the credential itself is never what is kept.
    expect(fs.readFileSync(store, 'utf8')).not.toContain('link-A');
  });

  it('answers nothing for a list read under a link that moved mid-read', async () => {
    const moving = fakeCloud(() => {
      moving.relink();
      return answer(LIST);
    });
    expect(await readCreditsCatalogWithContext(false, moving.context, KEY_A)).toBeNull();
  });
});

/** The list a service older than the `protocols` field answers: no protocol said. */
const OLD_LIST = {
  catalogVersion: 'cv_0',
  models: [model('md_one'), model('md_two')],
};

describe('a runtime on credits, end to end against the fake service', () => {
  it('lists, suggests and accepts only what credits serve on its protocol, once the service says', async () => {
    cloud.context = fakeCloud(() => answer(LIST)).context;
    const menu = await creditsMenuFor(CLAUDE);
    expect(menu.kind === 'filtered' && menu.models.map((option) => option.value)).toEqual([
      'md_claude_pick',
      'md_both',
    ]);
    expect(menu.kind === 'filtered' && menu.outOfDate).toBe(false);
    expect(await judgeCreditsModel(CLAUDE, 'md_both')).toEqual({ judged: true, refusal: null });
    expect(await judgeCreditsModel(CLAUDE, 'md_gpt_like')).toEqual({
      judged: true,
      refusal: 'DorkOS credits don’t cover that model. Pick one from the model menu.',
    });
    expect((await judgeCreditsModel(CLAUDE, 'claude-opus-4-6')).judged).toBe(true);
  });

  it('accepts an alias whose resolved id credits serve', async () => {
    cloud.context = fakeCloud(() => answer(LIST)).context;
    expect(await judgeCreditsModel(CLAUDE, 'sonnet', 'md_both')).toEqual({
      judged: true,
      refusal: null,
    });
    expect(await resolveCreditsLaunchModel(CLAUDE, 'sonnet', 'md_both')).toEqual({
      kind: 'as-named',
      model: 'sonnet',
    });
  });

  it('changes nothing while the service says nothing about protocols', async () => {
    cloud.context = fakeCloud(() => answer(OLD_LIST)).context;
    expect(await creditsMenuFor(CLAUDE)).toEqual({ kind: 'unfiltered' });
    expect(await judgeCreditsModel(CLAUDE, 'claude-opus-4-6')).toEqual({ judged: false });
    expect(await resolveCreditsLaunchModel(CLAUDE, undefined)).toEqual({
      kind: 'as-named',
      model: undefined,
    });
    expect(await resolveCreditsLaunchModel(CLAUDE, 'opus')).toEqual({
      kind: 'as-named',
      model: 'opus',
    });
  });

  it('changes nothing when the list cannot be read and none was ever kept', async () => {
    cloud.context = fakeCloud(() => answer({}, 500)).context;
    expect(await creditsMenuFor(CLAUDE)).toEqual({ kind: 'unfiltered' });
    expect(await judgeCreditsModel(CLAUDE, 'opus')).toEqual({ judged: false });
  });

  it('keeps judging from the last good list, out of date, after an outage and a restart', async () => {
    cloud.context = fakeCloud(() => answer(LIST)).context;
    await creditsMenuFor(CLAUDE);
    restart();
    cloud.context = fakeCloud(() => answer({}, 500)).context;
    const menu = await creditsMenuFor(CLAUDE);
    expect(menu.kind).toBe('filtered');
    expect(menu.kind === 'filtered' && menu.outOfDate).toBe(true);
    expect(menu.kind === 'filtered' && menu.models[0]?.creditsListOutOfDate).toBe(true);
    expect((await judgeCreditsModel(CLAUDE, 'md_gpt_like')).judged).toBe(true);
  });

  it('launches a model credits serve: the suggestion for none, and in place of one not served', async () => {
    cloud.context = fakeCloud(() => answer(LIST)).context;
    expect(await resolveCreditsLaunchModel(CLAUDE, undefined)).toEqual({
      kind: 'suggested',
      model: 'md_claude_pick',
    });
    expect(await resolveCreditsLaunchModel(CLAUDE, 'md_both')).toEqual({
      kind: 'as-named',
      model: 'md_both',
    });
    expect(await resolveCreditsLaunchModel(CLAUDE, 'opus', 'claude-opus-4-6')).toEqual({
      kind: 'replaced',
      model: 'md_claude_pick',
      from: 'opus',
      toName: 'The service’s own name',
    });
  });

  it('says none is served when the service names protocols but none for this runtime', async () => {
    cloud.context = fakeCloud(() =>
      answer({ catalogVersion: 'cv', models: [model('md_gpt', { protocols: ['openai-chat'] })] })
    ).context;
    expect(await resolveCreditsLaunchModel(CLAUDE, 'opus')).toEqual({ kind: 'none-served' });
  });

  it('offers nothing on credits to a runtime that declares no credits protocol', async () => {
    const service = fakeCloud(() => answer(LIST));
    cloud.context = service.context;
    expect(await creditsMenuFor({})).toEqual({ kind: 'unfiltered' });
    expect(service.fetch).not.toHaveBeenCalled();
  });
});
