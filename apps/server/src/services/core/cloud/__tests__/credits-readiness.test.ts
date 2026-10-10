/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import type { InferenceModel, InferenceToken } from '@dork-labs/cloud-api';

vi.mock('../../config-manager.js', () => ({ configManager: { get: vi.fn(), onChange: vi.fn() } }));

import { readinessFrom, type CreditsReadinessFacts } from '../credits-readiness.js';

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
