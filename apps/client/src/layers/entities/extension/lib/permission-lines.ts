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
import {
  BRIDGE_WRITES,
  BRIDGE_WRITES_NONE,
  bridgeWritesFor,
  type ExtensionApprovalAdditions,
  type ExtensionApprovalPermissions,
  type PendingExtensionApproval,
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
  /**
   * The other apps it calls (DOR-3293), with DorkOS's name for each and what
   * that app shares with it. Absent where unknown.
   */
  apps?: readonly ExtensionCalledApp[];
  /** What its screens can change through the bridge, as DorkOS's keys. Absent where unknown. */
  writes?: ExtensionApprovalPermissions['writes'];
  /**
   * Whether it has a server half (a server entry or a data proxy). `false`
   * means only screens, which run sealed off, so the card claims no "full
   * access". Absent where unknown: treated as having one, the wider claim.
   */
  hasServer?: boolean;
}

/** One other app an extension calls, as the server named it. */
export type ExtensionCalledApp = NonNullable<ExtensionApprovalPermissions['apps']>[number];

/** One app on the "It uses other apps:" line. */
export interface ExtensionCalledAppEntry {
  /** The app's id, for the list key. */
  id: string;
  /**
   * DorkOS's name for it, or, when it is not installed, its id as the asking
   * app wrote it: cut to the characters an id allows, and cut short.
   */
  name: string;
  /** Whether `name` is DorkOS's name for it (`false`: an id, drawn as one). */
  installed: boolean;
  /** What it lets this app do, e.g. "reads and changes". */
  detail: string;
  /** Whether it is new since the last yes. */
  isNew: boolean;
}

/** How a line reads: plain, what is new since the last yes, or a caution. */
export type ExtensionPermissionTone = 'plain' | 'new' | 'warning';

/**
 * One piece of a line: copy, or a name the extension's author chose (a host,
 * a program), which is drawn isolated so it cannot reorder the copy around it.
 */
export type ExtensionPermissionPart = string | { name: string };

/** One line on the card. `items` are host or program names shown after the parts. */
export interface ExtensionPermissionLine {
  /** Stable key for the list. */
  key: string;
  /** The sentence, or the label before `items`, with any name kept apart. */
  parts: readonly ExtensionPermissionPart[];
  /** Names listed after the label, in full. */
  items?: readonly string[];
  /** Other apps it calls, one per row under the label. */
  apps?: readonly ExtensionCalledAppEntry[];
  /** Plain rows under the label, one per thing. */
  rows?: readonly string[];
  /** How it reads. */
  tone: ExtensionPermissionTone;
}

/** What its last approval did not cover, per list (the `added` payload shape). */
export type ExtensionPermissionAdditions = ExtensionApprovalAdditions;

/** The permission set a card shows and an approval records, as plain lists. */
export interface ExtensionPermissionSet {
  runtime: ExtensionApprovalPermissions['runtime'];
  net: string[];
  run: string[];
  agents: boolean;
  /** The other apps it calls. */
  apps?: string[];
  /** What each of those apps shares with it. */
  appAccess?: Record<string, 'reads' | 'changes' | 'both'>;
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
 * A line's words as a person reads them, names included, items after.
 *
 * @param line - One line.
 */
export function permissionLineText(line: ExtensionPermissionLine): string {
  const body = line.parts.map((part) => (typeof part === 'string' ? part : part.name)).join('');
  if (line.apps) {
    return [body, ...line.apps.map((app) => `${app.name} · ${app.detail}`)].join(' ');
  }
  if (line.rows) return [body, ...line.rows].join(' ');
  return line.items ? `${body} ${line.items.join(', ')}` : body;
}

/** A line of copy only. */
function plain(key: string, text: string, tone: ExtensionPermissionTone = 'plain') {
  return { key, parts: [text], tone };
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
  added?: ExtensionPermissionAdditions | null
): ExtensionPermissionLine[] {
  const writes = screenWritesLine(permissions.writes);
  const apps = calledAppsLine(permissions.apps, added?.apps);
  return [...reachLines(permissions, added), ...(writes ? [writes] : []), ...(apps ? [apps] : [])];
}

/** The apps a card showed and what each shared, as the yes echoes them. */
function sharedOf(
  apps: readonly ExtensionCalledApp[]
): Pick<ExtensionPermissionSet, 'apps' | 'appAccess'> {
  const shared = apps.flatMap((app) => (app.access ? [[app.id, app.access] as const] : []));
  return {
    apps: apps.map((app) => app.id),
    ...(shared.length > 0 ? { appAccess: Object.fromEntries(shared) } : {}),
  };
}

/** The card's words for one write, from `BRIDGE_WRITES`. */
function wordsFor(write: (typeof BRIDGE_WRITES)[number]['key']): string {
  return BRIDGE_WRITES.find(({ key }) => key === write)?.words ?? write;
}

/**
 * "It can change:", one row per thing its screens can change through the
 * bridge, in DorkOS's words: never the app's own description of itself. An
 * app that can change nothing says "It can't change anything." rather than
 * dropping the block. Absent `writes` (unknown) draws no block.
 *
 * @param writes - What its screens can change.
 */
function screenWritesLine(
  writes: ExtensionPermissionView['writes']
): ExtensionPermissionLine | null {
  if (!writes) return null;
  return {
    key: 'writes',
    parts: ['It can change:'],
    tone: 'plain',
    // The words come from the same table the bridge gate enforces.
    rows: writes.length > 0 ? writes.map(wordsFor) : [BRIDGE_WRITES_NONE],
  };
}

/** How many characters of a missing app's id the card shows before cutting it short. */
const SHOWN_ID_LENGTH = 32;

/**
 * A missing app's id as the card draws it. The asking app chose this string,
 * so it keeps only the characters a manifest id allows and is cut short:
 * it can never pass for a name DorkOS vouches for.
 *
 * @param id - The id the asking app listed.
 */
function shownAppId(id: string): string {
  const kept = id.replace(/[^a-z0-9-]/g, '');
  return kept.length > SHOWN_ID_LENGTH ? `${kept.slice(0, SHOWN_ID_LENGTH)}…` : kept;
}

/** What each app shares, in the designer's words (DOR-3293). */
const ACCESS_WORDS = { reads: 'reads', changes: 'changes', both: 'reads and changes' } as const;

/**
 * "It uses other apps:", one row per app: DorkOS's name for it and what it
 * shares, from that app's own exports. An app that is not installed or not on
 * says this part won't work; one that shares nothing says the same.
 *
 * @param apps - The apps it calls.
 * @param added - The ids new since the last yes, marked New.
 */
function calledAppsLine(
  apps: readonly ExtensionCalledApp[] | undefined,
  added: readonly string[] | undefined
): ExtensionPermissionLine | null {
  if (!apps || apps.length === 0) return null;
  return {
    key: 'apps',
    parts: ['It uses other apps:'],
    tone: 'plain',
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name ?? shownAppId(app.id),
      installed: app.name !== null,
      detail:
        app.name === null
          ? 'not installed, so this part won’t work'
          : app.access === null
            ? 'shares nothing, so this part won’t work'
            : ACCESS_WORDS[app.access],
      isNew: added?.includes(app.id) ?? false,
    })),
  };
}

/** The lines for where it runs and what it may reach. */
function reachLines(
  permissions: ExtensionPermissionView,
  added?: ExtensionPermissionAdditions | null
): ExtensionPermissionLine[] {
  const lines: ExtensionPermissionLine[] = [];

  if (added) {
    if (added.runtime) {
      lines.push(plain('added-runtime', 'Now wants to run inside DorkOS with full access.', 'new'));
    }
    if (added.net.length > 0) {
      lines.push({
        key: 'added-net',
        parts: ['Now also wants to connect to:'],
        items: added.net,
        tone: 'new',
      });
    }
    if (added.run.length > 0) {
      lines.push({
        key: 'added-run',
        parts: ['Now also wants to run:'],
        items: added.run,
        tone: 'new',
      });
    }
    if (added.agents) {
      lines.push(plain('added-agents', 'Now also wants to message your agents.', 'new'));
    }
  }

  if (permissions.runtime === 'in-process') {
    // Screens run sealed off, with no access of their own (DOR-3293): what
    // they can do is the "It can change:" block, so screens alone add no line
    // here. A server half inside DorkOS has full access, and says so.
    if (permissions.hasServer !== false) {
      lines.push(plain('in-process', 'Runs inside DorkOS with full access to this computer.'));
    }
    return lines;
  }

  lines.push(plain('separate', 'Runs separately from DorkOS.'));
  lines.push(
    permissions.net.length > 0
      ? { key: 'net', parts: ['Can connect to:'], items: permissions.net, tone: 'plain' }
      : plain('net', 'Can’t connect to the internet.')
  );

  // A refused program never runs, so it is named only with why; a shell or
  // interpreter gets its own caution, because allowing it allows everything.
  const refused = permissions.run.filter((program) => program.refusedReason !== undefined);
  const allowed = permissions.run.filter((program) => program.refusedReason === undefined);
  const plainRun = allowed.filter((program) => !runsAnyProgram(program.name));
  if (plainRun.length > 0) {
    lines.push({
      key: 'run',
      parts: ['Can run:'],
      items: plainRun.map((program) => program.name),
      tone: 'plain',
    });
  }
  for (const program of allowed.filter((p) => runsAnyProgram(p.name))) {
    lines.push({
      key: `run-anything:${program.name}`,
      parts: ['Can run ', { name: program.name }, ', which can run any program.'],
      tone: 'warning',
    });
  }
  for (const program of allowed.filter((p) => p.found === false)) {
    lines.push({
      key: `missing:${program.name}`,
      parts: [{ name: program.name }, ' isn’t on this computer.'],
      tone: 'plain',
    });
  }
  for (const program of refused) {
    lines.push({
      key: `refused:${program.name}`,
      parts: [{ name: program.name }, ` can’t be allowed: ${program.refusedReason}`],
      tone: 'warning',
    });
  }

  if (permissions.agents) {
    lines.push(plain('agents', 'Can message your agents and start chats.'));
  }
  return lines;
}

/**
 * What a set asks for that an earlier one did not, compared on the app: the
 * set a person saw against the one an extension declares now, after their
 * yes was refused as stale. Exact entries, so a host written differently
 * counts as new (the server's coverage check is the one that decides).
 *
 * @param seen - The set the person was shown.
 * @param now - What it declares now.
 * @returns What is new, or `null` when nothing is.
 */
export function permissionsAddedSince(
  seen: ExtensionPermissionSet,
  now: ExtensionPermissionSet
): ExtensionPermissionAdditions | null {
  const added = {
    net: now.net.filter((host) => !seen.net.includes(host)),
    run: now.run.filter((name) => !seen.run.includes(name)),
    agents: now.agents && !seen.agents,
    runtime: now.runtime === 'in-process' && seen.runtime === 'subprocess',
  };
  const apps = (now.apps ?? []).filter((id) => !(seen.apps ?? []).includes(id));
  if (apps.length > 0) return { ...added, apps };
  return added.net.length > 0 || added.run.length > 0 || added.agents || added.runtime
    ? added
    : null;
}

/**
 * The view for a waiting extension, or `null` when the server sent none (a
 * server one version behind), so the card adds nothing rather than guessing.
 *
 * @param approval - The waiting extension.
 */
export function permissionViewFromApproval(
  approval: Pick<PendingExtensionApproval, 'permissions' | 'runsInServer'>
): ExtensionPermissionView | null {
  return approval.permissions
    ? { ...approval.permissions, hasServer: approval.runsInServer }
    : null;
}

/**
 * What an installed app's screens can change, by the rule the approval queue
 * uses: the table's writes when it has screens, nothing at all when it has
 * neither screens nor a server part, and unknown otherwise (a server part's
 * reach has its own lines).
 */
function recordWrites(
  record: Pick<
    ExtensionRecordPublic,
    'bundleReady' | 'hasServerEntry' | 'hasDataProxy' | 'manifest'
  >
): Pick<ExtensionPermissionView, 'writes'> {
  if (record.bundleReady) return { writes: bridgeWritesFor(record.manifest) };
  return record.hasServerEntry || record.hasDataProxy ? {} : { writes: [] };
}

/**
 * The view for an installed extension's card. `isolation: undefined` is a
 * server that never sends it, so the card adds nothing; `null` is an
 * extension that runs inside DorkOS.
 *
 * @param record - The extension record.
 */
export function permissionViewFromRecord(
  record: Pick<
    ExtensionRecordPublic,
    'isolation' | 'bundleReady' | 'hasServerEntry' | 'hasDataProxy' | 'manifest'
  >
): ExtensionPermissionView | null {
  if (record.isolation === undefined) return null;
  if (record.isolation === null) {
    return {
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasServer: record.hasServerEntry || record.hasDataProxy,
      ...recordWrites(record),
    };
  }
  return {
    ...recordWrites(record),
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
export function approvedSetOf(
  view: ExtensionPermissionView | null
): ExtensionPermissionSet | undefined {
  if (!view) return undefined;
  return {
    runtime: view.runtime,
    net: [...view.net],
    run: view.run.map((program) => program.name),
    agents: view.agents,
    ...(view.apps && view.apps.length > 0 ? sharedOf(view.apps) : {}),
  };
}
