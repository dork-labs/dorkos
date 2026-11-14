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
 * live from DorkOS's records through {@link setCalledAppAccessLookup}.
 *
 * `limits.memoryMb` is not part of the set: it bounds the extension rather
 * than granting it anything.
 *
 * Pure: callers pass the stored record.
 *
 * @module services/extensions/isolation/permission-coverage
 */
import { calledApps, isNetEntryCovered, type ExtensionManifest } from '@dorkos/extension-api';

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
  const withApps =
    apps.length > 0 ? { apps, ...(Object.keys(appAccess).length > 0 ? { appAccess } : {}) } : {};
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
 * @returns `true` when the approval covers the declared set.
 */
export function isCovered(
  declared: ApprovedPermissionSet,
  approved: ApprovedPermissionSet | undefined
): boolean {
  return addedSince(declared, approved) === null;
}

/**
 * What `declared` asks for that `approved` did not allow, or `null` when it
 * asks for nothing new.
 *
 * @param declared - What the extension declares now ({@link declaredSet}).
 * @param approved - What a person approved, or `undefined` for the full
 *   in-process set.
 */
export function addedSince(
  declared: ApprovedPermissionSet,
  approved: ApprovedPermissionSet | undefined
): PermissionSetAdditions | null {
  const approvedApps = approved?.apps ?? [];
  // New to the list, or sharing more with it than when the person said yes.
  const newApps = (declared.apps ?? []).filter(
    (id) =>
      !approvedApps.includes(id) ||
      !accessCovered(approved?.appAccess?.[id], declared.appAccess?.[id])
  );
  const apps = newApps.length > 0 ? { apps: newApps } : {};
  if (!approved || approved.runtime === 'in-process') {
    return newApps.length > 0 ? { net: [], run: [], agents: false, runtime: false, ...apps } : null;
  }
  if (declared.runtime === 'in-process') {
    return { net: [], run: [], agents: false, runtime: true, ...apps };
  }
  const net = declared.net.filter((entry) => !isNetEntryCovered(approved.net, entry));
  const run = declared.run.filter((entry) => !approved.run.includes(entry));
  const agents = declared.agents && !approved.agents;
  if (net.length === 0 && run.length === 0 && !agents && newApps.length === 0) return null;
  return { net, run, agents, runtime: false, ...apps };
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
    JSON.stringify(Object.entries(a.appAccess ?? {}).sort()) ===
      JSON.stringify(Object.entries(b.appAccess ?? {}).sort())
  );
}
