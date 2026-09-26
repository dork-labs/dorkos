/**
 * CLI handler for `dorkos marketplace uninstall <name>` (and its shorthand,
 * `dorkos uninstall <name>`).
 *
 * Calls `POST /api/marketplace/packages/:name/uninstall` and prints a
 * one-line summary. By default the files you and your agents added or
 * changed are kept; pass `--purge` to remove them too.
 *
 * Removing a package cannot be undone, so the route gates it (DOR-467): a caller
 * that is not the person at the keyboard — an agent, which carries
 * `DORKOS_AGENT_TOKEN` — gets an approval request back instead of the removal, and
 * retries with `--approval <token>` once a person has said yes.
 *
 * @module commands/uninstall
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runUninstall}. */
export interface UninstallArgs {
  /** Package name to uninstall. */
  name: string;
  /** Also remove the files you and your agents added or changed. */
  purge?: boolean;
  /** Absolute project path for project-local uninstalls, resolved against the caller's cwd. */
  projectPath?: string;
  /** Approval token from a previous run that came back awaiting approval. */
  approvalToken?: string;
}

/** Uninstall API response shape. Mirrors {@link UninstallResult} on the server. */
interface UninstallResultBody {
  ok: boolean;
  packageName: string;
  removedFiles: number;
  preservedData: string[];
  /** Files kept because nothing proved whose they were (DOR-2322). */
  unproven?: string[];
  /** Set when an agent package's agent was removed from the team (DOR-2245). */
  agentRemoved?: { id: string; directoryDenied: boolean; removed: string[] };
  warnings?: string[];
}

/** How each thing removing an agent takes away is said to a person. */
const REMOVAL_WORDS: Record<string, string> = {
  'relay-endpoint': 'its message address',
  rooms: 'its rooms',
  'schedules-paused': 'its schedules (paused)',
  'task-roots': 'its scheduled task folders',
  'mcp-sign-ins': 'its sign-ins',
  'identity-tokens': 'its access tokens',
  'community-enrollments': 'its community memberships',
  'connection-access': 'its connection access',
};

/**
 * The tier gate's "a person has to approve this first" answer, returned instead
 * of an uninstall result. Mirrors `ApprovalRequiredPayload` on the server.
 */
interface ApprovalRequiredBody {
  status: 'approval_required';
  approvalId: string;
  approvalToken: string;
  message: string;
  retry: { instructions: string };
}

/**
 * Whether the server answered with an approval request rather than a result.
 *
 * @param result - The parsed response body.
 * @returns True when nothing was uninstalled because a person has to approve it.
 */
function isAwaitingApproval(
  result: UninstallResultBody | ApprovalRequiredBody
): result is ApprovalRequiredBody {
  return (result as ApprovalRequiredBody).status === 'approval_required';
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos marketplace uninstall <name> [--purge] [--project <path>] [--approval <token>]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace uninstall`.
 *
 * @param rawArgs - The argv slice after `uninstall`.
 * @returns A typed {@link UninstallArgs} object.
 */
export function parseUninstallArgs(rawArgs: string[]): UninstallArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        purge: { type: 'boolean', default: false },
        project: { type: 'string' },
        approval: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace uninstall', USAGE_LINE);
  }

  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) {
    throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  }

  return {
    name,
    purge: Boolean(values.purge),
    projectPath: resolveProjectFlag(values.project),
    approvalToken: typeof values.approval === 'string' ? values.approval : undefined,
  };
}

/**
 * Implements `dorkos marketplace uninstall <name>`.
 *
 * @param args - Parsed uninstall arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runUninstall(args: UninstallArgs): Promise<number> {
  try {
    const body: Record<string, unknown> = {};
    if (args.purge) body.purge = true;
    if (args.projectPath) body.projectPath = args.projectPath;

    const result = await apiCall<UninstallResultBody | ApprovalRequiredBody>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/uninstall`,
      body,
      args.approvalToken ? { 'X-DorkOS-Approval': args.approvalToken } : undefined
    );

    // Uninstalling cannot be undone, so a caller that is not the person at the
    // keyboard gets an approval request instead of the removal. Nothing has been
    // removed here: print what to do and exit non-zero, so a script never reads
    // this as a completed uninstall.
    if (isAwaitingApproval(result)) {
      console.error(result.message);
      console.error(result.retry.instructions);
      console.error(`Approval id: ${result.approvalId}`);
      console.error(
        `Retry with: dorkos marketplace uninstall ${args.name} --approval ${result.approvalToken}`
      );
      return 1;
    }

    console.log(`Uninstalled ${result.packageName} (${result.removedFiles} entries removed)`);
    if (!args.purge && result.preservedData.length > 0) {
      // Some kept files may not be the person's at all: DorkOS could not tell
      // (DOR-2322), so the heading does not claim they added them.
      console.log(
        result.unproven && result.unproven.length > 0
          ? 'Kept these files:'
          : 'Kept the files you and your agents added or changed:'
      );
      for (const path of result.preservedData) {
        console.log(`  ${path}`);
      }
    }
    if (result.agentRemoved) {
      const taken = result.agentRemoved.removed.map((r) => REMOVAL_WORDS[r] ?? r).join(', ');
      console.log(
        `Removed the agent from your team. That also took away ${taken}; reinstalling does not bring them back.`
      );
      if (result.agentRemoved.directoryDenied) {
        console.log(
          'Its folder is blocked from your team because git tracks its settings file, so the file was left in place.'
        );
      }
    }
    for (const warning of result.warnings ?? []) console.log(warning);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}
