/**
 * The checkbox write service fixture for these suites, with each fixture's cleanup run after
 * every test (the crash-worker suite keeps its own, which drains workers first).
 */
import { afterEach } from 'vitest';
import { fixture as makeFixture } from '../checkbox-fixture.js';
import type { CheckboxServiceOptions } from '../../checkbox-service.js';

/** Cleanups the suites register beside the fixture's own; all run after each test. */
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
});

/** A fresh checkbox write service over a temporary document, cleaned up after the test. */
export async function fixture(options: CheckboxServiceOptions = {}) {
  const h = await makeFixture(options);
  cleanups.push(h.cleanup);
  return h;
}
