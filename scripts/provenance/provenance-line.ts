/**
 * The provenance line for shell callers (CI, `scripts/open-pr.sh`), built and
 * read by `@dorkos/shared/provenance` so a shell script never hand-rolls the
 * JSON (AGENTS.md "Signing outward writes").
 *
 * ```bash
 * # Print a version 2 line from the environment. Visibility defaults to
 * # unknown, which is treated as public.
 * pnpm exec tsx scripts/provenance/provenance-line.ts --visibility public
 *
 * # Print the normalized JSON of a body's signature, or `null` when it has none.
 * gh pr view 123 --json body -q .body | pnpm exec tsx scripts/provenance/provenance-line.ts read | jq -r '.chat // empty'
 * ```
 *
 * The environment it reads:
 *
 * - `DORKOS_HARNESS`, or `CLAUDECODE` for `claude-code`: the harness.
 * - `DORKOS_SESSION_ID`, under any harness: the chat. Under Claude Code only,
 *   `CLAUDE_CODE_SESSION_ID` and then `CLAUDE_SESSION_ID` stand in when it is
 *   unset, so a Claude variable left in a Codex or OpenCode shell never
 *   names another harness's chat.
 * - `CLAUDE_CONFIG_DIR`, under Claude Code only: the account, as
 *   `open-pr.sh` derives it.
 * - `DORKOS_AGENT_ID` and `DORKOS_SPACE_ID`: the agent and its space, a bare
 *   id or a whole `dork:` reference. DorkOS sets both in every runtime's turn
 *   environment (DOR-5138); outside a DorkOS turn they are absent and so are
 *   the fields.
 * - `DORKOS_SESSION_ID` and `CI`, for the surface when `--surface` is not
 *   given: `dorkos` inside a DorkOS turn, `ci` when `CI` is `true`, else
 *   `bare-cli`.
 *
 * A value that would not read back is left out of the line, never repaired.
 *
 * A signature is routing advice: it never grants a right to deliver.
 *
 * @module scripts/provenance/provenance-line
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  buildProvenanceV2,
  readProvenance,
  type ProvenanceFields,
  type ProvenanceVisibility,
} from '../../packages/shared/src/provenance.js';

const VISIBILITIES: readonly ProvenanceVisibility[] = ['public', 'private', 'unknown'];

const USAGE = `usage: provenance-line.ts [--visibility public|private|unknown] [--surface <word>]
       provenance-line.ts read   (body on stdin; prints the signature's JSON or null)`;

/** An environment variable's value, with an empty one treated as unset (as `\${X:-}` does). */
function env(vars: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = vars[name];
  return value === undefined || value === '' ? undefined : value;
}

/** A bare id as a `dork:<kind>:<id>` string; a value already in `dork:` form is kept as given. */
function asReference(kind: 'agent' | 'space', value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith('dork:') ? value : `dork:${kind}:${value}`;
}

/**
 * Where the work was driven from, when `--surface` does not say: `dorkos`
 * inside a DorkOS turn (it sets `DORKOS_SESSION_ID`), `ci` when `CI` is
 * `true`, and otherwise `bare-cli`.
 *
 * @param vars - The environment to read.
 * @returns The surface word.
 */
export function surfaceFromEnv(vars: NodeJS.ProcessEnv): string {
  if (env(vars, 'DORKOS_SESSION_ID') !== undefined) return 'dorkos';
  if (vars.CI === 'true') return 'ci';
  return 'bare-cli';
}

/**
 * The fields the environment names, before any is checked: the builder drops
 * whatever would not read back.
 *
 * @param vars - The environment to read.
 * @param surface - The `--surface` value, when given; otherwise {@link surfaceFromEnv}.
 * @returns The writer's fields.
 */
export function fieldsFromEnv(vars: NodeJS.ProcessEnv, surface?: string): ProvenanceFields {
  let harness = env(vars, 'DORKOS_HARNESS');
  if (harness === undefined && env(vars, 'CLAUDECODE') !== undefined) harness = 'claude-code';
  const isClaudeCode = harness === 'claude-code';
  let account: string | undefined;
  if (isClaudeCode) {
    // The config dir's basename, one leading dot dropped: `~/.claude3` is `claude3`.
    account = basename(env(vars, 'CLAUDE_CONFIG_DIR') ?? 'claude').replace(/^\./, '');
    if (account.includes('@')) account = undefined;
  }
  const fields: Partial<Record<keyof ProvenanceFields, string | undefined>> = {
    harness,
    surface: surface ?? surfaceFromEnv(vars),
    account,
    agent: asReference('agent', env(vars, 'DORKOS_AGENT_ID')),
    chat:
      env(vars, 'DORKOS_SESSION_ID') ??
      (isClaudeCode
        ? (env(vars, 'CLAUDE_CODE_SESSION_ID') ?? env(vars, 'CLAUDE_SESSION_ID'))
        : undefined),
    space: asReference('space', env(vars, 'DORKOS_SPACE_ID')),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as ProvenanceFields;
}

/**
 * Run the command.
 *
 * @param argv - The arguments after the script path.
 * @param vars - The environment.
 * @param stdin - Reads standard input, for `read`.
 * @returns The exit code and what to print on stdout or stderr.
 */
export function run(
  argv: readonly string[],
  vars: NodeJS.ProcessEnv,
  stdin: () => string
): { code: number; stdout: string; stderr: string } {
  if (argv[0] === 'read') {
    if (argv.length > 1) return { code: 2, stdout: '', stderr: `${USAGE}\n` };
    return { code: 0, stdout: `${JSON.stringify(readProvenance(stdin()))}\n`, stderr: '' };
  }
  let values: { visibility?: string; surface?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { visibility: { type: 'string' }, surface: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { code: 2, stdout: '', stderr: `${(error as Error).message}\n${USAGE}\n` };
  }
  const visibility = (values.visibility ?? 'unknown') as ProvenanceVisibility;
  if (!VISIBILITIES.includes(visibility)) {
    return { code: 2, stdout: '', stderr: `unknown visibility: ${visibility}\n${USAGE}\n` };
  }
  const line = buildProvenanceV2(fieldsFromEnv(vars, values.surface), { visibility });
  return { code: 0, stdout: `${line}\n`, stderr: '' };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // eslint-disable-next-line no-restricted-syntax -- A root CLI for shell callers; no app env.ts applies.
  const result = run(process.argv.slice(2), process.env, () => readFileSync(0, 'utf8'));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
