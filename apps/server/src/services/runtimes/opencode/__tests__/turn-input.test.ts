/**
 * @vitest-environment node
 *
 * How a DorkOS `provider/model` string becomes OpenCode's `{providerID, modelID}`.
 *
 * The rule is one line of code and it is the whole reason a pinned OpenRouter
 * model has to be spelled with THREE segments. Nothing pinned it until the
 * `real-provider` eval tier needed it to be true (`packages/evals/src/types.ts`,
 * `DEFAULT_OPENROUTER_MODEL`), and a mis-spelling fails far from the typo — the
 * sidecar simply reports a model it cannot reach, which reads like an outage.
 */
import { describe, it, expect } from 'vitest';
import { parseModelSelection } from '../turn-input.js';

describe('parseModelSelection', () => {
  it('splits an OpenRouter pin on the FIRST slash, leaving the vendor path in the model id', () => {
    // The exact value `packages/evals` pins for its `real-provider` tier, and the
    // exact value the live run of 2026-09-01 reported back on `status_change`.
    expect(parseModelSelection('openrouter/qwen/qwen3.7-flash')).toEqual({
      providerID: 'openrouter',
      modelID: 'qwen/qwen3.7-flash',
    });
  });

  it('reads the two plausible mis-spellings of that pin as different things entirely', () => {
    // Neither is an error, which is why this needs a test rather than a type: both
    // parse cleanly into a provider that does not exist, or a model that does not.
    expect(parseModelSelection('qwen/qwen3.7-flash')).toEqual({
      providerID: 'qwen',
      modelID: 'qwen3.7-flash',
    });
    expect(parseModelSelection('openrouter/qwen3.7-flash')).toEqual({
      providerID: 'openrouter',
      modelID: 'qwen3.7-flash',
    });
  });

  it('reports nothing for a value it cannot split into two non-empty halves', () => {
    // Undefined means "send no model and let the sidecar choose", so these must
    // not silently become a `{providerID: '', modelID: …}` nobody can serve.
    expect(parseModelSelection(undefined)).toBeUndefined();
    expect(parseModelSelection('claude-haiku-4-5')).toBeUndefined();
    expect(parseModelSelection('/leading')).toBeUndefined();
    expect(parseModelSelection('trailing/')).toBeUndefined();
  });
});
