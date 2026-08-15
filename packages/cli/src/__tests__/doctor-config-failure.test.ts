/**
 * `dorkos doctor` and a config it cannot open.
 *
 * Doctor is the command a person runs BECAUSE something is wrong, and a config
 * file the operating system will not let DorkOS read is the one condition that
 * now stops the server from starting at all. It used to be the single
 * diagnosis doctor swallowed: `loadConfig` caught everything and returned
 * `null`, so the report came back clean and exited 0 for the one machine that
 * was actually broken.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { configFailureCheck, describeConfigFailure } from '../commands/doctor.js';

/** A stand-in for `ConfigUnreadableError`, which lives in the bundled server. */
function unreadableError(advice: string): Error {
  const cause = new Error("EMFILE: too many open files, open '/x/.dork/config.json'") as Error & {
    code: string;
  };
  cause.code = 'EMFILE';
  const error = new Error(
    'DorkOS could not read your settings, so it stopped rather than replacing them.\n\n  file: /x\n  why:  EMFILE',
    { cause }
  ) as Error & { advice: string };
  error.name = 'ConfigUnreadableError';
  error.advice = advice;
  return error;
}

describe('describeConfigFailure', () => {
  it('reports what the operating system said, not the wrapper around it', () => {
    // The wrapper's message is a multi-line terminal block; a checklist row
    // needs the one line that names the refusal.
    const detail = describeConfigFailure(unreadableError('advice'));
    expect(detail).toBe("EMFILE: too many open files, open '/x/.dork/config.json'");
  });

  it('falls back to the first line when there is no underlying cause', () => {
    expect(describeConfigFailure(new Error('one line\nand another'))).toBe('one line');
  });

  it('survives something that is not an error at all', () => {
    expect(describeConfigFailure('a bare string')).toBe('a bare string');
  });
});

describe('configFailureCheck', () => {
  const dorkHome = path.join('/tmp', 'doctor-home');

  it('fails the run rather than reporting a clean bill of health', () => {
    // `runDoctor` exits 1 when any check fails, so this status IS the exit code.
    const check = configFailureCheck(unreadableError('advice'), dorkHome);
    expect(check.status).toBe('fail');
    // Covers both refusals: a file the OS would not open, and one DorkOS's own
    // migration could not update (DOR-1221).
    expect(check.label).toBe('Your settings could not be used');
  });

  it('reports a failed migration the same way, without blaming the file', () => {
    const cause = new Error(
      'Something went wrong during the migration! Cannot read properties of undefined'
    );
    const error = new Error(
      'DorkOS could not update your settings to this version, so it stopped\nrather than replacing them.',
      { cause }
    ) as Error & { advice: string };
    error.name = 'ConfigMigrationFailedError';
    error.advice = 'Nothing you can change in that file will help.';

    const check = configFailureCheck(error, dorkHome);

    expect(check.status).toBe('fail');
    expect(check.fix).toContain('did not replace or delete the file');
    expect(check.fix).toContain('Nothing you can change in that file will help.');
    expect(describeConfigFailure(error)).toContain('Something went wrong during the migration!');
  });

  it('says the file was not replaced or deleted, and names it', () => {
    const check = configFailureCheck(unreadableError('advice'), dorkHome);
    expect(check.fix).toContain(path.join(dorkHome, 'config.json'));
    // Not "did not change the file": doctor calls `initConfigManager` in its
    // own process, so conf's default-merging write fires inside that very
    // call. What holds is that nothing was replaced or deleted.
    expect(check.fix).toContain('did not replace or delete the file');
    // Every other row is now reading defaults, which would otherwise look like
    // the person's real settings passing their checks.
    expect(check.fix).toContain('built-in defaults');
  });

  it('shows the error’s own next step instead of a second copy of it', () => {
    // Two copies of this advice drifted apart once: doctor kept telling people
    // to wait for a permission error to pass on its own.
    const check = configFailureCheck(
      unreadableError('DorkOS is not allowed to open that file. chmod u+rw it.'),
      dorkHome
    );
    expect(check.fix).toContain('chmod u+rw');
    expect(check.fix).not.toContain('less busy');
  });

  it('still offers a next step when the error carries no advice', () => {
    const check = configFailureCheck(new Error('something else entirely'), dorkHome);
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('Start DorkOS again');
  });
});
