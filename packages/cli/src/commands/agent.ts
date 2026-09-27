/**
 * CLI handlers for `dorkos agent list|show|create|update`.
 *
 * Thin HTTP wrappers over the running server's agent surfaces:
 *
 * - `agent list`           → `GET /api/mesh/agents` (the same roster the
 *   cockpit's agent list reads — Mesh's health-annotated aggregation).
 * - `agent show <ref>`     → `GET /api/mesh/agents/:id` for a Mesh id, or
 *   `GET /api/agents/current?path=` when `<ref>` looks like a filesystem path.
 * - `agent create`         → `POST /api/agents/create` (full pipeline: mkdir +
 *   scaffold + optional template + register).
 * - `agent update`         → `PATCH /api/agents/current?path=` (self-edit
 *   fields; the server enforces its agent-write policy and the system-agent
 *   guards).
 * - `agent permissions`    → `commands/permissions.ts` (one agent's
 *   permissions, through the permission routes).
 *
 * Every verb accepts `--json` for raw machine output. Handlers return an exit
 * code rather than calling `process.exit` so `cli.ts` stays the single source of
 * truth for termination.
 *
 * @module commands/agent
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';
import { renderDisclosureLines } from '../lib/disclosure-render.js';
import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import { printError, printJson, renderTable } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Help text for `dorkos agent` (no subcommand or `--help`). */
const AGENT_USAGE = `Usage: dorkos agent <subcommand> [options]

Manage agents on the running DorkOS server.

Subcommands:
  list                              List every registered agent
  show <path-or-id>                 Show one agent by Mesh id or project path
  create --name <slug> --path <dir> Create a new agent
  update --path <dir> [fields]      Edit an agent's self-editable fields
  permissions <agent> [set|reset]   See or change what one agent may do

Options (all subcommands):
      --json   Print raw JSON instead of a table

create options:
      --name <slug>          Kebab-case agent name (required)
      --path <dir>           Project directory for the agent (required)
      --template <ref>       Template to scaffold from. DorkOS shows what it brings
                             (settings, programs, skills) and asks before using it
      --yes                  Don't ask before using a template (it still prints what it brings)
      --approval <token>     Retry a template creation a person approved in DorkOS
      --display-name <name>  Human-friendly name
      --description <text>   One-line description

update options (all optional; --path is required):
      --display-name <name>  Change the display name
      --description <text>   Change the description
      --color <hex>          Set the accent color (pass '' to clear)
      --icon <emoji>         Set the icon (pass '' to clear)

Examples:
  dorkos agent list
  dorkos agent list --json
  dorkos agent show dorkbot
  dorkos agent show ~/projects/app
  dorkos agent create --name my-bot --path ~/projects/my-bot
  dorkos agent update --path ~/.dork/agents/dorkbot --display-name "Dork Bot"`;

/** A Mesh agent entry as returned by `GET /api/mesh/agents`. */
interface MeshAgent {
  id: string;
  name: string;
  displayName?: string;
  runtime?: string;
  namespace?: string;
  healthStatus?: string;
}

/** Parsed arguments for `agent create`. */
export interface AgentCreateArgs {
  name: string;
  path: string;
  template?: string;
  displayName?: string;
  description?: string;
  json: boolean;
  /** Use a template without asking (what it brings is still printed). */
  yes?: boolean;
  /** Token from an earlier run that was waiting on a person (DOR-2325). */
  approvalToken?: string;
}

/** Parsed arguments for `agent update`. */
export interface AgentUpdateArgs {
  path: string;
  displayName?: string;
  description?: string;
  color?: string | null;
  icon?: string | null;
  json: boolean;
}

/**
 * A `<ref>` is treated as a filesystem path (not a Mesh id) when it contains a
 * path separator or starts with `.`, `~`, or `/` — Mesh ids (ULIDs and system
 * slugs like `dorkbot`) never do.
 *
 * @param ref - The `agent show` positional argument.
 * @returns True when `ref` should resolve via the path endpoint.
 */
function looksLikePath(ref: string): boolean {
  return ref.includes('/') || ref.startsWith('.') || ref.startsWith('~');
}

/** Extract the `--json` flag and return the remaining strict-parse. */
function jsonOf(values: Record<string, unknown>): boolean {
  return Boolean(values.json);
}

/**
 * Parse the argv slice after `dorkos agent create`.
 *
 * @param rawArgs - Argv after `create`.
 * @returns Typed {@link AgentCreateArgs}.
 */
export function parseAgentCreateArgs(rawArgs: string[]): AgentCreateArgs {
  const usage =
    'Usage: dorkos agent create --name <slug> --path <dir> [--template <ref> [--yes] [--approval <token>]]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        name: { type: 'string' },
        path: { type: 'string' },
        template: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        approval: { type: 'string' },
        'display-name': { type: 'string' },
        description: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'agent create', usage);
  }
  const { values } = parsed;
  const name = typeof values.name === 'string' ? values.name : undefined;
  const path = typeof values.path === 'string' ? values.path : undefined;
  if (!name) throw new Error(`Missing required --name.\n${usage}`);
  if (!path) throw new Error(`Missing required --path.\n${usage}`);
  return {
    name,
    path,
    template: typeof values.template === 'string' ? values.template : undefined,
    displayName: typeof values['display-name'] === 'string' ? values['display-name'] : undefined,
    description: typeof values.description === 'string' ? values.description : undefined,
    json: jsonOf(values),
    yes: values.yes === true,
    ...(typeof values.approval === 'string' && { approvalToken: values.approval }),
  };
}

/** What a template brings, as the server describes it (DOR-2325). */
interface TemplateBrings {
  source: string;
  contentHash: string;
  findings: { path: string; message: string }[];
  /** Each file under `findings`: its text (hidden characters already made visible), or why not. */
  settings?: {
    path: string;
    bytes: number;
    content?: string;
    omitted?: 'too-long' | 'not-text' | 'link';
  }[];
  disclosed: DisclosedEffects;
}

/**
 * One settings file, written out under its name. Every line carries a `│ `
 * gutter, so nothing in the file can pass itself off as this prompt's own text.
 */
function describeSettingsFile(file: NonNullable<TemplateBrings['settings']>[number]): string[] {
  if (file.content === undefined) {
    const why =
      file.omitted === 'link'
        ? 'is a link, which is not copied'
        : file.omitted === 'not-text'
          ? `is not text (${file.bytes} bytes)`
          : `is too long to show here (${file.bytes} bytes); read it in the template first`;
    return [`      ${file.path} ${why}`];
  }
  return [
    `      ${file.path} (${file.bytes} bytes):`,
    ...file.content.split('\n').map((line) => `      │ ${line}`),
  ];
}

/** The lines that say what a template brings into the new agent's folder. */
function describeTemplate(template: TemplateBrings): string[] {
  return [
    `The template ${template.source} brings:`,
    ...(template.findings.length > 0
      ? [
          ...template.findings.map((f) => `    ${f.path}: settings the new agent's sessions load`),
          ...(template.settings ?? []).flatMap(describeSettingsFile),
        ]
      : ["    no settings files for the new agent's sessions"]),
    ...renderDisclosureLines(template.disclosed, 'agent'),
  ];
}

/**
 * Parse the argv slice after `dorkos agent update`.
 *
 * `--color`/`--icon` accept an empty string to clear the field (the server
 * treats `null` as "clear"), so an explicitly-passed empty value maps to `null`.
 *
 * @param rawArgs - Argv after `update`.
 * @returns Typed {@link AgentUpdateArgs}.
 */
export function parseAgentUpdateArgs(rawArgs: string[]): AgentUpdateArgs {
  const usage =
    'Usage: dorkos agent update --path <dir> [--display-name <name>] [--description <text>] [--color <hex>] [--icon <emoji>]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        path: { type: 'string' },
        'display-name': { type: 'string' },
        description: { type: 'string' },
        color: { type: 'string' },
        icon: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'agent update', usage);
  }
  const { values } = parsed;
  const path = typeof values.path === 'string' ? values.path : undefined;
  if (!path) throw new Error(`Missing required --path.\n${usage}`);
  // Empty string clears the field (null); a non-empty string sets it.
  const clearable = (v: unknown): string | null | undefined =>
    typeof v === 'string' ? (v.length === 0 ? null : v) : undefined;
  return {
    path,
    displayName: typeof values['display-name'] === 'string' ? values['display-name'] : undefined,
    description: typeof values.description === 'string' ? values.description : undefined,
    color: clearable(values.color),
    icon: clearable(values.icon),
    json: jsonOf(values),
  };
}

/**
 * Implements `dorkos agent list`.
 *
 * @param json - When true, print the raw agents array as JSON.
 * @returns The intended process exit code.
 */
export async function runAgentList(json: boolean): Promise<number> {
  try {
    const { agents } = await apiCall<{ agents: MeshAgent[] }>('GET', '/api/mesh/agents');
    if (json) {
      printJson(agents);
      return 0;
    }
    if (agents.length === 0) {
      console.log('No agents registered.');
      return 0;
    }
    const rows = agents.map((a) => [
      a.displayName ?? a.name,
      a.id,
      a.runtime ?? '-',
      a.healthStatus ?? '-',
    ]);
    console.log(renderTable(['NAME', 'ID', 'RUNTIME', 'HEALTH'], rows));
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Implements `dorkos agent show <path-or-id>`.
 *
 * @param ref - A Mesh id (or system slug) or a filesystem path.
 * @param json - When true, print the raw agent object as JSON.
 * @returns The intended process exit code.
 */
export async function runAgentShow(ref: string, json: boolean): Promise<number> {
  const fromManifest = looksLikePath(ref);
  try {
    const agent = fromManifest
      ? await apiCall<unknown>('GET', `/api/agents/current?path=${encodeURIComponent(ref)}`)
      : await apiCall<unknown>('GET', `/api/mesh/agents/${encodeURIComponent(ref)}`);
    if (agent === null) {
      console.error(`Error: No agent found for '${ref}'.`);
      return 1;
    }
    if (json) {
      printJson(agent);
      return 0;
    }
    const a = agent as MeshAgent & { description?: string; projectPath?: string };
    const rows: Array<[string, string]> = [
      ['Name', a.displayName ?? a.name],
      ['Id', a.id],
      ['Runtime', a.runtime ?? '-'],
      ['Namespace', a.namespace ?? '-'],
      ['Health', a.healthStatus ?? '-'],
      ['Description', a.description ?? '-'],
    ];
    const width = Math.max(...rows.map((r) => r[0].length));
    console.log(rows.map(([k, v]) => `${k}${' '.repeat(width - k.length)}  ${v}`).join('\n'));
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Implements `dorkos agent create`.
 *
 * @param args - Parsed create arguments.
 * @returns The intended process exit code.
 */
export async function runAgentCreate(args: AgentCreateArgs): Promise<number> {
  const body: Record<string, unknown> = { name: args.name, directory: args.path };
  if (args.template) body.template = args.template;
  if (args.displayName) body.displayName = args.displayName;
  if (args.description) body.description = args.description;
  if (args.approvalToken) body.confirmationToken = args.approvalToken;
  try {
    let created: CreatedAgentBody | TemplateApprovalBody;
    try {
      created = await apiCall<CreatedAgentBody | TemplateApprovalBody>(
        'POST',
        '/api/agents/create',
        body
      );
    } catch (err) {
      // A person's own template that brings settings or programs is shown to
      // them first, and used once they say so (DOR-2325).
      const template =
        (err as ApiError).body?.code === 'template_needs_review'
          ? ((err as ApiError).body as unknown as { template: TemplateBrings }).template
          : undefined;
      if (!(err instanceof ApiError) || !template) throw err;
      for (const line of describeTemplate(template)) console.log(line);
      if (!args.yes && !(await confirm('Create the agent with these?'))) {
        console.log('Nothing was created.');
        return 1;
      }
      created = await apiCall<CreatedAgentBody>('POST', '/api/agents/create', {
        ...body,
        approvedTemplateHash: template.contentHash,
      });
    }
    // From an agent's session a template always waits for a person's card.
    if ('status' in created && created.status === 'requires_confirmation') {
      for (const line of describeTemplate(created.template)) console.error(line);
      console.error(created.message);
      console.error(
        `Retry with: dorkos agent create --name ${args.name} --path ${args.path} ` +
          `--template ${args.template} --approval ${created.confirmationToken}`
      );
      return 1;
    }
    const agent = created as CreatedAgentBody;
    if (args.json) {
      printJson(agent);
      return 0;
    }
    console.log(`Created agent ${agent.name} (${agent.id})`);
    if (agent._path) console.log(`  ${agent._path}`);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/** What `POST /api/agents/create` answers with when it created the agent. */
interface CreatedAgentBody {
  id: string;
  name: string;
  _path?: string;
}

/** What it answers with when a template waits on a person's card (DOR-2325). */
interface TemplateApprovalBody {
  status: 'requires_confirmation';
  confirmationToken: string;
  message: string;
  template: TemplateBrings;
}

/**
 * Implements `dorkos agent update`.
 *
 * @param args - Parsed update arguments.
 * @returns The intended process exit code.
 */
export async function runAgentUpdate(args: AgentUpdateArgs): Promise<number> {
  const body: Record<string, unknown> = {};
  if (args.displayName !== undefined) body.displayName = args.displayName;
  if (args.description !== undefined) body.description = args.description;
  if (args.color !== undefined) body.color = args.color;
  if (args.icon !== undefined) body.icon = args.icon;
  if (Object.keys(body).length === 0) {
    console.error('Error: nothing to update — pass at least one field to change.');
    return 1;
  }
  const selfEditUrl = `/api/agents/current?path=${encodeURIComponent(args.path)}`;
  try {
    const updated = await apiCall<{ id: string; name: string }>('PATCH', selfEditUrl, body);

    if (args.json) {
      printJson(updated);
      return 0;
    }
    console.log(`Updated agent ${updated.name}`);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Dispatch `dorkos agent <subcommand>`.
 *
 * @param rawArgs - Argv after `agent`.
 * @returns The intended process exit code.
 */
export async function runAgentDispatcher(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(AGENT_USAGE);
    return subcommand === undefined ? 1 : 0;
  }

  try {
    if (subcommand === 'list') {
      const { values } = parseArgs({
        args: rawArgs.slice(1),
        options: { json: { type: 'boolean', default: false } },
        allowPositionals: false,
        strict: true,
      });
      return await runAgentList(jsonOf(values));
    }
    if (subcommand === 'show') {
      const { values, positionals } = parseArgs({
        args: rawArgs.slice(1),
        options: { json: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      });
      const ref = positionals[0];
      if (!ref) {
        console.error(
          'Error: missing required <path-or-id>.\nUsage: dorkos agent show <path-or-id>'
        );
        return 1;
      }
      return await runAgentShow(ref, jsonOf(values));
    }
    if (subcommand === 'create') {
      return await runAgentCreate(parseAgentCreateArgs(rawArgs.slice(1)));
    }
    if (subcommand === 'update') {
      return await runAgentUpdate(parseAgentUpdateArgs(rawArgs.slice(1)));
    }
    if (subcommand === 'permissions') {
      const { runAgentPermissions } = await import('./permissions.js');
      return await runAgentPermissions(rawArgs.slice(1));
    }
  } catch (err) {
    printError(err);
    return 1;
  }

  console.error(`Unknown agent subcommand: ${subcommand}\n${AGENT_USAGE}`);
  return 1;
}
