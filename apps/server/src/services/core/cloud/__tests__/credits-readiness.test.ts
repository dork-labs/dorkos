/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import type { InferenceModel, InferenceToken } from '@dork-labs/cloud-api';

vi.mock('../../config-manager.js', () => ({ configManager: { get: vi.fn(), onChange: vi.fn() } }));

import {
  __resetCreditsReadinessForTests,
  creditsReadinessWith,
  readinessFrom,
  type CreditsReadinessDeps,
  type CreditsReadinessFacts,
} from '../credits-readiness.js';

/** A token that serves only the Anthropic format, as every service before `served` did. */
const TOKEN = {
  ...tokenFixture,
  served: ['anthropicMessages'],
} as unknown as InferenceToken;

/** A model the service suggests starting with in the Anthropic format. */
const RECOMMENDED = {
  id: 'model-a',
  displayName: 'Model A',
  protocols: ['anthropicMessages'],
  recommendedOn: ['anthropicMessages'],
} as unknown as InferenceModel;

/** Facts for a linked computer with nothing held yet; each test changes one. */
function facts(over: Partial<CreditsReadinessFacts> = {}): CreditsReadinessFacts {
  return {
    linked: () => true,
    token: () => null,
    models: () => [],
    mintRefusal: () => null,
    paymentMethodOnFile: () => undefined,
    awaitingFirstRunChoice: () => false,
    ...over,
  };
}

const ready = { token: () => TOKEN, models: () => [RECOMMENDED] };

describe('readinessFrom', () => {
  it('is unlinked before a link', () => {
    expect(readinessFrom(facts({ linked: () => false, ...ready }))).toBe('unlinked');
  });

  it('is linked while minting, or before the models list was read', () => {
    expect(readinessFrom(facts())).toBe('linked');
    expect(readinessFrom(facts({ token: () => TOKEN }))).toBe('linked');
  });

  it('is linked when the list names no model to start with in a format the token serves', () => {
    const unrecommended = { ...RECOMMENDED, recommendedOn: [] } as unknown as InferenceModel;
    expect(readinessFrom(facts({ token: () => TOKEN, models: () => [unrecommended] }))).toBe(
      'linked'
    );
    const otherFormat = {
      ...RECOMMENDED,
      recommendedOn: ['openaiResponses'],
    } as unknown as InferenceModel;
    expect(readinessFrom(facts({ token: () => TOKEN, models: () => [otherFormat] }))).toBe(
      'linked'
    );
  });

  it('is ready with a token serving a format the DorkOS runtime speaks and a model for it', () => {
    expect(readinessFrom(facts(ready))).toBe('ready');
  });

  it('waits for the new link to record the first run’s credits pick', () => {
    expect(readinessFrom(facts({ ...ready, awaitingFirstRunChoice: () => true }))).toBe('linked');
  });

  it('needs a card only when the service says there is none', () => {
    expect(readinessFrom(facts({ paymentMethodOnFile: () => false }))).toBe('needs-card');
    // Unknown never blocks: readiness follows the token and the list.
    expect(readinessFrom(facts({ ...ready, paymentMethodOnFile: () => undefined }))).toBe('ready');
    expect(readinessFrom(facts({ ...ready, paymentMethodOnFile: () => true }))).toBe('ready');
  });

  it('is refused when minting answered entitlement_required, and only then', () => {
    expect(readinessFrom(facts({ mintRefusal: () => 'entitlement_required' }))).toBe('refused');
    expect(readinessFrom(facts({ mintRefusal: () => 'rate_limited' }))).toBe('linked');
  });
});

describe('creditsReadinessWith', () => {
  /** Deps for a linked computer in an open first run; each test changes one. */
  function deps(over: Partial<CreditsReadinessDeps> = {}) {
    let clock = 1_000_000;
    const d: CreditsReadinessDeps & { tick: (ms: number) => void } = {
      facts: {
        linked: () => true,
        token: () => null,
        models: () => [],
        mintRefusal: () => null,
        awaitingFirstRunChoice: () => false,
      },
      linkKey: () => 'link-A',
      firstRunOpen: () => true,
      readCatalog: vi.fn(async () => null),
      readCardOnFile: vi.fn(async () => false),
      now: () => clock,
      tick: (ms) => {
        clock += ms;
      },
      ...over,
    };
    return d;
  }

  beforeEach(() => {
    __resetCreditsReadinessForTests();
  });

  it('reads in the background at most once per window, and the next poll sees it', async () => {
    const d = deps();
    expect(creditsReadinessWith(d)).toBe('linked');
    expect(creditsReadinessWith(d)).toBe('linked');
    await vi.waitFor(() => expect(d.readCardOnFile).toHaveBeenCalledTimes(1));
    // The card fact the read brought back answers the next poll.
    await vi.waitFor(() => expect(creditsReadinessWith(d)).toBe('needs-card'));
    expect(d.readCardOnFile).toHaveBeenCalledTimes(1);
    // Let the finished read settle, then pass the window.
    await new Promise((resolve) => setTimeout(resolve, 0));
    creditsReadinessWith(d);
    expect(d.readCardOnFile).toHaveBeenCalledTimes(1);
    d.tick(10_001);
    creditsReadinessWith(d);
    await vi.waitFor(() => expect(d.readCardOnFile).toHaveBeenCalledTimes(2));
  });

  it('forgets the card fact on unlink and on a link to another account', async () => {
    let key: string | null = 'link-A';
    const d = deps({ linkKey: () => key });
    creditsReadinessWith(d);
    await vi.waitFor(() => expect(creditsReadinessWith(d)).toBe('needs-card'));
    key = null;
    expect(creditsReadinessWith(d)).toBe('unlinked');
    key = 'link-B';
    d.readCardOnFile = vi.fn(async () => undefined);
    // Another account: no "add a card" carried over from the first one.
    expect(creditsReadinessWith(d)).toBe('linked');
  });

  it('starts no background read once the first run is finished or dismissed', async () => {
    const d = deps({ firstRunOpen: () => false });
    creditsReadinessWith(d);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.readCatalog).not.toHaveBeenCalled();
    expect(d.readCardOnFile).not.toHaveBeenCalled();
  });

  it('waits on the first run’s credits pick even with token and list ready', () => {
    const d = deps({
      facts: { ...deps().facts, ...ready, awaitingFirstRunChoice: () => true },
    });
    expect(creditsReadinessWith(d)).toBe('linked');
  });
});
