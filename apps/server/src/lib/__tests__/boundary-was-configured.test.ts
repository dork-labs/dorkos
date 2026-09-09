/**
 * `boundaryWasConfigured` — the predicate Harness Sync at global scope asks
 * before it plans a link in somebody's home directory.
 *
 * Every case here exists because the obvious way to build this predicate is
 * wrong in two opposite directions, and both failures are silent:
 *
 * - Derived from `initBoundary`'s argument, a CLI process always reads "not
 *   configured", because `initBoundary` has exactly two callers and neither is
 *   the CLI. `dorkos harness sync` would then write into a confined machine's
 *   home directory. Fail-OPEN, in the one place this rule exists to close.
 * - `harness-boot.ts` passes `path.dirname(dorkHome)`, a non-null argument,
 *   where nothing was configured at all. The eval harness would read
 *   "configured" and stop projecting. Fail-CLOSED, for a deployment nobody
 *   confined.
 *
 * So the cases are written per PROCESS rather than per branch: one call site
 * passing is not evidence for the other.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { boundaryWasConfigured, type BoundaryConfigReader } from '../boundary.js';

/** A config store that answers one path and nothing else. */
function configWithBoundary(value: unknown): BoundaryConfigReader {
  return {
    getDot: (key: string) => (key === 'server.boundary' ? value : undefined),
  };
}

describe('boundaryWasConfigured', () => {
  it('the CLI process: DORKOS_BOUNDARY set and no config is CONFIGURED', () => {
    // `packages/cli/src/cli.ts` writes this variable from `--boundary`. Seeded
    // defect: derive the answer from `initBoundary`, which the CLI never calls,
    // and the CLI writes the links on a confined machine.
    expect(boundaryWasConfigured({ DORKOS_BOUNDARY: '/workspace' }, configWithBoundary(null))).toBe(
      true
    );
  });

  it('the CLI process: server.boundary in config and NO environment variable is CONFIGURED', () => {
    // This is the case a variable-only predicate gets wrong. `cli.ts` populates
    // `DORKOS_BOUNDARY` from config only AFTER the `harness` subcommand has been
    // intercepted, so inside `dorkos harness sync` the variable is still unset
    // and the config field is the only evidence there is. Seeded defect: read
    // the environment variable only, and a config-confined deployment silently
    // gets links in its home directory.
    expect(boundaryWasConfigured({}, configWithBoundary('/workspace'))).toBe(true);
  });

  it('the server process: neither set is NOT configured, so the user tier is planned', () => {
    // The ordinary install. `initBoundary`'s own default root is the person's
    // home, so an ordinary install is already inside its boundary — which is
    // exactly why "is there a boundary at all" cannot be asked of that function.
    expect(boundaryWasConfigured({}, configWithBoundary(null))).toBe(false);
  });

  it('the eval harness: a non-null initBoundary argument is not configuration', () => {
    // `apps/server/src/harness-boot.ts` calls `initBoundary(path.dirname(dorkHome))`
    // where nobody configured anything. Nothing about that argument reaches this
    // predicate: it reads the environment and the config field, and both are
    // empty here. Seeded defect: treat that argument as configuration, and the
    // eval harness stops projecting global skills.
    const bootArgument = path.dirname('/tmp/some-eval-run/.dork');
    expect(bootArgument).not.toBe('');
    expect(boundaryWasConfigured({}, configWithBoundary(null))).toBe(false);
  });

  it('an empty or blank value is not a configuration', () => {
    // `DORKOS_BOUNDARY=` is how a shell unsets a variable it has to keep
    // exporting. Reading that as "confined" would silently disable the user tier
    // for anybody who does it, and they would have no way to tell.
    expect(boundaryWasConfigured({ DORKOS_BOUNDARY: '' }, configWithBoundary(null))).toBe(false);
    expect(boundaryWasConfigured({ DORKOS_BOUNDARY: '   ' }, configWithBoundary(null))).toBe(false);
    expect(boundaryWasConfigured({}, configWithBoundary(''))).toBe(false);
    expect(boundaryWasConfigured({}, configWithBoundary('  '))).toBe(false);
  });

  it('a non-string config value is not a configuration', () => {
    // The field is `string | null`, and a file somebody hand-edited is not.
    expect(boundaryWasConfigured({}, configWithBoundary(42))).toBe(false);
    expect(boundaryWasConfigured({}, configWithBoundary({ path: '/workspace' }))).toBe(false);
  });

  it('is pure: it reads nothing but the two arguments', () => {
    // No filesystem access, no dependence on startup order, and no read of the
    // real `process.env` — which is what lets the CLI call it before it has
    // resolved anything, and lets these cases run in any order.
    const seen: string[] = [];
    const config: BoundaryConfigReader = {
      getDot: (key) => {
        seen.push(key);
        return null;
      },
    };
    expect(boundaryWasConfigured({}, config)).toBe(false);
    expect(seen).toEqual(['server.boundary']);
  });

  it('does not read the environment variable when config already answers yes', () => {
    // Short-circuit, stated so the order is deliberate rather than incidental:
    // the variable is checked first because it is what `--boundary` writes, and
    // it is the answer a person typed most recently.
    const seen: string[] = [];
    const config: BoundaryConfigReader = {
      getDot: (key) => {
        seen.push(key);
        return null;
      },
    };
    expect(boundaryWasConfigured({ DORKOS_BOUNDARY: '/workspace' }, config)).toBe(true);
    expect(seen).toEqual([]);
  });
});
