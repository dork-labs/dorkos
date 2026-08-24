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
      ['a six-field cron with seconds', '30 0 9 * * *', undefined],
      ['a named weekday', '0 9 * * MON', undefined],
      ['a step', '*/10 * * * *', undefined],
      ['a real timezone', '0 9 * * *', 'America/New_York'],
      [
        'a real timezone with a slash and underscore',
        '0 9 * * *',
        'America/Argentina/Buenos_Aires',
      ],
      ['leap day, which does come round', '0 0 29 2 *', 'UTC'],
      // A well-formed pattern that never matches is how you write a task that
      // only ever runs when somebody triggers it by hand. `apps/e2e` names this
      // exact expression `NEVER_FIRES_CRON` and builds its task fixtures on it.
      ['February 31st — the never-fire idiom', '0 0 31 2 *', 'UTC'],
      ['February 30th, the same idiom', '0 0 30 2 *', 'UTC'],
      ['a never-fire cron with no timezone given', '0 0 31 2 *', undefined],
    ])('%s', (_label, cron, timezone) => {
      expect(describeScheduleProblem(cron, timezone)).toBeNull();
    });

    it('an on-demand task, which has no cron at all', () => {
      expect(describeScheduleProblem(null, null)).toBeNull();
      expect(describeScheduleProblem(undefined, undefined)).toBeNull();
      expect(describeScheduleProblem('', null)).toBeNull();
    });

    it('a timezone on a task with no cron — the timezone still has to be real', () => {
      expect(describeScheduleProblem(null, 'Europe/Stockholm')).toBeNull();
      expect(describeScheduleProblem(null, 'Mars/Phobos')).toContain('Mars/Phobos');
    });
  });

  describe('refuses', () => {
    it('a cron that is not a cron', () => {
      const problem = describeScheduleProblem('banana', null);
      expect(problem).toContain('banana');
      expect(problem).toContain('0 9 * * *');
    });

    it('a field value out of range', () => {
      expect(describeScheduleProblem('99 * * * *', null)).toContain('99 * * * *');
    });

    it('a timezone that does not exist', () => {
      const problem = describeScheduleProblem('0 9 * * *', 'Mars/Phobos');
      expect(problem).toContain('Mars/Phobos');
      expect(problem).toContain('IANA');
    });

    // A bad timezone and a fine cron: reporting this as a cron problem would
    // send someone to rewrite an expression that was never wrong.
    it('names the timezone, not the cron, when the timezone is the problem', () => {
      expect(describeScheduleProblem('0 9 * * *', 'Not A Zone')).not.toContain('0 9 * * *');
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
      ['30 0 9 * * *', null],
      ['*/10 * * * *', 'Europe/London'],
      ['0 0 29 2 *', 'UTC'],
      ['0 0 31 2 *', 'UTC'],
      ['0 0 30 2 *', null],
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

    // Stated separately because it is the distinction the guard above turns on:
    // the scheduler really does accept a never-firing pattern, and really does
    // report it as having no next run.
    it('holds a never-firing schedule without refusing it', () => {
      const job = new Cron('0 0 31 2 *', { protect: true, timezone: 'UTC' }, () => {});
      try {
        expect(job.nextRun()).toBeNull();
        expect(describeScheduleProblem('0 0 31 2 *', 'UTC')).toBeNull();
      } finally {
        job.stop();
      }
    });
  });
});
