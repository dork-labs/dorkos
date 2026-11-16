/**
 * GitHub Models calls spend money (DOR-4460). GitHub is not a pay-per-use
 * service, yet its model calls bill the account owner, and Composio tags them
 * `readOnlyHint`, so without a mark of their own a Read level covers them.
 */
import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../connector-schemas.js';
import { isPaidOperation } from '../paid-operations.js';

/**
 * Composio's own GitHub Models operations, with the tags it returned for them
 * (live tool list, 2026-11-15). Pinned here so a rename shows up as a red test.
 */
const GITHUB_MODELS_OPERATIONS = [
  {
    slug: 'GITHUB_CREATE_INFERENCE_CHAT_COMPLETIONS',
    tags: ['AI', 'inference', 'chat', 'readOnlyHint'],
    paid: true,
  },
  {
    slug: 'GITHUB_CREATE_INFERENCE_EMBEDDINGS',
    tags: ['AI', 'Embeddings', 'Models', 'readOnlyHint'],
    paid: true,
  },
  // Lists the model catalog. It runs no model, so it bills nothing.
  { slug: 'GITHUB_GET_CATALOG_MODELS', tags: ['readOnlyHint', 'idempotentHint'], paid: false },
] as const;

describe('GitHub Models calls', () => {
  it('pins how each GitHub Models operation is classed', () => {
    expect(
      GITHUB_MODELS_OPERATIONS.map(({ slug }) => ({
        slug,
        paid: isPaidOperation({ toolkit: 'github', operationSlug: slug }),
      }))
    ).toEqual(GITHUB_MODELS_OPERATIONS.map(({ slug, paid }) => ({ slug, paid })));
  });

  it('marks a model call paid however the provider writes the names', () => {
    expect(
      isPaidOperation({
        toolkit: 'GitHub',
        operationSlug: 'github_create_inference_chat_completions',
      })
    ).toBe(true);
  });

  it('leaves the rest of GitHub alone', () => {
    expect(isPaidOperation({ toolkit: 'github', operationSlug: 'GITHUB_LIST_ISSUES' })).toBe(false);
    expect(
      isPaidOperation({ toolkit: 'github', operationSlug: 'GITHUB_CREATE_AN_ISSUE_COMMENT' })
    ).toBe(false);
  });

  it('never puts a GitHub model call under Read or Read and write', () => {
    const candidates = [
      ...GITHUB_MODELS_OPERATIONS.map(({ slug }) => ({
        operationRevisionId: slug,
        toolkit: 'github',
        operationSlug: slug,
        capabilityClassification: 'read' as const,
        supported: true,
      })),
      {
        operationRevisionId: 'GITHUB_LIST_ISSUES',
        toolkit: 'github',
        operationSlug: 'GITHUB_LIST_ISSUES',
        capabilityClassification: 'read' as const,
        supported: true,
      },
    ];
    const free = ['GITHUB_GET_CATALOG_MODELS', 'GITHUB_LIST_ISSUES'];
    expect(accessLevelRevisionIds(candidates, 'read')).toEqual(free);
    expect(accessLevelRevisionIds(candidates, 'read-write')).toEqual(free);
  });
});
