/**
 * The validator's contract is that it agrees with the scheduler: anything it
 * accepts, `registerTask` must be able to schedule, and anything it rejects must
 * be something croner genuinely refuses. The last case here holds both sides to
 * that, so the two cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import { describeScheduleProblem } from '../cron-validation.js';

describe('describeScheduleProblem', () => {
  describe('accepts', () => {
    it.each([
      ['a plain five-field cron', '0 9 * * *', undefined],
      ['a real timezone', '0 9 * * *', 'America/New_York'],
      // A well-formed pattern that never matches is how you write a task that
      // only runs by hand; `apps/e2e` builds its fixtures on `NEVER_FIRES_CRON`.
      ['February 31st, the never-fire idiom', '0 0 31 2 *', 'UTC'],
    ])('%s', (_label, cron, timezone) => {
      expect(describeScheduleProblem(cron, timezone)).toBeNull();
    });

    it('an on-demand task, which has no cron at all', () => {
      expect(describeScheduleProblem(null, null)).toBeNull();
      expect(describeScheduleProblem(undefined, undefined)).toBeNull();
      expect(describeScheduleProblem('', null)).toBeNull();
    });
  });

  describe('refuses', () => {
    it('a cron that is not a cron', () => {
      const problem = describeScheduleProblem('banana', null);
      expect(problem).toContain('banana');
      expect(problem).toContain('0 9 * * *');
    });

    it('a timezone that does not exist', () => {
      const problem = describeScheduleProblem('0 9 * * *', 'Mars/Phobos');
      expect(problem).toContain('Mars/Phobos');
      expect(problem).toContain('IANA');
    });
  });

  // The drift guard. `registerTask` builds `new Cron(pattern, { timezone }, fn)`,
  // which is the only judgement that matters; this asserts the validator gives
  // the same verdict for every case above, so a croner upgrade that changes what
  // is acceptable cannot leave the API and the scheduler disagreeing.
  //
  // The shared verdict is "does croner THROW", not "does it produce a next run".
  // Those two came apart on a schedule that never fires: croner builds and holds
  // it happily and simply reports `null` forever, and refusing it broke the
  // browser suite, whose task fixtures are built on exactly that (DOR e2e
  // `NEVER_FIRES_CRON`). Keying this guard on the throw is what keeps the two
  // layers agreeing about a case that is legal on both sides.
  describe('agrees with what croner will actually accept', () => {
    const cases: Array<[string | null, string | null]> = [
      ['0 9 * * *', null],
      ['*/10 * * * *', 'Europe/London'],
      ['0 0 31 2 *', 'UTC'],
      ['banana', null],
      ['99 * * * *', null],
      ['0 9 * * *', 'Mars/Phobos'],
    ];

    it.each(cases)('cron %s / timezone %s', (cron, timezone) => {
      const rejected = describeScheduleProblem(cron, timezone) !== null;

      let schedulerRefuses: boolean;
      let job: Cron | undefined;
      try {
        // The same construction the scheduler performs, handler and all. With a
        // handler croner schedules immediately, so a bad timezone throws here
        // rather than on a later read.
        job = new Cron(cron!, { protect: true, timezone: timezone ?? undefined }, () => {});
        job.nextRun();
        schedulerRefuses = false;
      } catch {
        schedulerRefuses = true;
      } finally {
        job?.stop();
      }

      expect(rejected).toBe(schedulerRefuses);
    });
  });
});
