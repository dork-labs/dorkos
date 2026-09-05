/**
 * `.env.example` and `env.ts` describe the same set of variables (DOR-1646).
 *
 * `.env.example` is the only place a person finds out that a knob exists — the
 * file the README tells them to copy. Nothing tied it to the schema, so it
 * documented roughly half of what the server reads, and the drift was invisible
 * until somebody went looking: DOR-543 found three variables that had been
 * shipped undocumented, by hand, months after the fact. It also ran the other
 * way, describing `DORKOS_PULSE_ENABLED` long after Pulse became Tasks and
 * nothing read that name at all.
 *
 * This is not a style check. A variable nobody can discover is a feature that
 * does not exist for anyone who did not write it, and a variable documented but
 * not read is worse than silence — somebody sets it, believes it took effect,
 * and gets no error saying otherwise.
 *
 * ## Both directions, and the two escape hatches
 *
 * Declared-but-undocumented is caught by {@link UNDOCUMENTED_ON_PURPOSE}, and
 * documented-but-undeclared by {@link DOCUMENTED_ELSEWHERE}. Each is a map from
 * a name to the REASON it is exempt, not a bare list: an exemption a person has
 * to justify in a sentence is one they think about, and the sentence is what the
 * next reader needs. Both are checked for rot — an entry naming a variable that
 * no longer needs it fails just as loudly as an undocumented one, so the lists
 * cannot quietly outlive their reasons.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverEnvSchema } from '../env.js';

/** The repository root, from `apps/server/src/__tests__/`. */
const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Variables the server reads that `.env.example` deliberately does not mention,
 * and why.
 *
 * The bar is that a person running DorkOS would be no better off for reading the
 * line: the variable belongs to the environment rather than to DorkOS, is set by
 * DorkOS's own packaging, or exists only for a harness in this repo. Anything an
 * operator might reasonably want to turn on belongs in the file instead.
 */
const UNDOCUMENTED_ON_PURPOSE: Record<string, string> = {
  HOME: 'the operating system sets it; DorkOS only reads it',
  NODE_ENV: 'set by the way the server is started, not by a person editing .env',
  GITHUB_TOKEN: 'the standard GitHub convention, already in the environment of anyone who uses gh',
  CLIENT_DIST_PATH: 'set by the CLI and the desktop shell to point at their own bundled client',
  DORKOS_APPROVAL_TTL_MS:
    'shortens the approval window for the eval harness (DOR-498); it can only ever shorten it, and nothing an operator wants is on the other end',
  DORKOS_TEST_RUNTIME: 'e2e only — swaps the real runtime for the fake one',
  DORKOS_TEST_RUNTIME_SECONDARY: 'e2e only — a second fake runtime, for the multi-runtime UI',
  DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: 'e2e only — a third fake runtime under the claude-code name',
  DORKOS_Q3_DURATION_MS: 'read only by the q3 contention harness (scripts/q3-contention/run.ts)',
  DORKOS_Q3_TICK_MS: 'read only by the q3 contention harness',
  DORKOS_Q3_CANARY_MAP: 'read only by the q3 contention harness',
};

/**
 * Variables `.env.example` documents that this schema deliberately does not
 * declare, and why.
 *
 * `.env.example` covers the whole repo — the Vite dev server and the marketing
 * site read it too — and one variable is read by the server through a different
 * door on purpose.
 */
const DOCUMENTED_ELSEWHERE: Record<string, string> = {
  VITE_PORT: 'the client dev server, not the API server',
  NEXT_PUBLIC_POSTHOG_KEY: 'the marketing site (apps/site)',
  NEXT_PUBLIC_POSTHOG_HOST: 'the marketing site (apps/site)',
  BETTER_AUTH_SECRET:
    'read straight from process.env by services/core/auth/secret.ts, which is also bundled into the CLI — see the note in env.ts',
};

/**
 * Every variable named on the left of an `=` in `.env.example`, commented-out
 * lines included.
 *
 * The commented ones are the point: almost every optional variable is shown as
 * `# NAME=value`, which is how the file demonstrates a default without setting
 * it.
 */
function documentedVars(): Set<string> {
  const file = readFileSync(join(repoRoot, '.env.example'), 'utf8');
  return new Set([...file.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
}

/** Every variable the server's schema declares. */
function declaredVars(): string[] {
  return Object.keys(serverEnvSchema.shape);
}

describe('.env.example covers what the server reads', () => {
  it('documents every variable env.ts declares', () => {
    const documented = documentedVars();
    const missing = declaredVars().filter(
      (name) => !documented.has(name) && !(name in UNDOCUMENTED_ON_PURPOSE)
    );

    expect(
      missing,
      `Add these to .env.example (or, if a person running DorkOS would be no better off knowing, to UNDOCUMENTED_ON_PURPOSE in this file with the reason): ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('describes no variable the server has stopped reading', () => {
    const declared = new Set(declaredVars());
    const stale = [...documentedVars()].filter(
      (name) => !declared.has(name) && !(name in DOCUMENTED_ELSEWHERE)
    );

    expect(
      stale,
      `.env.example describes variables nothing reads — remove them, or record where they ARE read in DOCUMENTED_ELSEWHERE: ${stale.join(', ')}`
    ).toEqual([]);
  });

  it('keeps no exemption for a variable that no longer needs one', () => {
    // An allowlist outlives what it excused unless something says so. Both of
    // these fail the moment their reason evaporates: a variable that has since
    // been documented, or one that has been deleted outright.
    const documented = documentedVars();
    const declared = new Set(declaredVars());

    const undocumentedRot = Object.keys(UNDOCUMENTED_ON_PURPOSE).filter(
      (name) => !declared.has(name) || documented.has(name)
    );
    expect(
      undocumentedRot,
      `UNDOCUMENTED_ON_PURPOSE names variables that are gone from env.ts or now documented anyway: ${undocumentedRot.join(', ')}`
    ).toEqual([]);

    const elsewhereRot = Object.keys(DOCUMENTED_ELSEWHERE).filter(
      (name) => !documented.has(name) || declared.has(name)
    );
    expect(
      elsewhereRot,
      `DOCUMENTED_ELSEWHERE names variables that are gone from .env.example or now declared in env.ts: ${elsewhereRot.join(', ')}`
    ).toEqual([]);
  });

  it('reads a real .env.example and a real schema', () => {
    // The guard above is only as good as its two inputs, and both are parsed
    // rather than imported as data: a regex that stopped matching, or a schema
    // shape read off the wrong object, would make every assertion above pass on
    // two empty sets.
    expect(declaredVars().length).toBeGreaterThan(40);
    expect(documentedVars().size).toBeGreaterThan(20);
    expect(documentedVars().has('DORKOS_PORT')).toBe(true);
  });
});
