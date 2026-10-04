/**
 * What an extension can reach, as the lines every place that asks about it
 * shows (DOR-2686): the inbox row, the Settings card and the marketplace
 * install preview. One source, so a consent question is never worded two ways.
 *
 * Every line is one block of at most 15 words, the host and program names
 * aside: those are data, listed in full and never cut short.
 *
 * @module entities/extension/lib/permission-lines
 */
import type {
  ExtensionApprovalAdditions,
  ExtensionApprovalPermissions,
  PendingExtensionApproval,
} from '@dorkos/shared/extension-approval-schemas';
import { RUN_PROGRAM_NOT_FOUND, type ExtensionRecordPublic } from '@dorkos/extension-api';

/** One program an extension may start, as far as this surface knows it. */
export interface ExtensionPermissionProgram {
  /** The `allow.run` entry as written: a bare name or an absolute path. */
  name: string;
  /** Whether it was found on this computer. Absent where nobody looked (a package not installed yet). */
  found?: boolean;
  /** Why DorkOS refuses a file it found, in a plain sentence. */
  refusedReason?: string;
}

/** Where an extension runs and what it may reach, normalized across the three surfaces. */
export interface ExtensionPermissionView {
  /** `in-process`: inside DorkOS with full access. `subprocess`: limited to the lists. */
  runtime: 'in-process' | 'subprocess';
  /** Hosts it may connect to. */
  net: readonly string[];
  /** Programs it may start. */
  run: readonly ExtensionPermissionProgram[];
  /** Whether it may message agents and start chats. */
  agents: boolean;
  /** Whether it has screens. Absent where unknown. */
  hasPage?: boolean;
}

/** How a line reads: plain, what is new since the last yes, or a caution. */
export type ExtensionPermissionTone = 'plain' | 'new' | 'warning';

/** One line on the card. `items` are host or program names shown after `text`. */
export interface ExtensionPermissionLine {
  /** Stable key for the list. */
  key: string;
  /** The sentence, or the label before `items`. */
  text: string;
  /** Names listed after the label, in full. */
  items?: readonly string[];
  /** How it reads. */
  tone: ExtensionPermissionTone;
}

/**
 * Programs that can start any other program, so allowing one allows
 * everything. Compared by file name, case-insensitive, without `.exe`.
 */
const RUNS_ANYTHING = new Set([
  'sh',
  'bash',
  'zsh',
  'cmd',
  'powershell',
  'pwsh',
  'node',
  'python',
  'python3',
  'osascript',
  'env',
  'xargs',
]);

/**
 * Whether allowing this program allows any program: a shell or interpreter,
 * named bare (`bash`) or by path (`/bin/bash`, `C:\\…\\pwsh.exe`).
 *
 * @param name - The `allow.run` entry.
 */
export function runsAnyProgram(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return RUNS_ANYTHING.has(base.toLowerCase().replace(/\.exe$/, ''));
}

/**
 * The lines for one extension, in reading order: what is new since the last
 * yes first (a re-ask), then where it runs, then what it may reach.
 *
 * @param permissions - What it declares.
 * @param added - What its last approval did not cover, or `null`.
 */
export function extensionPermissionLines(
  permissions: ExtensionPermissionView,
  added?: ExtensionApprovalAdditions | null
): ExtensionPermissionLine[] {
  const lines: ExtensionPermissionLine[] = [];

  if (added) {
    if (added.runtime) {
      lines.push({
        key: 'added-runtime',
        text: 'Now wants to run inside DorkOS with full access.',
        tone: 'new',
      });
    }
    if (added.net.length > 0) {
      lines.push({
        key: 'added-net',
        text: 'Now also wants to connect to:',
        items: added.net,
        tone: 'new',
      });
    }
    if (added.run.length > 0) {
      lines.push({
        key: 'added-run',
        text: 'Now also wants to run:',
        items: added.run,
        tone: 'new',
      });
    }
    if (added.agents) {
      lines.push({
        key: 'added-agents',
        text: 'Now also wants to message your agents.',
        tone: 'new',
      });
    }
  }

  if (permissions.runtime === 'in-process') {
    lines.push({
      key: 'in-process',
      text: 'Runs inside DorkOS with full access to this computer.',
      tone: 'plain',
    });
    return lines;
  }

  lines.push({ key: 'separate', text: 'Runs separately from DorkOS.', tone: 'plain' });
  lines.push(
    permissions.net.length > 0
      ? { key: 'net', text: 'Can connect to:', items: permissions.net, tone: 'plain' }
      : { key: 'net', text: 'Can’t connect to the internet.', tone: 'plain' }
  );

  // A refused program never runs, so it is named only with why; a shell or
  // interpreter gets its own caution, because allowing it allows everything.
  const refused = permissions.run.filter((program) => program.refusedReason !== undefined);
  const allowed = permissions.run.filter((program) => program.refusedReason === undefined);
  const plainRun = allowed.filter((program) => !runsAnyProgram(program.name));
  if (plainRun.length > 0) {
    lines.push({
      key: 'run',
      text: 'Can run:',
      items: plainRun.map((program) => program.name),
      tone: 'plain',
    });
  }
  for (const program of allowed.filter((p) => runsAnyProgram(p.name))) {
    lines.push({
      key: `run-anything:${program.name}`,
      text: `Can run ${program.name}, which can run any program.`,
      tone: 'warning',
    });
  }
  for (const program of allowed.filter((p) => p.found === false)) {
    lines.push({
      key: `missing:${program.name}`,
      text: `${program.name} isn’t on this computer.`,
      tone: 'plain',
    });
  }
  for (const program of refused) {
    lines.push({
      key: `refused:${program.name}`,
      text: `${program.name} can’t be allowed: ${program.refusedReason}`,
      tone: 'warning',
    });
  }

  if (permissions.agents) {
    lines.push({ key: 'agents', text: 'Can message your agents and start chats.', tone: 'plain' });
  }
  if (permissions.hasPage) {
    lines.push({ key: 'page', text: 'Its screens run in DorkOS with your access.', tone: 'plain' });
  }
  return lines;
}

/**
 * The view for a waiting extension, or `null` when the server sent none (a
 * server one version behind), so the card adds nothing rather than guessing.
 *
 * @param approval - The waiting extension.
 */
export function permissionViewFromApproval(
  approval: Pick<PendingExtensionApproval, 'permissions'>
): ExtensionPermissionView | null {
  return approval.permissions ?? null;
}

/**
 * The view for an installed extension's card. `isolation: undefined` is a
 * server that never sends it, so the card adds nothing; `null` is an
 * extension that runs inside DorkOS.
 *
 * @param record - The extension record.
 */
export function permissionViewFromRecord(
  record: Pick<ExtensionRecordPublic, 'isolation' | 'bundleReady'>
): ExtensionPermissionView | null {
  if (record.isolation === undefined) return null;
  if (record.isolation === null) {
    return { runtime: 'in-process', net: [], run: [], agents: false };
  }
  return {
    runtime: 'subprocess',
    net: record.isolation.net,
    run: record.isolation.resolvedRun.map((program) => ({
      name: program.name,
      found: program.path !== null,
      ...(program.path === null && program.reason && program.reason !== RUN_PROGRAM_NOT_FOUND
        ? { refusedReason: program.reason }
        : {}),
    })),
    agents: record.isolation.agents,
    hasPage: record.bundleReady,
  };
}

/**
 * The permission set a card showed, as the approve request echoes it back
 * (`ApproveExtensionRequest.permissions`): the server refuses the yes as
 * stale when the extension declares anything else by the time it lands.
 * `undefined` when the card showed no set, so nothing is compared.
 *
 * @param view - What the card showed, or `null`.
 */
export function approvedSetOf(view: ExtensionPermissionView | null):
  | {
      runtime: ExtensionApprovalPermissions['runtime'];
      net: string[];
      run: string[];
      agents: boolean;
    }
  | undefined {
  if (!view) return undefined;
  return {
    runtime: view.runtime,
    net: [...view.net],
    run: view.run.map((program) => program.name),
    agents: view.agents,
  };
}
