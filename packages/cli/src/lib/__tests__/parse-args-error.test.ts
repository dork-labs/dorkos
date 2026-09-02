/**
 * Tests for `rethrowUnknownOption()` — the CLI's one translation of a
 * `node:util` `parseArgs` failure into a message a person can act on.
 *
 * The `cause` assertions here are the point of the file. `preserve-caught-error`
 * is what put `{ cause }` on this throw, but the rule cannot hold it: it only
 * looks at `throw` statements lexically inside a `catch`, and this throw lives in
 * a helper one call up. Delete the `{ cause: err }` and lint stays green — which
 * is exactly what happened when a reviewer tried it (DOR-169). So the chain is
 * asserted here or it is guarded by nothing.
 *
 * Every case drives a REAL `parseArgs` rather than a hand-built `TypeError`,
 * because the branch under test keys on `err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'`
 * and a stand-in error is the test asserting its own fixture. It also means a
 * Node release that renames that code fails this file instead of silently
 * turning every unknown flag into a raw parser stack trace.
 */
import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';

import { rethrowUnknownOption } from '../parse-args-error.js';

const USAGE = 'Usage: dorkos widget [--fast]';

/** Run `parseArgs` over `argv` and hand whatever it throws to the helper. */
function parseThroughHelper(argv: string[], command = 'widget'): void {
  try {
    parseArgs({ args: argv, options: { fast: { type: 'boolean' } }, strict: true });
  } catch (err) {
    rethrowUnknownOption(err, command, USAGE);
  }
}

/** Capture the error a call threw, without asserting anything about it yet. */
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('rethrowUnknownOption', () => {
  it('keeps the parser TypeError as the cause of the friendly error', () => {
    const thrown = thrownBy(() => parseThroughHelper(['--nope']));

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    // The readable half: names the command and the offending flag, and carries usage.
    expect(error.message).toContain("Unknown option for 'widget': --nope");
    expect(error.message).toContain(USAGE);

    // The debuggable half — the whole reason this rule was adopted. Without
    // `{ cause }` the parser's own account of the failure is gone for good.
    const cause = error.cause as NodeJS.ErrnoException;
    expect(cause).toBeInstanceOf(TypeError);
    expect(cause.code).toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION');
    expect(cause).not.toBe(error);
    // Not merely *a* TypeError: the one parseArgs actually threw.
    expect(cause.message).toContain('--nope');
  });

  it('passes a non-parseArgs failure through untouched, cause and all', () => {
    // The other half of the discrimination. A helper that wrapped EVERY error
    // would satisfy the test above while destroying every unrelated failure --
    // and callers rely on this path to rethrow, since it is the only way a real
    // bug in a command's own parsing reaches the top level intact.
    const original = new RangeError('something else entirely');

    const thrown = thrownBy(() => {
      rethrowUnknownOption(original, 'widget', USAGE);
    });

    expect(thrown).toBe(original);
  });

  it('does not claim an unknown-option failure it cannot name', () => {
    // A TypeError carrying the right code but no parseable flag name still has
    // to produce the friendly shape rather than interpolating `undefined`.
    const shapeless: NodeJS.ErrnoException = Object.assign(new TypeError('malformed'), {
      code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
    });

    const thrown = thrownBy(() => {
      rethrowUnknownOption(shapeless, 'widget', USAGE);
    });

    const error = thrown as Error;
    expect(error.message).toContain("Unknown option for 'widget': unknown");
    expect(error.message).not.toContain('undefined');
    expect(error.cause).toBe(shapeless);
  });

  it('labels the command it was given, so subcommands read correctly', () => {
    const thrown = thrownBy(() => parseThroughHelper(['--nope'], 'marketplace remove'));

    expect((thrown as Error).message).toContain("Unknown option for 'marketplace remove': --nope");
  });
});
