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
 *
 * @module services/extensions/extension-approval-queue
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { configManager } from '../core/config-manager.js';
import { expandTilde } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { readInstallMetadata } from '../marketplace/installed-metadata.js';
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

/** Statuses of an extension a person is not asked about. */
const NOT_ASKED_STATUSES = new Set(['disabled', 'invalid', 'incompatible']);

/** The part of the extension manager this module reads. */
export type ApprovalQueueSource = Pick<ExtensionManager, 'listRecords' | 'onChange'>;

/**
 * A waiting extension with the one extra fact its history row needs: what it
 * added, in the past tense ("Flow tab added"). Kept off the wire shape.
 */
interface PendingApprovalFacts extends PendingExtensionApproval {
  added: string | null;
}

/**
 * When each copy was first seen waiting, keyed by `id`, `path` and `version`.
 * In memory on purpose: it only orders rows, and after a restart "first seen at
 * boot" is as honest an order as any.
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
 * @param record - The extension record.
 */
function contributedNouns(record: ExtensionRecord): string[] {
  const contributions = record.manifest.contributions ?? {};
  const name = record.manifest.name;
  const nouns: string[] = [];
  if (contributions['right-panel']) nouns.push(`${name} tab`);
  if (contributions['settings.tabs']) nouns.push(`${name} settings page`);
  return nouns;
}

/**
 * The second line of the row: who installed it, what it adds and why, and
 * that it runs as the person. Built only from the manifest, and cut to
 * {@link APPROVAL_WHY_MAX_LENGTH}, so an extension cannot make it longer.
 *
 * @param record - The extension record.
 * @param nouns - What it adds, from {@link contributedNouns}.
 */
function whyLine(record: ExtensionRecord, nouns: readonly string[]): string {
  const { name, purpose, description } = record.manifest;
  const sentences = [
    record.sourcePlugin
      ? `You installed the ${record.sourcePlugin} plugin.`
      : `You installed ${name}.`,
  ];
  if (nouns.length > 0) {
    const what = joinPlainly(nouns.map((noun) => `a ${noun}`));
    const trimmedPurpose = purpose?.trim().replace(/\.+$/, '');
    sentences.push(`This adds ${what}${trimmedPurpose ? ` that ${trimmedPurpose}` : ''}.`);
  } else if (description?.trim()) {
    const text = description.trim();
    sentences.push(/[.!?]$/.test(text) ? text : `${text}.`);
  }
  sentences.push('It runs as you.');
  const line = sentences.join(' ');
  return line.length > APPROVAL_WHY_MAX_LENGTH
    ? `${line.slice(0, APPROVAL_WHY_MAX_LENGTH - 1).trimEnd()}…`
    : line;
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
 * The mono source line: which plugin and where it came from, or where a direct
 * install lives. Display only — never used to decide trust.
 *
 * @param record - The extension record.
 */
async function sourceLabelOf(record: ExtensionRecord): Promise<string> {
  if (!record.sourcePlugin) return `installed in ${withTildeForHome(path.resolve(record.path))}`;
  // `<root>/plugins/<plugin>/.dork/extensions/<id>` — the plugin's install root
  // is three levels up, where its install sidecar lives.
  const installRoot = path.resolve(record.path, '..', '..', '..');
  const metadata = await readInstallMetadata(installRoot);
  const from = metadata?.sourceRepo ?? metadata?.installedFrom ?? 'installed locally';
  return `${record.sourcePlugin} plugin · ${from}`;
}

/**
 * One copy's identity inside this module: its id, path and version. The
 * notification pipeline files the same condition under the registry's own
 * `dedupeKey`, built from the same three fields.
 *
 * @param approval - The waiting extension.
 */
function conditionKey(approval: Pick<PendingExtensionApproval, 'id' | 'path' | 'version'>): string {
  return `${approval.id}\u0000${approval.path}\u0000${approval.version}`;
}

/**
 * Describe one waiting extension.
 *
 * @param record - The extension record, already known to be waiting.
 */
async function describePending(record: ExtensionRecord): Promise<PendingApprovalFacts> {
  const nouns = contributedNouns(record);
  const resolvedPath = path.resolve(record.path);
  const key = conditionKey({ id: record.id, path: resolvedPath, version: record.manifest.version });
  let since = firstSeen.get(key);
  if (!since) {
    since = new Date().toISOString();
    firstSeen.set(key, since);
  }
  return {
    id: record.id,
    name: record.manifest.name,
    version: record.manifest.version,
    path: resolvedPath,
    plugin: record.sourcePlugin ?? null,
    sourceLabel: await sourceLabelOf(record),
    runsInServer: record.hasServerEntry || record.hasDataProxy,
    adds: nouns.length > 0 ? `It adds ${joinPlainly(nouns.map((noun) => `a ${noun}`))}` : null,
    added: nouns.length > 0 ? `${joinPlainly(nouns)} added` : null,
    since,
    why: whyLine(record, nouns),
  };
}

/**
 * Every waiting extension with its history facts, oldest first.
 *
 * @param source - The extension manager.
 */
async function listPendingFacts(source: ApprovalQueueSource): Promise<PendingApprovalFacts[]> {
  const extensions = configManager.get('extensions');
  const waiting = source.listRecords().filter((record) => isPendingApproval(record, extensions));
  const described = await Promise.all(waiting.map(describePending));
  return described.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}

/**
 * Every installed extension waiting for a person to let it run, oldest first.
 * What `GET /api/extensions/pending-approvals` answers with.
 *
 * Async where the spec sketch is sync: the source line reads the carrying
 * plugin's install sidecar from disk.
 *
 * @param source - The extension manager.
 */
export async function listPendingExtensionApprovals(
  source: ApprovalQueueSource
): Promise<PendingExtensionApproval[]> {
  const facts = await listPendingFacts(source);
  return facts.map(({ added: _added, ...approval }) => approval);
}

/**
 * The notification payload for one waiting extension.
 *
 * @param facts - The waiting extension.
 * @param answer - How the person answered, on the resolution edge only.
 */
function payloadOf(
  facts: PendingApprovalFacts,
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
 * Why a copy that was waiting is not waiting any more.
 *
 * @param facts - The copy as it was while it waited.
 * @param current - The record with that id now, if any.
 */
function endingOf(facts: PendingApprovalFacts, current: ExtensionRecord | undefined): Ending {
  if (!current) return 'cancelled';
  const extensions = configManager.get('extensions');
  const sameCopy =
    path.resolve(current.path) === facts.path && current.manifest.version === facts.version;
  if (!sameCopy) return 'cancelled';
  if (mayRunExtensionCode(current, extensions)) return 'approved';
  if (isDismissedCopy(current, extensions)) return 'dismissed';
  return 'cancelled';
}

/**
 * Turns every change to the waiting set into its standing edges: a new copy
 * raises one `extension.approval`, a copy that left resolves it.
 *
 * Diffs by copy identity (`id`, `path`, `version`), so a re-scan that finds the
 * same set says nothing twice, and a waiting copy that updates in place is one
 * condition ending and a new one starting.
 */
export class ExtensionApprovalQueue {
  private previous = new Map<string, PendingApprovalFacts>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly source: ApprovalQueueSource) {}

  /**
   * Re-read the waiting set and emit what changed. Runs one at a time, in call
   * order, so two quick changes cannot interleave their diffs. Never rejects.
   */
  sync(): Promise<void> {
    this.running = this.running.then(
      () => this.syncOnce(),
      () => this.syncOnce()
    );
    return this.running;
  }

  /** The body of {@link sync}. */
  private async syncOnce(): Promise<void> {
    try {
      const current = await listPendingFacts(this.source);
      const next = new Map(current.map((facts) => [conditionKey(facts), facts]));
      const records = new Map(this.source.listRecords().map((record) => [record.id, record]));

      for (const [key, facts] of this.previous) {
        if (next.has(key)) continue;
        this.end(facts, endingOf(facts, records.get(facts.id)));
      }
      for (const [key, facts] of next) {
        if (this.previous.has(key)) continue;
        raiseStanding('extension.approval', payloadOf(facts));
      }
      this.previous = next;
    } catch (err) {
      logger.warn('[Extensions] Could not update the extensions waiting for approval', err);
    }
  }

  /**
   * Resolve one copy's condition. An answer writes its history row; a copy that
   * vanished only disarms and retires, because nobody answered anything.
   */
  private end(facts: PendingApprovalFacts, ending: Ending): void {
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
 * Start the live source: emit the current waiting set, then follow every change
 * the extension manager reports. Called once by the composition root.
 *
 * @param source - The extension manager.
 * @returns The queue and a function that stops following changes.
 */
export function startExtensionApprovalQueue(source: ApprovalQueueSource): {
  queue: ExtensionApprovalQueue;
  stop: () => void;
} {
  const queue = new ExtensionApprovalQueue(source);
  const stop = source.onChange(() => {
    void queue.sync();
  });
  void queue.sync();
  return { queue, stop };
}
