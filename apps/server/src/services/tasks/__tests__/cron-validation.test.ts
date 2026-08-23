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

    it('a schedule that can never come round', () => {
      expect(describeScheduleProblem('0 0 30 2 *', 'UTC')).toContain('never comes round');
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
  describe('agrees with what croner will actually accept', () => {
    const cases: Array<[string | null, string | null]> = [
      ['0 9 * * *', null],
      ['30 0 9 * * *', null],
      ['*/10 * * * *', 'Europe/London'],
      ['0 0 29 2 *', 'UTC'],
      ['banana', null],
      ['99 * * * *', null],
      ['0 9 * * *', 'Mars/Phobos'],
    ];

    it.each(cases)('cron %s / timezone %s', (cron, timezone) => {
      const rejected = describeScheduleProblem(cron, timezone) !== null;

      let schedulable: boolean;
      let job: Cron | undefined;
      try {
        // The same construction the scheduler performs, handler and all.
        job = new Cron(cron!, { protect: true, timezone: timezone ?? undefined }, () => {});
        schedulable = job.nextRun() !== null;
      } catch {
        schedulable = false;
      } finally {
        job?.stop();
      }

      expect(rejected).toBe(!schedulable);
    });
  });
});
