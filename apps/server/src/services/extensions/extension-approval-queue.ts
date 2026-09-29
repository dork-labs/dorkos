/**
 * The live list of installed extensions waiting for a person to let them run,
 * and the emitter that turns changes to it into Activity inbox rows (DOR-2517,
 * spec `flow-multiproject` §5.1).
 *
 * ## Why this exists
 *
 * An extension a person has not approved runs none of its code (DOR-516), and
 * until this module the only place that said so was its card in Settings →
 * Extensions. Installing a plugin that carries an extension therefore looked
 * like it had done nothing, and nothing told the person there was one click
 * left. Now each waiting extension raises one row in the Activity inbox, with
 * the same consent the card asks for.
 *
 * ## One rule for every way an extension comes to wait
 *
 * An extension is waiting when ALL of these hold:
 *
 * - it is `origin: 'user'` (DorkOS's own extensions never ask),
 * - it may not run ({@link mayRunExtensionCode} says no),
 * - it is not turned off, invalid or incompatible (someone who turned it off
 *   is not asked), and
 * - the person has not said "Not now" to this copy at this version
 *   ({@link isDismissedCopy}).
 *
 * That one rule covers a fresh install, an update that arrived from somewhere
 * else (the path-bound approval no longer matches), and an extension that was
 * enabled but never approved. An update from the SAME approved source keeps its
 * approval, so it never waits.
 *
 * ## Storage
 *
 * `extension.approval` is a `standing` kind: nothing is stored while it waits
 * (this module and the extension manager ARE the "is it still waiting?" store),
 * and one history row is written when the person answers — `approved` or
 * `dismissed`. A copy that simply vanished (uninstalled, turned off, became
 * invalid) writes nothing: nobody answered anything, so there is nothing to
 * record. Its escalation clock is disarmed and its arrival retired all the same.
 * A copy the person had put off ("Not now", or "Stop it") that they later turn
 * on from anywhere writes its own `approved` row, so the history never goes on
 * saying "off for now" about something that is on.
 *
 * ## Restarts
 *
 * The first pass after boot learns what is already waiting without announcing
 * it: those rows were announced when they began, the bell reads the list on
 * load, and a restart must not raise a fresh banner for every one of them.
 *
 * @module services/extensions/extension-approval-queue
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  extensionApprovalSubjectId,
  type PendingExtensionApproval,
} from '@dorkos/shared/extension-approval-schemas';
import { configManager } from '../core/config-manager.js';
import { expandTilde } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { readInstallMetadata } from '../marketplace/installed-metadata.js';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import { cancelEscalationByKey } from '../notifications/escalation-service.js';
import {
  notificationEntry,
  type NotificationPayload,
} from '../notifications/notification-registry.js';
import { resolveStanding } from '../notifications/notification-service.js';
import { broadcastStandingResolved, raiseStanding } from '../notifications/standing-events.js';
import type { ExtensionManager } from './extension-manager.js';
import type { ExtensionsConfig } from './extension-enable-resolution.js';
import {
  isDismissedCopy,
  mayRunExtensionCode,
  type ExtensionApprovals,
} from './extension-load-policy.js';

/** The longest the second line of an approval row may be. */
export const APPROVAL_WHY_MAX_LENGTH = 300;

/**
 * The longest a name (an extension's, a plugin's, a project's, a source's) may
 * be inside the row. The manifest and the folder names are written by whoever
 * wrote the extension, so the title and the fixed parts of the why line cap
 * them rather than trust them.
 */
export const APPROVAL_NAME_MAX_LENGTH = 60;

/** The one sentence every why line ends with. Never cut. */
const RUNS_AS_YOU = 'It runs as you.';

/** Statuses of an extension a person is not asked about. */
const NOT_ASKED_STATUSES = new Set(['disabled', 'invalid', 'incompatible']);

/** The part of the extension manager this module reads. */
export type ApprovalQueueSource = Pick<ExtensionManager, 'listRecords' | 'onChange' | 'dorkHome'>;

/**
 * A copy's facts with the one extra its history row needs: what it added, in
 * the past tense ("Flow tab added"). Kept off the wire shape. `path` is always
 * present here; only the agent-facing listing drops it.
 */
interface ApprovalFacts extends PendingExtensionApproval {
  path: string;
  added: string | null;
}

/**
 * When each copy was first seen waiting, keyed by its identity. In memory on
 * purpose: it only orders rows, and after a restart "first seen at boot" is as
 * honest an order as any. Pruned on every pass to the copies still waiting.
 */
const firstSeen = new Map<string, string>();

/**
 * Whether a person is being asked about this extension right now. Pure apart
 * from the stored config it is handed.
 *
 * @param record - The extension record.
 * @param extensions - `config.extensions`.
 */
export function isPendingApproval(
  record: ExtensionRecord,
  extensions: ExtensionApprovals & Pick<ExtensionsConfig, 'dismissedApprovals'>
): boolean {
  if (record.origin !== 'user') return false;
  if (NOT_ASKED_STATUSES.has(record.status)) return false;
  if (mayRunExtensionCode(record, extensions)) return false;
  return !isDismissedCopy(record, extensions);
}

/**
 * A copy the person put off: turned on by nobody, and declined ("Not now" or
 * "Stop it") at exactly this path, plugin and version.
 */
function isPutOff(
  record: ExtensionRecord,
  extensions: ExtensionApprovals & Pick<ExtensionsConfig, 'dismissedApprovals'>
): boolean {
  return (
    record.origin === 'user' &&
    !mayRunExtensionCode(record, extensions) &&
    isDismissedCopy(record, extensions)
  );
}

/**
 * Cut a name that came from the extension's side to a length a row can hold.
 *
 * @param text - The name.
 * @param max - The longest it may be.
 */
function capped(text: string, max = APPROVAL_NAME_MAX_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/**
 * Join phrases plainly: "a", "a and b", "a, b, and c".
 *
 * @param parts - The phrases, in order.
 */
function joinPlainly(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * What the manifest says the extension adds, as nouns ("Flow tab", "Flow
 * settings page"), or nothing when it does not say.
 *
 * The manifest's `contributions` map is informational — nothing enforces it —
 * but it is the only honest source there is, and a line that guessed would be
 * worse than no line.
 *
 * @param name - The extension's (capped) name.
 * @param record - The extension record.
 */
function contributedNouns(name: string, record: ExtensionRecord): string[] {
  const contributions = record.manifest.contributions ?? {};
  const nouns: string[] = [];
  if (contributions['right-panel']) nouns.push(`${name} tab`);
  if (contributions['settings.tabs']) nouns.push(`${name} settings page`);
  return nouns;
}

/**
 * How a copy came to be on this machine, as far as DorkOS can say.
 *
 * `installer` only when DorkOS's own installer recorded it: a plugin under
 * `{dorkHome}/plugins` with its install sidecar, or a project plugin the
 * installer entered in `{dorkHome}/marketplace/project-installs.json` (a
 * sidecar inside a project proves nothing — any file can be written there).
 * Everything else arrived some other way: a folder an agent wrote with
 * `create_extension`, or one somebody copied in by hand. DorkOS cannot tell
 * those apart, so the row says only that it was added, not who added it.
 */
type Provenance = { kind: 'installer'; from: string } | { kind: 'added'; place: string };

/**
 * The folder a project-scoped path belongs to, as a short name.
 *
 * @param projectRoot - The project folder.
 */
function projectName(projectRoot: string): string {
  return capped(path.basename(projectRoot) || projectRoot);
}

/**
 * Work out a copy's {@link Provenance}.
 *
 * @param record - The extension record.
 * @param dorkHome - DorkOS's data directory.
 */
async function provenanceOf(record: ExtensionRecord, dorkHome: string): Promise<Provenance> {
  const copyPath = path.resolve(record.path);
  // `<root>/.dork/extensions/<id>` for a project copy; `<root>/.dork/plugins/
  // <plugin>/.dork/extensions/<id>` for a project plugin's.
  const place =
    record.scope === 'local'
      ? projectName(path.resolve(copyPath, record.sourcePlugin ? '../../../../..' : '../../..'))
      : 'DorkOS';
  if (!record.sourcePlugin) return { kind: 'added', place };

  const installRoot = path.resolve(copyPath, '..', '..', '..');
  if (record.scope === 'local') {
    let recorded = false;
    try {
      const installs = await readProjectInstalls(dorkHome);
      recorded = installs.some((install) => path.resolve(install.installRoot) === installRoot);
    } catch {
      // An index that does not parse proves nothing either way.
    }
    if (!recorded) return { kind: 'added', place };
  }
  const metadata = await readInstallMetadata(installRoot);
  if (!metadata) return { kind: 'added', place };
  return {
    kind: 'installer',
    from: capped(metadata.sourceRepo ?? metadata.installedFrom ?? 'a folder on this computer', 80),
  };
}

/**
 * The second line of the row: how it got here, what it adds and why, and that
 * it runs as the person.
 *
 * The first and last sentences are DorkOS's own words. The middle comes from
 * the manifest, which the extension's author wrote, so it is the part that is
 * cut: the whole line stays within {@link APPROVAL_WHY_MAX_LENGTH} and always
 * ends "It runs as you."
 *
 * @param record - The extension record.
 * @param name - The extension's (capped) name.
 * @param nouns - What it adds, from {@link contributedNouns}.
 * @param provenance - How it got here.
 */
function whyLine(
  record: ExtensionRecord,
  name: string,
  nouns: readonly string[],
  provenance: Provenance
): string {
  const subject = record.sourcePlugin ? `the ${capped(record.sourcePlugin)} plugin` : name;
  const opening =
    provenance.kind === 'installer'
      ? `You installed ${subject} from ${provenance.from}.`
      : `${subject.charAt(0).toUpperCase()}${subject.slice(1)} was added to ${provenance.place}.`;

  const { purpose, description } = record.manifest;
  let middle = '';
  if (nouns.length > 0) {
    const what = joinPlainly(nouns.map((noun) => `a ${noun}`));
    const trimmedPurpose = purpose?.trim().replace(/\.+$/, '');
    middle = `This adds ${what}${trimmedPurpose ? ` that ${trimmedPurpose}` : ''}.`;
  } else if (description?.trim()) {
    const text = description.trim();
    middle = /[.!?]$/.test(text) ? text : `${text}.`;
  }

  const fixed = opening.length + RUNS_AS_YOU.length + 1;
  const room = APPROVAL_WHY_MAX_LENGTH - fixed - 1;
  if (middle.length > room) middle = room > 1 ? `${middle.slice(0, room - 1).trimEnd()}…` : '';
  return [opening, middle, RUNS_AS_YOU].filter(Boolean).join(' ');
}

/**
 * A path as a person would say it, with their home folder as `~`. Display only.
 *
 * @param target - An absolute path.
 */
function withTildeForHome(target: string): string {
  // `expandTilde('~')` is the one sanctioned read of the person's own home
  // folder (`lib/boundary.ts`); DorkOS's data directory is not what is meant.
  const home = expandTilde('~');
  const rel = path.relative(home, target);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel}`;
  return target;
}

/**
 * The mono source line: which plugin and where it came from, or where a copy
 * that did not come through the installer lives. Display only — never used to
 * decide trust.
 *
 * @param record - The extension record.
 * @param provenance - How it got here.
 */
function sourceLabelOf(record: ExtensionRecord, provenance: Provenance): string {
  if (record.sourcePlugin) {
    const from = provenance.kind === 'installer' ? provenance.from : 'not from the installer';
    return `${capped(record.sourcePlugin)} plugin · ${from}`;
  }
  return `added in ${withTildeForHome(path.resolve(record.path))}`;
}

/**
 * One copy's identity inside this module: its id, path, plugin and version.
 *
 * @param copy - The copy.
 */
function conditionKey(copy: {
  id: string;
  path: string;
  plugin: string | null;
  version: string;
}): string {
  return extensionApprovalSubjectId(copy);
}

/**
 * Describe one copy.
 *
 * @param record - The extension record.
 * @param dorkHome - DorkOS's data directory.
 */
async function describeCopy(record: ExtensionRecord, dorkHome: string): Promise<ApprovalFacts> {
  const name = capped(record.manifest.name);
  const nouns = contributedNouns(name, record);
  const provenance = await provenanceOf(record, dorkHome);
  const identity = {
    id: record.id,
    path: path.resolve(record.path),
    plugin: record.sourcePlugin ?? null,
    version: record.manifest.version,
  };
  const key = conditionKey(identity);
  let since = firstSeen.get(key);
  if (!since) {
    since = new Date().toISOString();
    firstSeen.set(key, since);
  }
  return {
    ...identity,
    name,
    sourceLabel: sourceLabelOf(record, provenance),
    runsInServer: record.hasServerEntry || record.hasDataProxy,
    adds: nouns.length > 0 ? `It adds ${joinPlainly(nouns.map((noun) => `a ${noun}`))}` : null,
    added: nouns.length > 0 ? `${joinPlainly(nouns)} added` : null,
    since,
    why: whyLine(record, name, nouns, provenance),
  };
}

/** Oldest first, then by id, so the order is stable. */
function byAge(a: ApprovalFacts, b: ApprovalFacts): number {
  return a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
}

/**
 * Every waiting copy, and every put-off copy, with their history facts.
 *
 * @param source - The extension manager.
 */
async function readCopies(
  source: ApprovalQueueSource
): Promise<{ pending: ApprovalFacts[]; putOff: ApprovalFacts[] }> {
  const extensions = configManager.get('extensions');
  const records = source.listRecords();
  const [pending, putOff] = await Promise.all([
    Promise.all(
      records
        .filter((record) => isPendingApproval(record, extensions))
        .map((record) => describeCopy(record, source.dorkHome))
    ),
    Promise.all(
      records
        .filter((record) => isPutOff(record, extensions))
        .map((record) => describeCopy(record, source.dorkHome))
    ),
  ]);
  // Only a copy still waiting needs its first sighting remembered.
  const waitingKeys = new Set(pending.map(conditionKey));
  for (const key of firstSeen.keys()) if (!waitingKeys.has(key)) firstSeen.delete(key);
  return { pending: pending.sort(byAge), putOff };
}

/**
 * Every installed extension waiting for a person to let it run, oldest first.
 * What `GET /api/extensions/pending-approvals` answers with.
 *
 * Async where the spec sketch is sync: the source line reads the carrying
 * plugin's install records from disk.
 *
 * @param source - The extension manager.
 * @param options - `forPerson: false` (an agent asking) leaves out every
 *   absolute path and home folder: the copy's `path`, and the location in a
 *   direct copy's source line.
 */
export async function listPendingExtensionApprovals(
  source: ApprovalQueueSource,
  options: { forPerson: boolean } = { forPerson: true }
): Promise<PendingExtensionApproval[]> {
  const { pending } = await readCopies(source);
  return pending.map(({ added: _added, path: copyPath, ...approval }) =>
    options.forPerson
      ? { ...approval, path: copyPath }
      : {
          ...approval,
          sourceLabel: approval.plugin ? approval.sourceLabel : 'added directly',
        }
  );
}

/**
 * The notification payload for one copy.
 *
 * @param facts - The copy.
 * @param answer - How the person answered, on the resolution edge only.
 */
function payloadOf(
  facts: ApprovalFacts,
  answer?: 'approved' | 'dismissed'
): NotificationPayload<'extension.approval'> {
  return {
    id: facts.id,
    name: facts.name,
    version: facts.version,
    path: facts.path,
    plugin: facts.plugin,
    sourceLabel: facts.sourceLabel,
    why: facts.why,
    runsInServer: facts.runsInServer,
    adds: facts.adds,
    added: facts.added,
    ...(answer ? { answer } : {}),
  };
}

/** How one waiting copy stopped waiting. */
type Ending = 'approved' | 'dismissed' | 'cancelled';

/**
 * Whether the record on disk is still exactly this copy.
 *
 * @param facts - The copy as it was seen.
 * @param current - The record with that id now, if any.
 */
function isSameCopy(
  facts: ApprovalFacts,
  current: ExtensionRecord | undefined
): current is ExtensionRecord {
  return (
    current !== undefined &&
    path.resolve(current.path) === facts.path &&
    (current.sourcePlugin ?? null) === facts.plugin &&
    current.manifest.version === facts.version
  );
}

/**
 * Why a copy that was waiting is not waiting any more.
 *
 * @param facts - The copy as it was while it waited.
 * @param current - The record with that id now, if any.
 */
function endingOf(facts: ApprovalFacts, current: ExtensionRecord | undefined): Ending {
  if (!isSameCopy(facts, current)) return 'cancelled';
  const extensions = configManager.get('extensions');
  if (mayRunExtensionCode(current, extensions)) return 'approved';
  if (isDismissedCopy(current, extensions)) return 'dismissed';
  return 'cancelled';
}

/**
 * Turns every change to the waiting set into its standing edges: a new copy
 * raises one `extension.approval`, a copy that left resolves it, and a put-off
 * copy that is turned on later records that it was.
 *
 * Diffs by copy identity (`id`, `path`, `plugin`, `version`), so a re-scan that
 * finds the same set says nothing twice, and a waiting copy that updates in
 * place is one condition ending and a new one starting.
 */
export class ExtensionApprovalQueue {
  private previous = new Map<string, ApprovalFacts>();
  private previousPutOff = new Map<string, ApprovalFacts>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly source: ApprovalQueueSource) {}

  /**
   * Re-read the waiting set and emit what changed. Runs one at a time, in call
   * order, so two quick changes cannot interleave their diffs. Never rejects.
   *
   * @param options - `announce: false` learns the current set without raising
   *   anything, for the first pass after a restart.
   */
  sync(options: { announce: boolean } = { announce: true }): Promise<void> {
    this.running = this.running.then(
      () => this.syncOnce(options.announce),
      () => this.syncOnce(options.announce)
    );
    return this.running;
  }

  /** The body of {@link sync}. */
  private async syncOnce(announce: boolean): Promise<void> {
    try {
      const { pending, putOff } = await readCopies(this.source);
      const next = new Map(pending.map((facts) => [conditionKey(facts), facts]));
      const nextPutOff = new Map(putOff.map((facts) => [conditionKey(facts), facts]));
      const records = new Map(this.source.listRecords().map((record) => [record.id, record]));

      for (const [key, facts] of this.previous) {
        if (next.has(key)) continue;
        this.end(facts, endingOf(facts, records.get(facts.id)));
      }
      // A copy the person put off, now turned on — from the inbox's history
      // row, or from Settings. Its question was already answered "not now", so
      // this is a second answer, and the history has to say so.
      for (const [key, facts] of this.previousPutOff) {
        if (nextPutOff.has(key) || next.has(key)) continue;
        if (endingOf(facts, records.get(facts.id)) === 'approved') this.end(facts, 'approved');
      }
      if (announce) {
        for (const [key, facts] of next) {
          if (this.previous.has(key)) continue;
          raiseStanding('extension.approval', payloadOf(facts));
        }
      }
      this.previous = next;
      this.previousPutOff = nextPutOff;
    } catch (err) {
      logger.warn('[Extensions] Could not update the extensions waiting for approval', err);
    }
  }

  /**
   * Resolve one copy's condition. An answer writes its history row; a copy that
   * vanished only disarms and retires, because nobody answered anything.
   */
  private end(facts: ApprovalFacts, ending: Ending): void {
    if (ending === 'cancelled') {
      const subjectKey = notificationEntry('extension.approval').dedupeKey(payloadOf(facts));
      cancelEscalationByKey(subjectKey);
      broadcastStandingResolved('extension.approval', subjectKey);
      return;
    }
    void resolveStanding('extension.approval', payloadOf(facts, ending), { outcome: ending });
  }
}

/**
 * Start the live source: learn the current waiting set without announcing it
 * (a restart is not news), then follow every change the extension manager
 * reports. Called once by the composition root.
 *
 * @param source - The extension manager.
 * @returns The queue and a function that stops following changes.
 */
export function startExtensionApprovalQueue(source: ApprovalQueueSource): {
  queue: ExtensionApprovalQueue;
  stop: () => void;
} {
  const queue = new ExtensionApprovalQueue(source);
  void queue.sync({ announce: false });
  const stop = source.onChange(() => {
    void queue.sync();
  });
  return { queue, stop };
}
