/**
 * CLI handler for `dorkos marketplace link <path>` (DOR-2696).
 *
 * Runs a marketplace package straight from a folder on this computer, so a
 * plugin author sees their edits without reinstalling. The folder is resolved
 * against the caller's working directory and then to its real path, so the
 * folder shown is the folder linked.
 *
 * It asks `POST /api/marketplace/dev-links/preview` what linking would do,
 * prints the package name, the folder, what it runs and what it replaces, and
 * asks before linking (`--yes` skips the question). Then `POST
 * /api/marketplace/dev-links` makes the link, sending back the preview's
 * `change` text as `expectedChange`: the yes covers what the person read, so a
 * folder that gained a hook or an extension while the question waited is
 * refused rather than linked.
 *
 * Linking changes which code runs, so the route gates it: a caller that is not
 * the person at the keyboard (an agent, which carries `DORKOS_AGENT_TOKEN`, and
 * whose identity header the API client always sends) gets an approval request
 * back, and retries with `--approval <token>` once a person said yes in
 * DorkOS. The approval is bound to the folder, project and replace choice sent,
 * so the printed retry repeats all three. An agent is not asked here: the card
 * in DorkOS is where a person decides for it.
 *
 * @module commands/marketplace-link
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type {
  DevLinkPreview,
  DevLinkPreviewResponse,
  DevLinkStatus,
} from '@dorkos/shared/marketplace-schemas';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';
import { renderDisclosureLines } from '../lib/disclosure-render.js';
import { printError, printJson } from '../lib/operator-output.js';
import { resolveProjectFlag, shellWord, unlinkCommand } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** The longest folder path the server accepts (`DEV_LINK_PATH_MAX` on the route). */
const PATH_MAX = 1024;

/** Parsed CLI arguments accepted by {@link runMarketplaceLink}. */
export interface MarketplaceLinkArgs {
  /** The folder as typed, resolved against the caller's cwd. Made real when the command runs. */
  folder: string;
  /** Absolute project path for a project link; absent for every session. */
  projectPath?: string;
  /** Set the installed copy aside while the link is in place. */
  replaceInstalled: boolean;
  /** Do not ask before linking. */
  yes: boolean;
  /** Approval token from a run that came back waiting on a person. */
  approvalToken?: string;
  /** Print the server's answer as JSON. */
  json: boolean;
}

/**
 * The tier gate's "a person has to approve this first" answer. Mirrors
 * `ApprovalRequiredPayload` on the server.
 */
interface ApprovalRequiredBody {
  status: 'approval_required';
  approvalId: string;
  approvalToken: string;
  message: string;
  retry: { instructions: string };
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos marketplace link <path> [--project <path>] [--replace-installed] [--yes] [--approval <token>] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace link`.
 *
 * @param rawArgs - The argv slice after `link`.
 * @returns A typed {@link MarketplaceLinkArgs} object.
 */
export function parseMarketplaceLinkArgs(rawArgs: string[]): MarketplaceLinkArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        'replace-installed': { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        approval: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace link', USAGE_LINE);
  }
  const { values, positionals } = parsed;
  const folder = positionals[0];
  if (!folder) throw new Error(`Missing required <path> argument.\n${USAGE_LINE}`);
  if (positionals.length > 1) throw new Error(`Link one folder at a time.\n${USAGE_LINE}`);
  return {
    folder: path.resolve(process.cwd(), folder),
    projectPath: resolveProjectFlag(values.project),
    replaceInstalled: Boolean(values['replace-installed']),
    yes: Boolean(values.yes),
    approvalToken: typeof values.approval === 'string' ? values.approval : undefined,
    json: Boolean(values.json),
  };
}

/**
 * Whether this command runs inside an agent's session. The API client sends
 * that agent's identity on every call, so the server answers with an approval
 * card rather than linking.
 */
function runningAsAgent(): boolean {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_AGENT_TOKEN is injected into the spawned agent's env by the server, not CLI config
  return Boolean(process.env.DORKOS_AGENT_TOKEN?.trim());
}

/**
 * Why a folder could not be read, naming the system's reason. Pure.
 *
 * @param typed - The folder as resolved from what was typed.
 * @param err - What `realpath` threw.
 * @returns One line for stderr.
 */
export function describeUnreadableFolder(typed: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const reason =
    code === 'ENOENT'
      ? `No folder at ${typed}.`
      : code === 'EACCES' || code === 'EPERM'
        ? `Can't read ${typed}: permission denied (${code}).`
        : `Can't read ${typed}${code ? ` (${code})` : ''}.`;
  // A quoted '~/x' reaches us as <cwd>/~/x: the shell only expands an unquoted ~.
  const tilde = typed.split(path.sep).includes('~')
    ? ' The shell does not expand ~ inside quotes; use the full path.'
    : '';
  return `Error: ${reason}${tilde}`;
}

/**
 * The lines describing what linking would do. Pure, so tests can read them.
 *
 * @param preview - The server's preview.
 * @returns The lines to print, in order.
 */
export function describeLinkPreview(preview: DevLinkPreview): string[] {
  const lines = [
    `${preview.name}${preview.version ? ` ${preview.version}` : ''} (${preview.type})`,
    `Folder: ${preview.path}`,
    preview.scope === 'project' ? 'Runs in this project only.' : 'Runs in every chat.',
    preview.replaces
      ? `Sets aside the installed copy (${preview.replaces.version}). Unlinking brings it back.`
      : 'Replaces nothing.',
    'It runs:',
    ...renderDisclosureLines(preview.effects, preview.scope),
  ];
  if (preview.extensions.length > 0) {
    lines.push(`Extensions: ${preview.extensions.join(', ')}`);
  }
  return lines;
}

/**
 * Implements `dorkos marketplace link <path>`.
 *
 * @param args - Parsed arguments.
 * @returns The intended process exit code (`0` linked or declined, `1` error or waiting on a person).
 */
export async function runMarketplaceLink(args: MarketplaceLinkArgs): Promise<number> {
  let folder: string;
  try {
    folder = fs.realpathSync(args.folder);
  } catch (err) {
    console.error(describeUnreadableFolder(args.folder, err));
    return 1;
  }
  if (folder.length > PATH_MAX) {
    console.error(`Error: That folder path is longer than ${PATH_MAX} characters.`);
    return 1;
  }
  const scope = args.projectPath ? 'project' : 'global';
  const where = { scope, ...(args.projectPath && { projectPath: args.projectPath }) };

  try {
    const preview = await apiCall<DevLinkPreviewResponse>(
      'POST',
      '/api/marketplace/dev-links/preview',
      { path: folder, ...where, ...(args.replaceInstalled && { replaceInstalled: true }) }
    );
    if (!args.json) {
      for (const line of describeLinkPreview(preview)) console.log(line);
      console.log('');
    }

    // The server refuses to set an installed copy aside unasked; say how to ask
    // before asking the person anything.
    if (preview.replaces && !args.replaceInstalled) {
      console.error(
        `Nothing was linked. ${preview.name} ${preview.replaces.version} is installed. ` +
          'Run it again with --replace-installed to use your folder instead.'
      );
      return 1;
    }

    // A person approving in DorkOS (an agent's card, or `--approval`) is the
    // yes; asking again here would only strand a run with no keyboard.
    if (!args.yes && !args.approvalToken && !runningAsAgent()) {
      // No keyboard to ask, or stdout promised to JSON alone.
      if (args.json || !process.stdin.isTTY) {
        console.error('Nothing was linked. Run it again with --yes to link without asking.');
        return 1;
      }
      if (!(await confirm(`Run ${preview.name} from ${preview.path}?`))) {
        console.log('Nothing was linked.');
        return 0;
      }
    }

    const result = await apiCall<DevLinkStatus | ApprovalRequiredBody>(
      'POST',
      '/api/marketplace/dev-links',
      {
        path: folder,
        ...where,
        ...(args.replaceInstalled && { replaceInstalled: true }),
        via: 'terminal',
        // What the person just read. The server refuses the link when the
        // folder no longer reads the same, and ignores this for an agent,
        // whose yes is the approval card.
        ...(typeof preview.change === 'string' && { expectedChange: preview.change }),
      },
      args.approvalToken ? { 'X-DorkOS-Approval': args.approvalToken } : undefined
    );

    // Nothing was linked: a person has to approve it in DorkOS first. Exit
    // non-zero so a script never reads this as linked.
    if ('status' in result && result.status === 'approval_required') {
      if (args.json) {
        printJson(result);
      } else {
        console.error(result.message);
        console.error(result.retry.instructions);
        console.error(`Approval id: ${result.approvalId}`);
      }
      const retry = [
        'dorkos marketplace link',
        shellWord(folder),
        ...(args.projectPath ? ['--project', shellWord(args.projectPath)] : []),
        ...(args.replaceInstalled ? ['--replace-installed'] : []),
        '--approval',
        result.approvalToken,
      ].join(' ');
      console.error(`Retry with: ${retry}`);
      return 1;
    }

    const status = result as DevLinkStatus;
    if (args.json) {
      printJson(status);
      return 0;
    }
    console.log(`${status.name} now runs from ${status.path}.`);
    if (status.parked) {
      console.log(
        `Your installed copy is set aside. To get it back, run: ${unlinkCommand(status.name, args.projectPath)}`
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.body.code === 'dev_link_changed') {
      console.error(
        'Nothing was linked. The folder changed since you checked it. Run the command again.'
      );
      return 1;
    }
    printError(err);
    return 1;
  }
}
