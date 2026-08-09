/**
 * The build budget: the whole panel, for a thirty-two agent fleet, in under
 * 5ms (spec §I).
 *
 * A ceiling that fails rather than a number that gets logged. The target is
 * 2ms; 5ms is where a person starts to feel a sidebar rebuild in a keystroke.
 *
 * @module features/dashboard-sidebar/model/__tests__/build-sidebar-model.performance
 */
import { describe, expect, it } from 'vitest';
import { buildSidebarModel } from '../build-sidebar-model';
import { powerFixture } from '../fixtures';

/** The ceiling. Above this the design's central performance claim is false. */
const BUILD_BUDGET_MS = 5;

/** How many builds the median is taken over. */
const RUNS = 25;

describe('performance', () => {
  it(`builds the power fixture in under ${BUILD_BUDGET_MS}ms`, () => {
    // Warm the JIT first: the first call through a cold path is not what a
    // user's second keystroke costs, and measuring it would make the budget
    // a test of module loading.
    buildSidebarModel(powerFixture);

    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      buildSidebarModel(powerFixture);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThan(BUILD_BUDGET_MS);
  });

  it('is the fleet it claims to be', () => {
    // A budget met by a small fixture proves nothing.
    expect(powerFixture.agents.length).toBeGreaterThanOrEqual(30);
    expect(powerFixture.rooms.length).toBeGreaterThanOrEqual(60);
    expect(powerFixture.sessions.length).toBeGreaterThanOrEqual(40);
  });
});
