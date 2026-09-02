/**
 * CLI handler for `dorkos call <capability-id>`.
 *
 * The generic, capability-shaped dispatch verb: it invokes any capability the
 * running server exposes by id, regardless of whether that capability has a
 * curated operator verb of its own. This is how a Codex or OpenCode agent (no
 * in-session MCP tools) actuates DorkOS by capability id after discovering the
 * catalog with `dorkos capabilities`.
 *
 * Flow: validate the id against the live catalog (`GET /api/capabilities/catalog`),
 * then `POST /api/capabilities/:id/invoke` with the supplied input. The result is
 * printed as raw JSON on stdout and nothing else, so it pipes straight into `jq`.
 * Schema-validation and capability errors from the server are surfaced on stderr
 * with a non-zero exit. Returns an exit code rather than calling `process.exit`
 * so `cli.ts` stays the single source of truth for termination.
 *
 * @module commands/call
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { fetchFullCatalog, type FullCatalog } from '../lib/capability-catalog.js';
import { printJson } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Help text for `dorkos call` (`--help`), rendered by the `cli.ts` interceptor. */
export const CALL_HELP = `Usage: dorkos call <capability-id> [options]

Invoke any DorkOS capability by id and print its result as JSON. Discover the
available ids with \`dorkos capabilities\`. Output is always raw JSON on stdout.

Options:
      --input <json>        Inline JSON input for the capability
      --input-file <path>   Read the JSON input from a file ('-' reads stdin)
      --approval <token>    Approval token from a call that returned
                            status:approval_required
      --json                Accepted for consistency (output is always JSON)

Examples:
  dorkos call operator.check_update
  dorkos call operator.activity_list --input '{"limit":5}'
  dorkos call operator.config_patch --input-file ./patch.json
  dorkos call marketplace.uninstall --input '{"name":"x"}' --approval <token>`;

/** Parsed arguments for `dorkos call`. */
export interface CallArgs {
  /** The `${domain}.${verb}` capability id to invoke. */
  id: string;
  /** The parsed JSON input to send (defaults to `{}`). */
  input: unknown;
  /**
   * Approval token for a capability that cannot be undone. A first call returns
   * `status:approval_required` with a token; once a person approves in DorkOS, the
   * same call with this token goes through.
   */
  approvalToken?: string;
}

/**
 * Parse the argv slice after `dorkos call`. Reads the positional capability id
 * and resolves the input from `--input` (inline JSON) or `--input-file` (a path,
 * or `-` for stdin); the two are mutually exclusive, and omitting both sends an
 * empty object.
 *
 * @param rawArgs - Argv after `call`.
 * @returns Typed {@link CallArgs}.
 * @throws On a missing id, both input flags together, or unparseable JSON input.
 */
export function parseCallArgs(rawArgs: string[]): CallArgs {
  const usage = 'Usage: dorkos call <capability-id> [--input <json> | --input-file <path>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        input: { type: 'string' },
        'input-file': { type: 'string' },
        approval: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'call', usage);
  }

  const { values, positionals } = parsed;
  const id = positionals[0];
  if (!id) {
    throw new Error(`Missing required <capability-id> argument.\n${usage}`);
  }

  const inline = typeof values.input === 'string' ? values.input : undefined;
  const file = typeof values['input-file'] === 'string' ? values['input-file'] : undefined;
  if (inline !== undefined && file !== undefined) {
    throw new Error(`Pass only one of --input or --input-file, not both.\n${usage}`);
  }

  let rawInput: string | undefined;
  if (inline !== undefined) {
    rawInput = inline;
  } else if (file !== undefined) {
    try {
      rawInput = fs.readFileSync(file === '-' ? 0 : file, 'utf-8');
    } catch (err) {
      throw new Error(
        `Cannot read --input-file '${file}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  let input: unknown = {};
  if (rawInput !== undefined && rawInput.trim().length > 0) {
    try {
      input = JSON.parse(rawInput);
    } catch (err) {
      throw new Error(
        `Invalid JSON input: ${err instanceof Error ? err.message : String(err)}\n${usage}`,
        { cause: err }
      );
    }
  }

  const approvalToken =
    typeof values.approval === 'string' && values.approval.trim().length > 0
      ? values.approval.trim()
      : undefined;

  return { id, input, ...(approvalToken ? { approvalToken } : {}) };
}

/**
 * Implements `dorkos call <capability-id>`.
 *
 * @param args - Parsed call arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runCall(args: CallArgs): Promise<number> {
  // Validate the id against the live catalog first, so an unknown id fails with
  // a clear client-side message rather than a bare server 404. The catalog is
  // paginated (DOR-940), so fetch every page before deciding an id is unknown.
  let catalog: FullCatalog;
  try {
    catalog = await fetchFullCatalog();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!catalog.capabilities.some((c) => c.id === args.id)) {
    console.error(
      `Error: unknown capability '${args.id}'. Run 'dorkos capabilities' to list valid ids.`
    );
    return 1;
  }

  try {
    const result = await apiCall<unknown>(
      'POST',
      `/api/capabilities/${encodeURIComponent(args.id)}/invoke`,
      args.input,
      args.approvalToken ? { 'X-DorkOS-Approval': args.approvalToken } : undefined
    );
    printJson(result);
    // The server accepted the request but a person has to approve it before
    // anything happens, so this is not a success: the payload on stdout says what
    // to do, and the exit code says the capability did not run.
    return isAwaitingApproval(result) ? 1 : 0;
  } catch (err) {
    printCallError(err);
    return 1;
  }
}

/**
 * Whether a result is the tier gate's "a person has to approve this first"
 * payload rather than a capability's own output.
 *
 * @param result - The parsed response body.
 * @returns True when the capability did not run because approval is pending.
 */
function isAwaitingApproval(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'approval_required'
  );
}

/**
 * Render an invoke error to stderr. For an {@link ApiError} the server's message
 * is surfaced, and any structured `details` (e.g. a Zod validation flatten) is
 * printed as JSON so an agent can act on the exact schema failure.
 *
 * @param err - The thrown error.
 */
function printCallError(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    if (err.body.details !== undefined) {
      console.error(JSON.stringify(err.body.details, null, 2));
    }
    return;
  }
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
}
