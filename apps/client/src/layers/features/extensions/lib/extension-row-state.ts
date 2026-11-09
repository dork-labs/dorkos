/**
 * What one row in Settings → Extensions says at a glance, and the order the
 * rows sit in: which one (name), what it is for (one line), whether it needs
 * the person (one chip), and whether it is on (the switch, or Review).
 *
 * Pure functions only, so the sort, the chip and the search are tested
 * without drawing anything.
 *
 * @module features/extensions/lib/extension-row-state
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { isExtensionServerErrorCode } from '@dorkos/shared/extension-server-status';

/** Statuses of an extension that is not running because it is off. */
const OFF_STATUSES = new Set(['disabled', 'discovered']);

/** Why a row needs the person, if it does. */
export type ExtensionRowNeed =
  'screens-paused' | 'needs-ok' | 'not-working' | 'cant-load' | 'needs-newer';

/** What a row's chip says and how loud it is. */
export interface ExtensionRowChip {
  /** The words on the chip. */
  label: string;
  /** `warning` and `error` count as needing the person; `neutral` does not. */
  tone: 'warning' | 'error' | 'neutral';
}

/** Everything the closed row needs to draw itself. */
export interface ExtensionRowState {
  /** The highest-ranked need, or `null` for a healthy row. */
  need: ExtensionRowNeed | null;
  /** The one chip, or `null` when nothing needs saying. */
  chip: ExtensionRowChip | null;
  /** Whether the row sits under "Needs you". */
  needsYou: boolean;
  /** Its place among the rows that need the person: lower comes first. */
  rank: number;
  /**
   * `review` replaces the switch: the row can't run until the person looks,
   * and the switch never approves. `switch` otherwise.
   */
  trailing: 'review' | 'switch';
  /** Whether it is running (the switch's answer). */
  isOn: boolean;
}

/** The chip for each need. Both waiting cases say the same words. */
const NEED_CHIP: Record<ExtensionRowNeed, ExtensionRowChip> = {
  'screens-paused': { label: 'Needs your OK', tone: 'warning' },
  'needs-ok': { label: 'Needs your OK', tone: 'warning' },
  'not-working': { label: 'Not working', tone: 'error' },
  'cant-load': { label: 'Can’t load', tone: 'error' },
  'needs-newer': { label: 'Needs newer DorkOS', tone: 'neutral' },
};

/** The order needs sort in under "Needs you". */
const NEED_RANK: Record<ExtensionRowNeed, number> = {
  'screens-paused': 0,
  'needs-ok': 1,
  'not-working': 2,
  'cant-load': 3,
  'needs-newer': 5,
};

/**
 * Whether the extension is running, as its switch shows it.
 *
 * @param ext - The extension record.
 */
export function isExtensionOn(ext: Pick<ExtensionRecordPublic, 'status'>): boolean {
  return !OFF_STATUSES.has(ext.status) && ext.status !== 'incompatible' && ext.status !== 'invalid';
}

/**
 * Whether the extension is off because a person turned it off (the Off filter).
 *
 * @param ext - The extension record.
 */
export function isExtensionOff(ext: Pick<ExtensionRecordPublic, 'status'>): boolean {
  return OFF_STATUSES.has(ext.status);
}

/**
 * The one need that matters most for this extension, or `null`.
 *
 * @param ext - The extension record.
 */
export function extensionRowNeed(ext: ExtensionRecordPublic): ExtensionRowNeed | null {
  if (ext.status === 'invalid') return 'cant-load';
  // An installed extension a person has not allowed never runs, and its
  // switch is never the way in: the person reads the panel first.
  // One a person turned off is not asked about, the same rule the Activity
  // inbox follows; its row still offers Review instead of the switch.
  if (ext.origin === 'user' && ext.screensPaused === true && !isExtensionOff(ext)) {
    return 'screens-paused';
  }
  if (ext.origin === 'user' && !ext.approvedToRun && !isExtensionOff(ext)) return 'needs-ok';
  if (
    ext.status === 'compile_error' ||
    ext.status === 'activate_error' ||
    (ext.serverError !== undefined && isExtensionServerErrorCode(ext.serverError.code))
  ) {
    return 'not-working';
  }
  if (ext.status === 'incompatible') return 'needs-newer';
  return null;
}

/**
 * Whether turning this extension on would first need a person's OK: an
 * installed copy not allowed to run, or one whose screens are paused. Its
 * switch is never drawn, whether or not it is on.
 *
 * @param ext - The extension record.
 */
export function waitsForOk(ext: ExtensionRecordPublic): boolean {
  return ext.origin === 'user' && (!ext.approvedToRun || ext.screensPaused === true);
}

/**
 * What the closed row shows.
 *
 * @param ext - The extension record.
 */
export function extensionRowState(ext: ExtensionRecordPublic): ExtensionRowState {
  const need = extensionRowNeed(ext);
  const chip = need ? NEED_CHIP[need] : null;
  return {
    need,
    chip,
    needsYou: chip !== null && chip.tone !== 'neutral',
    rank: need ? NEED_RANK[need] : Number.POSITIVE_INFINITY,
    trailing:
      need === 'screens-paused' || need === 'needs-ok' || need === 'cant-load' || waitsForOk(ext)
        ? 'review'
        : 'switch',
    isOn: isExtensionOn(ext),
  };
}

/**
 * The first sentence of a description: up to and including the first `.`,
 * `!` or `?` that ends a sentence, or the whole text when there is none.
 *
 * @param text - A description.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^.*?[.!?](?=\s|$)/s.exec(trimmed);
  return (match ? match[0] : trimmed).replace(/\s+/g, ' ');
}

/**
 * The one line under the name: the manifest's `summary`, else the first
 * sentence of its description, else nothing.
 *
 * @param ext - The extension record.
 */
export function extensionPurpose(ext: Pick<ExtensionRecordPublic, 'manifest'>): string {
  const summary = ext.manifest.summary?.trim();
  if (summary) return summary;
  return ext.manifest.description ? firstSentence(ext.manifest.description) : '';
}

/** Case-insensitive, accent-insensitive A–Z on the name. */
function byName(a: ExtensionRecordPublic, b: ExtensionRecordPublic): number {
  return a.manifest.name.localeCompare(b.manifest.name, undefined, { sensitivity: 'base' });
}

/** The three parts of the list, each already in order. */
export interface ExtensionListSections {
  /** Rows that need the person: by need, then A–Z. Core ones included. */
  needsYou: ExtensionRecordPublic[];
  /** Installed rows that need nothing: A–Z, and never reordered by a switch. */
  everythingElse: ExtensionRecordPublic[];
  /** Rows that come with DorkOS and need nothing: A–Z, folded by default. */
  core: ExtensionRecordPublic[];
}

/**
 * Split and order the list.
 *
 * @param extensions - Every extension the server listed.
 */
export function sectionExtensions(
  extensions: readonly ExtensionRecordPublic[]
): ExtensionListSections {
  const needsYou: ExtensionRecordPublic[] = [];
  const everythingElse: ExtensionRecordPublic[] = [];
  const core: ExtensionRecordPublic[] = [];
  for (const ext of extensions) {
    if (extensionRowState(ext).needsYou) needsYou.push(ext);
    else if (ext.origin === 'core') core.push(ext);
    else everythingElse.push(ext);
  }
  needsYou.sort((a, b) => extensionRowState(a).rank - extensionRowState(b).rank || byName(a, b));
  everythingElse.sort(byName);
  core.sort(byName);
  return { needsYou, everythingElse, core };
}

/**
 * Whether the extension matches a search: its name, its one line, its
 * author, or the name or title of a tool it gives agents.
 *
 * @param ext - The extension record.
 * @param query - What the person typed. Blank matches everything.
 */
export function matchesExtensionSearch(ext: ExtensionRecordPublic, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    ext.manifest.name,
    extensionPurpose(ext),
    ext.manifest.author ?? '',
    ...(ext.tools ?? []).flatMap((tool) => [tool.name, tool.title]),
  ];
  return haystack.some((text) => text.toLocaleLowerCase().includes(needle));
}
