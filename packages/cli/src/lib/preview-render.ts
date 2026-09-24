/**
 * Terminal renderer for the marketplace `PermissionPreview` payload.
 *
 * Mirrors the field shape declared in
 * `apps/server/src/services/marketplace/types.ts`. Kept structurally typed
 * (rather than importing the server type) so the CLI never pulls server
 * code into its bundle.
 *
 * @module lib/preview-render
 */
import {
  describeHookEvent,
  describeProgramLine,
  describeScheduleArrival,
  describeSchedulePermissionMode,
  PLUGIN_PROGRAMS_SCOPE_NOTE,
  revealHiddenCharacters,
  skillCommandKind,
} from '@dorkos/shared/marketplace-schemas';

/** A single planned filesystem mutation surfaced by the preview. */
export interface PreviewFileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
}

/** A single conflict report between an incoming package and the install set. */
export interface PreviewConflict {
  level: 'error' | 'warning';
  type: string;
  description: string;
  conflictingPackage?: string;
}

/** A shell hook the package registers with the harness. */
export interface PreviewHook {
  event: string;
  matcher?: string;
  command: string;
  /** The skill or command file whose frontmatter declares it, when it is one. */
  source?: string;
}

/** A shell command a skill's or command's text runs when it is used (DOR-2327). */
export interface PreviewSkillCommand {
  source: string;
  skill: string;
  form: 'inline' | 'block';
  command: string;
}

/** The tools a skill or command lets the agent use without asking. */
export interface PreviewSkillTools {
  source: string;
  skill: string;
  tools: string[];
}

/** A hook declaration the package ships that could not be read. */
export interface UnreadablePreviewHook {
  path: string;
  event?: string;
}

/** One npm library the install will fetch from the registry. */
export interface PreviewNpmDependency {
  name: string;
  range: string;
  /** True for an `optionalDependencies` entry — installed, but allowed to fail. */
  optional?: boolean;
}

/** An MCP server the package starts. */
export interface PreviewMcpServer {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
}

/** A language (LSP) server the package starts. */
export interface PreviewLspServer {
  name: string;
  command: string;
  args: string[];
}

/** A background monitor the package runs. */
export interface PreviewMonitor {
  name: string;
  command: string;
  when?: string;
}

/** A program declaration that could not be read, or points outside the package. */
export interface UnreadableDeclaration {
  path: string;
  kind: 'mcp-server' | 'lsp-server' | 'monitor';
  entry?: string;
}

/** A scheduled job the install will create, and what it may do unattended. */
export interface PreviewSchedule {
  name: string;
  cron: string | null;
  permissionMode: string;
  startsEnabled: boolean;
}

/**
 * The structural shape of a `PermissionPreview` as serialised over the
 * marketplace HTTP API. Matches `services/marketplace/types.ts` exactly.
 */
export interface PreviewPayload {
  fileChanges: PreviewFileChange[];
  extensions: { id: string; slots: string[] }[];
  hooks: PreviewHook[];
  unreadableHooks: UnreadablePreviewHook[];
  mcpServers: PreviewMcpServer[];
  lspServers: PreviewLspServer[];
  monitors: PreviewMonitor[];
  executables: string[];
  skillTools: PreviewSkillTools[];
  /** Absent from a server older than DOR-2327. */
  skillCommands?: PreviewSkillCommand[];
  unreadableDeclarations: UnreadableDeclaration[];
  skippedLinks: { path: string; message: string }[];
  npmDependencies: PreviewNpmDependency[];
  schedules: PreviewSchedule[];
  secrets: { key: string; required: boolean; description?: string }[];
  externalHosts: string[];
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  conflicts: PreviewConflict[];
}

/** ANSI escape sequences. Inlined to keep the helper dependency-free. */
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Render a {@link PreviewPayload} to a multi-line string suitable for
 * `console.log`. Empty sections are omitted entirely so the output stays
 * scannable. Conflicts are always rendered last and use ANSI colour to
 * distinguish errors (red) from warnings (yellow).
 *
 * @param packageName - The package name being previewed; used in the header.
 * @param version - Resolved package version.
 * @param preview - The preview payload to render.
 * @returns A formatted multi-line string with no trailing newline.
 */
export function renderPreview(
  packageName: string,
  version: string,
  preview: PreviewPayload
): string {
  const lines: string[] = [];

  lines.push(`Package: ${packageName}@${version}`);
  lines.push('');

  if (preview.fileChanges.length > 0) {
    lines.push('Files:');
    for (const change of preview.fileChanges) {
      lines.push(`  ${change.action.padEnd(7)} ${change.path}`);
    }
    lines.push('');
  }

  if (preview.extensions.length > 0) {
    lines.push('Extensions:');
    for (const ext of preview.extensions) {
      const slots = ext.slots.length > 0 ? ` [${ext.slots.join(', ')}]` : '';
      lines.push(`  ${ext.id}${slots}`);
    }
    lines.push('');
  }

  // Named before the commands section, because this is the one effect that
  // reaches the network — and it happens during the install itself, not later.
  // The heading says "and everything they depend on" because these are the
  // DECLARED libraries; one of them routinely pulls in dozens more.
  if (preview.npmDependencies.length > 0) {
    lines.push('npm libraries this install will download, and everything they depend on:');
    for (const dep of preview.npmDependencies) {
      lines.push(`  ${dep.name}@${dep.range}${dep.optional ? ' (optional)' : ''}`);
    }
    lines.push('');
  }

  // A server older than DOR-2327 sends no skillCommands.
  const skillCommands = preview.skillCommands ?? [];
  if (preview.hooks.length + skillCommands.length > 0) {
    lines.push('Commands this package declares:');
    for (const hook of preview.hooks) {
      const scope = hook.source ? `, while ${revealHiddenCharacters(hook.source)} is in use` : '';
      lines.push(`  Runs ${describeHookEvent(hook.event, hook.matcher)}${scope}`);
      lines.push(`    ${revealHiddenCharacters(hook.command)}`);
    }
    // Written into a skill's or command's text: run as it loads (DOR-2327).
    for (const entry of skillCommands) {
      lines.push(
        `  Runs when the ${skillCommandKind(entry.source)} ${revealHiddenCharacters(entry.skill)} is used (${revealHiddenCharacters(entry.source)})`
      );
      for (const line of revealHiddenCharacters(entry.command).split('\n'))
        lines.push(`    ${line}`);
    }
    lines.push('');
  }

  if (preview.unreadableHooks.length > 0) {
    lines.push(`${YELLOW}Commands we could not read:${RESET}`);
    for (const hook of preview.unreadableHooks) {
      const where = hook.event ? `${hook.path} (${hook.event})` : hook.path;
      lines.push(`  ${YELLOW}⚠ ${where}${RESET}`);
    }
    lines.push(
      `  ${DIM}This package declares commands to run, but they are written in a way DorkOS cannot read.${RESET}`
    );
    lines.push('');
  }

  const programs = [
    ...preview.mcpServers.map((server) => ({
      label: `MCP server ${server.name}`,
      runs: server.command
        ? describeProgramLine(server.command, server.args)
        : `connects to ${revealHiddenCharacters(JSON.stringify(server.url ?? ''))}`,
    })),
    ...preview.lspServers.map((server) => ({
      label: `Language server ${server.name}`,
      runs: describeProgramLine(server.command, server.args),
    })),
    ...preview.monitors.map((monitor) => ({
      label: `Background monitor ${monitor.name}${monitor.when ? ` (${monitor.when})` : ''}`,
      runs: revealHiddenCharacters(JSON.stringify(monitor.command)),
    })),
    ...preview.executables.map((name) => ({
      label: `Command on the agent's PATH`,
      runs: revealHiddenCharacters(JSON.stringify(name)),
    })),
  ];
  if (programs.length > 0) {
    lines.push('Programs this package starts on its own:');
    for (const program of programs) {
      lines.push(`  ${revealHiddenCharacters(program.label)}`);
      lines.push(`    ${program.runs}`);
    }
    lines.push(`  ${DIM}${PLUGIN_PROGRAMS_SCOPE_NOTE}${RESET}`);
    lines.push('');
  }

  if (preview.skillTools.length > 0) {
    lines.push('Tools a skill may use without asking you:');
    for (const entry of preview.skillTools) {
      lines.push(
        `  ${revealHiddenCharacters(entry.skill)} (${revealHiddenCharacters(entry.source)})`
      );
      lines.push(
        `    ${entry.tools.map((t) => revealHiddenCharacters(JSON.stringify(t))).join(', ')}`
      );
    }
    lines.push('');
  }

  if (preview.unreadableDeclarations.length > 0) {
    lines.push(`${YELLOW}Programs we could not read:${RESET}`);
    for (const declaration of preview.unreadableDeclarations) {
      const where = declaration.entry
        ? `${declaration.path} (${declaration.entry})`
        : declaration.path;
      lines.push(`  ${YELLOW}⚠ ${revealHiddenCharacters(where)}${RESET}`);
    }
    lines.push('');
  }

  if (preview.skippedLinks.length > 0) {
    lines.push(`${YELLOW}Shortcuts that won't be installed:${RESET}`);
    for (const link of preview.skippedLinks) {
      lines.push(`  ${YELLOW}⚠ ${revealHiddenCharacters(link.message)}${RESET}`);
    }
    lines.push('');
  }

  if (preview.schedules.length > 0) {
    lines.push('Scheduled jobs:');
    for (const schedule of preview.schedules) {
      const when = schedule.cron ? `runs on ${schedule.cron}` : 'runs only when you ask';
      // Never "starts on": nothing a package brings starts by itself, whatever
      // its `enabled` flag asked for. `describeScheduleArrival` holds the whole
      // of that reasoning, and is shared with the two screens in the app that
      // disclose the same fact — this line said the false thing precisely
      // because it was written separately from theirs (DOR-644).
      lines.push(`  ${schedule.name}: ${when}, ${describeScheduleArrival(schedule.startsEnabled)}`);
      lines.push(
        `    ${DIM}This job ${describeSchedulePermissionMode(schedule.permissionMode)}.${RESET}`
      );
    }
    lines.push('');
  }

  if (preview.secrets.length > 0) {
    lines.push('Secrets:');
    for (const secret of preview.secrets) {
      const required = secret.required ? ' (required)' : ' (optional)';
      const description = secret.description ? `${DIM} (${secret.description})${RESET}` : '';
      lines.push(`  ${secret.key}${required}${description}`);
    }
    lines.push('');
  }

  if (preview.externalHosts.length > 0) {
    lines.push('External hosts:');
    for (const host of preview.externalHosts) {
      lines.push(`  ${host}`);
    }
    lines.push('');
  }

  if (preview.requires.length > 0) {
    lines.push('Requires:');
    for (const dep of preview.requires) {
      const version = dep.version ? `@${dep.version}` : '';
      const status = dep.satisfied ? '✓' : '✗';
      lines.push(`  ${status} ${dep.type}/${dep.name}${version}`);
    }
    lines.push('');
  }

  if (preview.conflicts.length > 0) {
    lines.push('Conflicts:');
    for (const conflict of preview.conflicts) {
      const colour = conflict.level === 'error' ? RED : YELLOW;
      const symbol = conflict.level === 'error' ? '✗' : '⚠';
      const target = conflict.conflictingPackage ? ` (${conflict.conflictingPackage})` : '';
      lines.push(
        `  ${colour}${symbol} [${conflict.type}] ${conflict.description}${target}${RESET}`
      );
    }
    lines.push('');
  }

  // Drop the trailing blank line if the last section emitted one.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Whether the preview contains any error-level conflicts. Error-level
 * conflicts block install unless `--force` is supplied.
 *
 * @param preview - The preview payload to inspect.
 * @returns `true` when at least one conflict has `level: 'error'`.
 */
export function hasBlockingConflicts(preview: PreviewPayload): boolean {
  return preview.conflicts.some((c) => c.level === 'error');
}
