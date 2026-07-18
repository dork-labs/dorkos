/**
 * The Phase 1 harness self-test: a structural (no-drive) `test-mode` case that
 * proves the runner plumbing end-to-end — seed a sandbox, boot the in-process
 * server, assert `GET /api/health` is 200, write a transcript + result. It runs
 * green with no model and no cost, and stands in for real product evals until
 * the credentialed tiers and the structural suite land (Phases 2–3).
 *
 * @module evals/suite/selftest
 */
import type { EvalCase } from '../types.js';
import { httpGetAssert } from '../oracles/api.js';

/** The harness self-test case — boots the server and asserts it is healthy. */
export const selfTestCase: EvalCase = {
  id: 'harness-selftest',
  title: 'Harness self-test — boot the in-process server and assert health',
  // Empty prompt marks a structural case: the runner boots + asserts without
  // driving a turn (the in-process server registers no runtime in Phase 1).
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['smoke'],
  oracles: [
    httpGetAssert(
      '/api/health',
      { status: 200, body: (b) => (b as { status?: string }).status === 'ok' },
      'server booted and healthy'
    ),
  ],
};
