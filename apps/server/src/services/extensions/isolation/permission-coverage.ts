/**
 * Whether the permission set an extension declares now is covered by the one
 * a person approved (DOR-2686, spec `isolated-extension-backends` §2, D6).
 *
 * ## Why an approval has to name a set
 *
 * An approval is bound to one copy of an extension (its path, plugin, trusted
 * origin or dev link), not to its contents: an update from the same approved
 * source, or an edit to an approved folder, keeps running with nothing to
 * click. That was a sound trade while every extension ran inside DorkOS with
 * full access, because no edit could ask for more than everything. An
 * extension that runs separately declares what it may reach, and the person
 * reads those lists on the card. Without this check the next version could add
 * a host, a program or agent access and keep running on a yes given to less.
 *
 * So each approval also records the declared set it was given for
 * (`extensions.approvedPermissions[id]`), and an extension runs only while
 * what it declares now fits inside that record. Narrowing never asks.
 * Widening waits for a person, which the approval queue turns into an inbox
 * row on its own, because it keys on {@link mayRunExtensionCode}.
 *
 * ## The order of sets
 *
 * - `in-process` is full access, so an approved `in-process` set covers every
 *   declared set, and a missing entry (every approval given before this
 *   existed) counts as `in-process`.
 * - A declared `in-process` set needs an approved `in-process` one: moving an
 *   extension back inside DorkOS asks again.
 * - Between two `subprocess` sets: every declared `allow.net` entry must be
 *   covered by an approved entry (same host and port, an approved entry with
 *   no port, or an approved wildcard above it — `isNetEntryCovered`), every
 *   declared `allow.run` entry must be approved by exactly the same name, and
 *   agent access must not be newly asked for.
 *
 * The apps it calls (`capabilities.http.apps`, DOR-3293) sit beside all of
 * that, whatever the runtime: full access to this computer is not a yes to
 * reach another app's routes, so a newly listed app asks again even under an
 * `in-process` approval, and a missing entry approved none. So does an app
 * whose target now shares more with it than when the person said yes
 * (`appAccess`): a target that starts sharing a route, or starts letting it
 * change things, is treated like a new target. The targets' sharing is read
 * live from DorkOS's records through {@link setCalledAppAccessLookup}. And so
 * does an app it starts opening the pages of (`appOpens`, `navigate: true`).
 *
 * The places it shows in (`contributions`, DOR-4282) sit beside those too,
 * whatever the runtime: DorkOS shows an app only in the places its card
 * named, so a newly declared place asks again. An approval recorded before
 * places were (no `slots`) covers only {@link legacyApprovedSlots}: the two
 * places the card named then. No stored approval carries card text today, so
 * a page and every other place it declares asks once.
 *
 * A new place does not stop the app, though: when new places are ALL a copy
 * adds ({@link addsOnlyPlaces}), it keeps running with what its approval
 * covered, and each new place stays off until a person allows it
 * (`place-grace.ts`, {@link isCoveredApartFromPlaces}). Anything else new
 * stops the whole app, as before.
 *
 * `limits.memoryMb` is not part of the set: it bounds the extension rather
 * than granting it anything.
 *
 * Pure: callers pass the stored record.
 *
 * @module services/extensions/isolation/permission-coverage
 */
import {
  calledApps,
  declaredContributions,
  isNetEntryCovered,
  openableApps,
  type ExtensionManifest,
} from '@dorkos/extension-api';

/** What a target shares with a caller: `reads`, `changes`, `both`, or nothing. */
export type CalledAppAccess = 'reads' | 'changes' | 'both';

/** How a caller's targets are looked up: what one target shares with it now, or `null`. */
export type CalledAppAccessLookup = (callerId: string, targetId: string) => CalledAppAccess | null;

let accessLookup: CalledAppAccessLookup = () => null;

/**
 * Tell coverage how to read what each target shares now. The extension
 * manager's records answer, once, at startup; until then (and in a test that
 * sets none) nothing is shared.
 *
 * @param lookup - The live lookup.
 */
export function setCalledAppAccessLookup(lookup: CalledAppAccessLookup): void {
  accessLookup = lookup;
}

/** Whether `now` asks for no more than `approved` allowed. */
function accessCovered(approved: CalledAppAccess | undefined, now: CalledAppAccess | undefined) {
  if (!now) return true;
  if (!approved) return false;
  return approved === 'both' || approved === now;
}
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';

export type { ApprovedPermissionSet };

/** What is new in a declared set since the approved one, as the re-ask card leads with it. */
export interface PermissionSetAdditions {
  /** Declared `allow.net` entries the approval does not cover. */
  net: string[];
  /** Declared `allow.run` entries the approval does not name. */
  run: string[];
  /** Whether agent access is newly asked for. */
  agents: boolean;
  /** Whether it now asks to run inside DorkOS, with full access. */
  runtime: boolean;
  /** Apps it now calls that its approval did not name. Absent when none are new. */
  apps?: string[];
  /** Places it now declares that its approval did not cover. Absent when none are new. */
  slots?: string[];
}

/**
 * The places an approval with no recorded `slots` covers: the two its card
 * named before DOR-4282 ("a Flow tab", "a Flow settings page"). Anything else
 * such an app declares was never on a card, so it asks once.
 *
 * Source of the pair: before DOR-4282 the card's "This adds …" line came from
 * `contributedNouns` in `services/extensions/extension-approval-queue.ts`
 * (read by `whyLine` there), which named only `right-panel` ("<name> tab")
 * and `settings.tabs` ("<name> settings page") and nothing else.
 */
export const LEGACY_APPROVED_SLOTS: readonly string[] = ['right-panel', 'settings.tabs'];

/** Words that turn a sentence around, so it is never read as a yes to a page. */
const NEGATING_WORDS = /\b(?:no|not|never|none|nor|without|neither|cannot)\b|n['’]t\b/i;

/** The one phrasing that says it adds a page: "This adds a page" or "It adds a page". */
const ADDS_A_PAGE = /^(?:this|it) adds a page(?:$| and\b| that\b|,)/i;

/**
 * Whether card text saved with an approval when it was granted says the app
 * adds a page of its own. Only the exact phrasing DorkOS's own card uses
 * counts, at the start of a sentence ("This adds a page and …"), and only in
 * text with no negating word anywhere in it: a bare "page", "a Flow settings
 * page", "no page" and "doesn't add a page" never do. Anything unclear reads
 * as no.
 *
 * @param text - Card text stored with the approval, never the manifest now.
 */
export function cardTextAddsAPage(text: string | undefined): boolean {
  if (!text || NEGATING_WORDS.test(text)) return false;
  return text
    .split(/[.!?;\n]+/)
    .map((sentence) => sentence.trim())
    .some((sentence) => ADDS_A_PAGE.test(sentence));
}

/**
 * The places an approval with no recorded `slots` covers: the two
 * {@link LEGACY_APPROVED_SLOTS}. Never ⌘K, dialogs, the status bar or any
 * other place.
 *
 * No stored approval carries card text today. An approval records its copy
 * (`approvedSources`) and its permission set (`approvedPermissions`), and
 * neither has ever held words from the card. So every caller passes nothing,
 * the answer is always the two legacy places, and `pages` asks once.
 *
 * The parameter exists only for an approval that would one day store its
 * card text: then `pages` counts too when that text says it adds a page
 * ({@link cardTextAddsAPage}). It must be text saved at the yes; reading the
 * manifest or its description now would let an update grant itself a page.
 *
 * @param storedCardText - Card text saved with the approval when granted.
 *   No stored approval has any today, so callers pass nothing.
 */
export function legacyApprovedSlots(storedCardText?: string): readonly string[] {
  return cardTextAddsAPage(storedCardText)
    ? [...LEGACY_APPROVED_SLOTS, 'pages']
    : LEGACY_APPROVED_SLOTS;
}

/**
 * The permission set a manifest declares now. An extension that runs inside
 * DorkOS declares `{ runtime: 'in-process' }` with empty lists, which stands
 * for full access.
 *
 * @param manifest - The parsed `extension.json`.
 */
export function declaredSet(manifest: ExtensionManifest): ApprovedPermissionSet {
  const caps = manifest.serverCapabilities;
  const apps = calledApps(manifest);
  const appAccess = Object.fromEntries(
    apps.flatMap((id) => {
      const access = accessLookup(manifest.id, id);
      return access ? [[id, access] as const] : [];
    })
  );
  const appOpens = openableApps(manifest);
  const slots = [...declaredContributions(manifest)].sort();
  const withApps = {
    ...(apps.length > 0
      ? {
          apps,
          ...(Object.keys(appAccess).length > 0 ? { appAccess } : {}),
          ...(appOpens.length > 0 ? { appOpens } : {}),
        }
      : {}),
    // Always recorded, even empty: a set without it is an approval from
    // before places were, which covers only the two its card named.
    slots,
  };
  if (caps?.runtime !== 'subprocess') {
    return { runtime: 'in-process', net: [], run: [], agents: false, ...withApps };
  }
  return {
    runtime: 'subprocess',
    net: [...(caps.allow?.net ?? [])],
    run: [...(caps.allow?.run ?? [])],
    agents: caps.allow?.agents ?? false,
    ...withApps,
  };
}

/**
 * Whether `declared` asks for nothing `approved` did not already allow.
 *
 * @param declared - What the extension declares now ({@link declaredSet}).
 * @param approved - What a person approved, or `undefined` for an approval
 *   that recorded no set (the full in-process set).
 * @param storedCardText - Card text saved with an approval that recorded no
 *   `slots` ({@link addedSince}).
 * @returns `true` when the approval covers the declared set.
 */
export function isCovered(
  declared: ApprovedPermissionSet,
  approved: ApprovedPermissionSet | undefined,
  storedCardText?: string
): boolean {
  return addedSince(declared, approved, storedCardText) === null;
}

/**
 * What `declared` asks for that `approved` did not allow, or `null` when it
 * asks for nothing new.
 *
 * @param declared - What the extension declares now ({@link declaredSet}).
 * @param approved - What a person approved, or `undefined` for the full
 *   in-process set.
 * @param storedCardText - Card text saved with an approval that recorded no
 *   `slots`, when granted ({@link legacyApprovedSlots}). Ignored for one that
 *   recorded `slots`.
 */
export function addedSince(
  declared: ApprovedPermissionSet,
  approved: ApprovedPermissionSet | undefined,
  storedCardText?: string
): PermissionSetAdditions | null {
  const approvedApps = approved?.apps ?? [];
  // New to the list, sharing more with it than when the person said yes, or
  // newly opened.
  const newApps = (declared.apps ?? []).filter(
    (id) =>
      !approvedApps.includes(id) ||
      !accessCovered(approved?.appAccess?.[id], declared.appAccess?.[id]) ||
      ((declared.appOpens ?? []).includes(id) && !(approved?.appOpens ?? []).includes(id))
  );
  // An approval that records its places never reads text (DOR-4282).
  const approvedSlots = approved?.slots ?? legacyApprovedSlots(storedCardText);
  const newSlots = (declared.slots ?? []).filter((key) => !approvedSlots.includes(key));
  const apps = {
    ...(newApps.length > 0 ? { apps: newApps } : {}),
    ...(newSlots.length > 0 ? { slots: newSlots } : {}),
  };
  const anyNew = newApps.length > 0 || newSlots.length > 0;
  if (!approved || approved.runtime === 'in-process') {
    return anyNew ? { net: [], run: [], agents: false, runtime: false, ...apps } : null;
  }
  if (declared.runtime === 'in-process') {
    return { net: [], run: [], agents: false, runtime: true, ...apps };
  }
  const net = declared.net.filter((entry) => !isNetEntryCovered(approved.net, entry));
  const run = declared.run.filter((entry) => !approved.run.includes(entry));
  const agents = declared.agents && !approved.agents;
  if (net.length === 0 && run.length === 0 && !agents && !anyNew) return null;
  return { net, run, agents, runtime: false, ...apps };
}

/**
 * Whether new places are the ONLY thing a copy asks for beyond its approval
 * (DOR-4282). Fail-closed: every other field must read as "nothing new"
 * (`false`, an empty list, or absent), so a field added to
 * {@link PermissionSetAdditions} later stops the whole app until this says
 * otherwise.
 *
 * @param added - What {@link addedSince} found.
 */
export function addsOnlyPlaces(added: PermissionSetAdditions): boolean {
  const { slots, ...rest } = added;
  if ((slots ?? []).length === 0) return false;
  return Object.values(rest).every(
    (value) =>
      value === undefined || value === false || (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Whether `approved` covers everything `declared` asks for apart from new
 * places: what decides whether the app's code may run at all (DOR-4282). New
 * places alone never stop it; each stays off on its own until allowed.
 *
 * @param declared - What the extension declares now ({@link declaredSet}).
 * @param approved - What a person approved, or `undefined` for the full
 *   in-process set.
 * @param storedCardText - As for {@link addedSince}.
 */
export function isCoveredApartFromPlaces(
  declared: ApprovedPermissionSet,
  approved: ApprovedPermissionSet | undefined,
  storedCardText?: string
): boolean {
  const added = addedSince(declared, approved, storedCardText);
  return added === null || addsOnlyPlaces(added);
}

/**
 * Whether two sets are the same set, so an approval that already records
 * exactly what is declared need not be written again.
 *
 * @param a - One set.
 * @param b - The other, or `undefined`.
 */
export function isSamePermissionSet(
  a: ApprovedPermissionSet,
  b: ApprovedPermissionSet | undefined
): boolean {
  if (!b) return false;
  const sameList = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && [...x].sort().every((value, i) => value === [...y].sort()[i]);
  return (
    a.runtime === b.runtime &&
    a.agents === b.agents &&
    sameList(a.net, b.net) &&
    sameList(a.run, b.run) &&
    sameList(a.apps ?? [], b.apps ?? []) &&
    sameList(a.appOpens ?? [], b.appOpens ?? []) &&
    // A stored set with no `slots` is recorded again, so it gains them.
    (a.slots !== undefined) === (b.slots !== undefined) &&
    sameList(a.slots ?? [], b.slots ?? []) &&
    JSON.stringify(Object.entries(a.appAccess ?? {}).sort()) ===
      JSON.stringify(Object.entries(b.appAccess ?? {}).sort())
  );
}
